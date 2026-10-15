/**
 * طبقة أمان المطر. مستقلة عن الذكاء الاصطناعي وعن القرارات التي تُتخذ على ESP32 #2.
 *
 * أي إشارة مطر — POST /api/rain-event (فورية) أو rain_detected داخل القراءات اللحظية
 * (كل ~2 ثانية) — تمر عبر applyRainSignal(). وفي معاملة واحدة، مع قفل صف system_state، تقوم بـ:
 *   1. نقل النظام إلى RAIN_LOCKOUT،
 *   2. إلغاء أوامر التشغيل اليدوي المنتظرة،
 *   3. تسجيل الأحداث (وتأكيد قرارات التأجيل التي أثبت المطر صحتها).
 * ترى ESP32 #2 القيمة rain_lockout=true في استطلاعها التالي (خلال ثانية أو أقل) فتوقف المضخة،
 * ومحرك القرار الخاص بها يوقف أيضًا كل المناطق (HOLD) لأن rain_detected تساوي true.
 * يستدعيها: deviceController و readingsService (إشارات المطر)، و scheduler (tickCooldown).
 */
const { tx } = require('../database/pool');
const m = require('../models');
const { step } = require('./rainLockout');
const live = require('./liveService');
const { config } = require('../config');
const logger = require('../config/logger');

/**
 * تطبيق إشارة مطر (rainDetected = true/false) على حالة النظام.
 * المنطق نفسه في آلة الحالات النقية rainLockout.step()؛ وهذه الدالة تحفظ النتيجة في قاعدة البيانات.
 */
async function applyRainSignal({ rainDetected, deviceId, source, rainLevel = null }) {
  const out = await tx(async (db) => {
    const state = await m.getState(db, { forUpdate: true });
    const run = await m.activeRun(db);
    const now = new Date().toISOString();

    // في حالة ERROR: إشارة «جاف» لا تغيّر شيئًا (يبقى العطل)، أما المطر فيقفل النظام رغم العطل.
    if (state.mode === 'ERROR' && !rainDetected) return { changed: false, mode: state.mode };
    // وجود تشغيل نشط يعني أن النظام يروي فعلًا، حتى لو اختلف الوضع المحفوظ.
    const current = { mode: run ? 'IRRIGATING' : state.mode, since: state.since, cooldownUntil: state.cooldown_until };
    const r = step(current, { rainDetected, now, cooldownMinutes: config.cooldownMinutes });
    // لا أحداث = لا تغيير في الحالة (مثل مطر أثناء قفل مطر قائم).
    if (!r.events.length) return { changed: false, mode: state.mode };

    for (const e of r.events) {
      const { type, at, ...details } = e;
      await m.addEvent(db, type, { ...details, source, device_id: deviceId, rain_level: rainLevel }, type === 'IRRIGATION_STOPPED' ? run?.zone_id : null);
    }
    if (r.cancelCommands) {
      for (const c of await m.cancelManual(db, 'RAIN_OVERRIDE')) {
        await m.addEvent(db, 'COMMAND_CANCELLED', { command_id: c.command_id, reason: 'RAIN_OVERRIDE' }, c.zone_id);
      }
      // المناطق التي كانت اللوحة تؤجلها بسبب التوقع: المطر أثبت أن الذكاء الاصطناعي كان محقًا.
      // يُسجل الماء الموفَّر تقديريًا = (الثواني المخططة ÷ 60) × تدفق المضخة.
      for (const d of await m.latestDecisions(db)) {
        if (d.action === 'DEFER') {
          await m.addEvent(db, 'AI_DEFERRAL_CONFIRMED', {
            est_liters: +(d.planned_seconds / 60 * config.pumpFlowLpm).toFixed(2), planned_seconds: d.planned_seconds,
          }, d.zone_id);
        }
      }
    }
    // حالة ERROR «لاصقة»: المطر يقفل النظام، لكن الخروج من القفل يعيده إلى ERROR لا إلى NORMAL،
    // لذلك يُحفظ سبب العطل كما هو.
    await m.setState(db, {
      mode: r.state.mode, since: r.state.since, cooldownUntil: r.state.cooldownUntil,
      errorReason: state.mode === 'ERROR' ? state.error_reason : null,
    });
    logger.info({ from: state.mode, to: r.state.mode, source }, 'rain safety transition');
    return { changed: true, mode: r.state.mode };
  });
  // إبلاغ لوحات التحكم المفتوحة بعد نجاح المعاملة فقط.
  if (out.changed) live.broadcast('changed', { reason: 'safety', mode: out.mode });
  return out;
}

/**
 * يستدعيها الـ scheduler: تنهي فترة COOLDOWN عند انتهاء وقتها.
 * بعدها تعيد ESP32 #2 اتخاذ القرار بقراءات جديدة (التربة تغيّرت بعد المطر).
 */
async function tickCooldown() {
  const resumed = await tx(async (db) => {
    const state = await m.getState(db, { forUpdate: true });
    if (state.mode !== 'COOLDOWN') return false;
    const r = step({ mode: 'COOLDOWN', since: state.since, cooldownUntil: state.cooldown_until },
      { rainDetected: false, now: new Date().toISOString(), cooldownMinutes: config.cooldownMinutes });
    // لم ينتهِ الوقت بعد.
    if (r.state.mode !== 'NORMAL') return false;
    // إن كان هناك سبب عطل محفوظ يعود النظام إلى ERROR بدل NORMAL.
    await m.setState(db, { mode: state.error_reason ? 'ERROR' : 'NORMAL', since: r.state.since, errorReason: state.error_reason });
    for (const e of r.events) await m.addEvent(db, e.type, {});
    return true;
  });
  if (resumed) live.broadcast('changed', { reason: 'cooldown_end' });
  return resumed;
}

module.exports = { applyRainSignal, tickCooldown };
