/**
 * حلقة الخلفية (scheduler) التي تعمل كل بضع ثوانٍ (SCHEDULER_TICK_MS).
 * لا تتخذ أبدًا قرار الري (ESP32 #2 هي التي تقرر)؛ مهمتها الحفاظ على القواعد المرتبطة بالوقت:
 *   - تنبؤ جديد من الذكاء الاصطناعي كل PREDICTION_INTERVAL_MINUTES (وفور توفر 3 ساعات من السجل)
 *   - إنهاء COOLDOWN عند انتهاء وقته
 *   - اعتبار التشغيل فاشلًا إن لم يُبلغ الجهاز عن نهايته (وللجهاز على أي حال حدّه الخاص لتشغيل المضخة)
 *   - إنهاء صلاحية طلبات التشغيل اليدوي التي لم تُلتقط
 *   - أحداث اتصال/انقطاع الأجهزة (online/offline)
 * يشغّلها ويوقفها: server.js.
 */
const { query, tx } = require('../database/pool');
const m = require('../models');
const { tickCooldown } = require('./safetyService');
const { runPrediction } = require('./predictionService');
const schedulerState = require('./schedulerState');
const live = require('./liveService');
const { config } = require('../config');
const logger = require('../config/logger');

// آخر حالة اتصال معروفة لكل جهاز (لتسجيل حدث فقط عند التغيّر).
const online = {};
let timer = null;
// يمنع تداخل دورتين إن استغرقت دورة وقتًا أطول من الفاصل (مثلًا بانتظار خدمة الذكاء الاصطناعي).
let busy = false;
// حالة آخر محاولة تنبؤ، لتقرير هل تُعاد المحاولة مبكرًا.
let lastPredictionStatus = null;

// دورة واحدة من الـ scheduler.
async function tick() {
  if (busy) return;
  busy = true;
  try {
    // التشغيلات المتأخرة والأوامر المنتهية في معاملة واحدة.
    const failed = await tx(async (db) => {
      const out = await m.failOverdueRuns(db, config.runGraceSeconds);
      for (const r of out) await m.addEvent(db, 'RUN_FAILED', { run_id: r.run_id, reason: 'NO_COMPLETION_REPORT' }, r.zone_id);
      // إن فشل تشغيل وكان النظام في IRRIGATING، يعود إلى NORMAL (ولا يُمس قفل المطر إن كان قائمًا).
      if (out.length) {
        const s = await m.getState(db, { forUpdate: true });
        if (s.mode === 'IRRIGATING') await m.setState(db, { mode: 'NORMAL', since: new Date().toISOString() });
      }
      for (const c of await m.expireManual(db)) await m.addEvent(db, 'COMMAND_EXPIRED', { command_id: c.command_id }, c.zone_id);
      return out.length;
    });
    if (failed) live.broadcast('changed', { reason: 'run_failed' });

    await tickCooldown();

    // التنبؤ: في موعده، أو مبكرًا إن فشلت المحاولة السابقة لنقص السجل (أو لغياب الطقس أو توقف الخدمة)
    // وقد مرت 5 دقائق على الأقل، حتى لا ينتظر النظام 30 دقيقة كاملة بعد توفر البيانات.
    const last = schedulerState.lastScheduled();
    const due = !last || Date.now() - last >= config.predictionIntervalMinutes * 60_000;
    const retry = lastPredictionStatus === 'INSUFFICIENT_HISTORY' || lastPredictionStatus === 'NO_WEATHER' || lastPredictionStatus === 'AI_UNAVAILABLE';
    if (due || (retry && Date.now() - last >= 5 * 60_000)) {
      schedulerState.markScheduled(new Date(), config.predictionIntervalMinutes);
      lastPredictionStatus = (await runPrediction()).status;
    }

    // متابعة اتصال الأجهزة: الجهاز «متصل» إن ظهر خلال offlineAfterSeconds الخاصة بنوعه.
    for (const d of await m.listDevices({ query })) {
      const age = d.last_seen_at ? (Date.now() - new Date(d.last_seen_at)) / 1000 : Infinity;
      const isOnline = age <= config.offlineAfterSeconds[d.kind];
      // يُسجل حدث فقط عند تغيّر الحالة (وليس في أول دورة بعد بدء الخادم).
      if (online[d.id] !== undefined && online[d.id] !== isOnline) {
        await m.addEvent({ query }, isOnline ? 'DEVICE_ONLINE' : 'DEVICE_OFFLINE', { device_id: d.id });
        live.broadcast('changed', { reason: 'device' });
      }
      online[d.id] = isOnline;
    }
  } catch (err) {
    // خطأ في دورة واحدة لا يوقف الـ scheduler؛ يُسجَّل وتُحاول الدورة التالية من جديد.
    logger.error({ err }, 'scheduler tick failed');
  } finally {
    busy = false;
  }
}

// بدء الحلقة (مرة واحدة فقط حتى لو استُدعيت أكثر من مرة).
function start() {
  if (!timer) timer = setInterval(tick, config.schedulerTickMs);
  return timer;
}
// إيقاف الحلقة (عند إيقاف الخادم).
function stop() { clearInterval(timer); timer = null; }

module.exports = { start, stop, tick };
