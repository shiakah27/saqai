/**
 * خدمة عقدة المشغّلات (ESP32 #2).
 * اللوحة هي التي تتخذ قرار الري على الجهاز نفسه. الـ backend يعطيها كل ما تحتاجه كل ثانية،
 * ويسجل ما قررته وما نفذته:
 *
 *   GET  /api/actuator/inputs     ← رطوبة التربة والمطر لحظيًا، آخر تنبؤ للذكاء الاصطناعي، إعدادات المناطق،
 *                                   حالة الأمان، إعدادات محرك القرار، وأمر التشغيل اليدوي المنتظر
 *   POST /api/actuator/decisions  → قرار كل منطقة مع الـ trace (يُحفظ عند تغيّره)
 *   POST /api/actuator/run        → بدأت نبضة / انتهت (صمام واحد في كل مرة)
 *
 * الكلمة الأخيرة في الأمان تبقى للـ backend: أثناء RAIN_LOCKOUT / COOLDOWN / ERROR يرد على تقرير
 * "started" بـ { abort: true }، وعلى اللوحة أن تتوقف.
 * يستدعيها: deviceController.js.
 */
const { query, tx } = require('../database/pool');
const m = require('../models');
const live = require('./liveService');
const { config } = require('../config');

const db = { query };
// الأوضاع التي يُمنع فيها أي ري (تلقائي أو يدوي).
const BLOCKING = ['RAIN_LOCKOUT', 'COOLDOWN', 'ERROR'];
// آخر قرار حُفظ لكل منطقة في الذاكرة: zone_id ← { key, at } (لتجنب حفظ القرار نفسه كل ثانية).
const lastStored = new Map();

/**
 * بناء رد GET /api/actuator/inputs.
 * يُستدعى كل ثانية، لذا يأخذ قيم الحساسات من الذاكرة (liveService) لا من قاعدة البيانات.
 */
async function inputs(deviceId, info) {
  await m.touchDevice(db, deviceId, info);
  // إنهاء صلاحية الأوامر اليدوية القديمة قبل البحث عن أمر منتظر.
  for (const c of await m.expireManual(db)) await m.addEvent(db, 'COMMAND_EXPIRED', { command_id: c.command_id }, c.zone_id);

  const [state, zones, prediction, manual, run] = await Promise.all([
    m.getState(db), m.listZones(db), m.latestOkPrediction(db), m.pendingManual(db), m.activeRun(db),
  ]);
  const frame = live.getFrame();
  const age = live.frameAgeSeconds();
  // البيانات «حديثة» فقط إن كان عمر آخر إطار ≤ SENSOR_STALE_SECONDS؛ وإلا تُرسل فارغة فتتوقف اللوحة (HOLD).
  const fresh = age <= config.sensorStaleSeconds;
  const liveSoil = Object.fromEntries((frame?.soil || []).map((s) => [s.zone_id, s]));
  const predAge = prediction ? (Date.now() - new Date(prediction.created_at)) / 1000 : null;
  // التنبؤ الأقدم من 2.5 × فاصل التنبؤ (75 دقيقة افتراضيًا) يُتجاهل: فاتت عليه محاولتان مجدولتان
  // على الأقل (خدمة الذكاء الاصطناعي متوقفة مثلًا)، فلم يعد يصف الطقس الحالي. عندها تقرر اللوحة
  // اعتمادًا على التربة وحدها بدل تأجيل الري بناءً على توقع قديم.
  const predUsable = prediction && predAge <= config.predictionIntervalMinutes * 60 * 2.5;

  return {
    server_time: new Date().toISOString(),
    system_mode: state.mode,
    rain_lockout: state.mode === 'RAIN_LOCKOUT',
    cooldown: state.mode === 'COOLDOWN',
    error: state.mode === 'ERROR',
    sensors_fresh: fresh,
    sensor_age_s: Number.isFinite(age) ? Math.round(age * 10) / 10 : null,
    rain_detected: fresh ? !!frame.rain_detected : false,
    weather: fresh ? { temperature: frame.temperature, humidity: frame.humidity } : null,
    prediction: predUsable ? {
      rain_probability: prediction.rain_probability, threshold: prediction.threshold,
      horizon_hours: prediction.horizon_hours, age_s: Math.round(predAge),
    } : null,
    // لكل منطقة: القراءة اللحظية (إن كانت حديثة وصالحة) مع إعداداتها (الهدف، الحد الحرج، ثوانٍ لكل 1%).
    zones: zones.map((z) => {
      const s = fresh ? liveSoil[z.id] : null;
      return {
        id: z.id, enabled: z.enabled,
        has_reading: !!s,
        valid: s ? s.valid : false,
        soil: s && s.valid ? s.soil_moisture : null,
        target: z.target_moisture, critical: z.critical_moisture, seconds_per_percent: z.seconds_per_percent,
      };
    }),
    engine: config.engine,
    active_run_id: run?.run_id || null,
    // الأمر اليدوي يُرسل فقط إن كان الوضع يسمح ولا يوجد تشغيل نشط (مضخة واحدة).
    manual: !BLOCKING.includes(state.mode) && !run && manual
      ? { command_id: manual.command_id, zone: manual.zone_id, seconds: manual.duration_seconds, expires_at: manual.expires_at }
      : null,
  };
}

/**
 * حفظ قرار المنطقة عند تغيّره، وعلى الأقل كل 10 دقائق (حتى يبقى الخط الزمني متصلًا).
 * اللوحة ترسل قراراتها باستمرار؛ حفظ كل تقرير سيملأ الجدول بصفوف مكررة بلا فائدة.
 * يسجل أيضًا أحداث بدء التأجيل بسبب التوقع، وانتهاء التأجيل دون مطر.
 */
async function reportDecisions(deviceId, body) {
  await m.touchDevice(db, deviceId);
  const state = await m.getState(db);
  const prediction = await m.latestOkPrediction(db);
  const frame = live.getFrame();
  const soil = Object.fromEntries((frame?.soil || []).map((s) => [s.zone_id, s.soil_moisture]));
  // آخر قرار محفوظ لكل منطقة قبل هذا التقرير، لاكتشاف التحول من/إلى DEFER.
  const latest = Object.fromEntries((await m.latestDecisions(db)).map((d) => [d.zone_id, d]));
  let changed = 0;

  for (const d of body.zones) {
    // «بصمة» القرار: الفعل + السبب + المدة (للري فقط) + هل المنطقة هي المختارة.
    const key = `${d.action}|${d.reason}|${d.action === 'IRRIGATE' ? d.seconds : ''}|${d.zone_id === body.chosen_zone}`;
    const prev = lastStored.get(d.zone_id);
    // البصمة نفسها ولم تمر 10 دقائق: لا داعي للحفظ.
    if (prev && prev.key === key && Date.now() - prev.at < 10 * 60_000) continue;
    lastStored.set(d.zone_id, { key, at: Date.now() });
    const secs = d.action === 'IRRIGATE' ? d.seconds : 0;
    // اللترات: القيمة التي حسبتها اللوحة إن أرسلتها، وإلا تقدير = (الثواني ÷ 60) × تدفق المضخة.
    await m.insertDecision(db, {
      device_id: deviceId, zone_id: d.zone_id, action: d.action, seconds: secs, planned_seconds: d.planned_seconds || 0,
      est_liters: +(d.action === 'IRRIGATE' && d.liters != null ? d.liters : secs / 60 * config.pumpFlowLpm).toFixed(2), reason_code: d.reason, urgency: d.urgency,
      chosen: d.zone_id === body.chosen_zone, rain_probability: prediction?.rain_probability ?? null,
      soil_moisture: soil[d.zone_id] ?? null, system_mode: state.mode,
      trace: (d.trace || []).map((t) => ({ step: t.step, result: t.pass ? 'pass' : 'stop', note: t.note })),
    });
    const before = latest[d.zone_id];
    // بداية تأجيل جديد بسبب توقع المطر.
    if (d.action === 'DEFER' && before?.action !== 'DEFER') {
      await m.addEvent(db, 'IRRIGATION_DEFERRED', { rain_probability: prediction?.rain_probability ?? null }, d.zone_id);
    }
    // انتهى التأجيل وعاد الري دون أن يهطل المطر (يُحسب في إحصاءات دقة التأجيل).
    if (d.action === 'IRRIGATE' && before?.action === 'DEFER') {
      await m.addEvent(db, 'DEFERRAL_ENDED_NO_RAIN', { reason: d.reason }, d.zone_id);
    }
    changed++;
  }
  if (changed) live.broadcast('changed', { reason: 'decision' });
  return { stored: changed };
}

/**
 * بدأت نبضة ري أو انتهت. العملية idempotent حسب run_id: تكرار التقرير نفسه (بسبب إعادة الإرسال
 * بعد انقطاع الشبكة مثلًا) لا يُحدث أثرًا مزدوجًا.
 * كل شيء داخل معاملة واحدة مع قفل صف الحالة، فلا يمكن أن يبدأ ري في اللحظة نفسها التي يبدأ فيها المطر.
 */
async function reportRun(deviceId, b) {
  const out = await tx(async (t) => {
    await m.touchDevice(t, deviceId);
    const state = await m.getState(t, { forUpdate: true });

    if (b.event === 'started') {
      // تقرير مكرر لنبضة معروفة: أوقفها إن لم تعد نشطة.
      const existing = await m.getRun(t, b.run_id);
      if (existing) return { ok: true, abort: existing.status !== 'ACTIVE' };
      // الوضع يمنع الري: يُرفض التشغيل وعلى اللوحة الإيقاف فورًا.
      if (BLOCKING.includes(state.mode)) {
        await m.addEvent(t, 'RUN_REFUSED', { run_id: b.run_id, mode: state.mode }, b.zone);
        return { ok: true, abort: true, reason: state.mode };
      }
      // التحقق قبل لمس أي شيء آخر، حتى لا يؤثر طلب مرفوض على نبضة تعمل حاليًا.
      // الأمر اليدوي يجب أن يكون ما زال PENDING وصالحًا؛ takeManual يحوّله إلى TAKEN فلا يُنفَّذ مرتين.
      if (b.command_id && !(await m.takeManual(t, b.command_id))) {
        await m.addEvent(t, 'RUN_REFUSED', { run_id: b.run_id, reason: 'MANUAL_COMMAND_NOT_PENDING' }, b.zone);
        return { ok: true, abort: true, reason: 'MANUAL_COMMAND_NOT_PENDING' };
      }
      const other = await m.activeRun(t);
      // اللوحة فقدت أثر تشغيل سابق (أُعيد تشغيلها أثناء الري مثلًا): يُغلق ذلك التشغيل كفاشل.
      // هذا ضروري لأن قاعدة البيانات لا تسمح إلا بتشغيل نشط واحد (مضخة واحدة).
      if (other) {
        await m.finishRun(t, other.run_id, { status: 'FAILED', actualSeconds: null, estLiters: null, stopReason: 'SUPERSEDED' });
        await m.addEvent(t, 'RUN_SUPERSEDED', { run_id: other.run_id }, other.zone_id);
      }
      await m.insertRun(t, {
        run_id: b.run_id, device_id: deviceId, zone_id: b.zone, kind: b.command_id ? 'manual' : 'auto',
        command_id: b.command_id, reason_code: b.reason, planned_seconds: b.planned_seconds,
      });
      await m.setState(t, { mode: 'IRRIGATING', since: new Date().toISOString() });
      await m.addEvent(t, 'IRRIGATION_STARTED', { run_id: b.run_id, seconds: b.planned_seconds, reason: b.reason, manual: !!b.command_id }, b.zone);
      return { ok: true, abort: false };
    }

    // ---- انتهت النبضة (finished) ----
    const statusMap = { completed: 'COMPLETED', cancelled: 'CANCELLED', failed: 'FAILED' };
    const secs = b.actual_seconds ?? 0;
    // اللترات تقديرية من المدة الفعلية × تدفق المضخة (لا يوجد حساس تدفق).
    const run = await m.finishRun(t, b.run_id, {
      status: statusMap[b.status], actualSeconds: secs, estLiters: +(secs / 60 * config.pumpFlowLpm).toFixed(2), stopReason: b.stop_reason,
    });
    // لا يوجد تشغيل نشط بهذا الرقم: تقرير مكرر، يُقبل دون أي أثر.
    if (!run) return { ok: true, duplicate: true };
    const type = b.status === 'completed' ? 'IRRIGATION_COMPLETED' : b.status === 'cancelled' ? 'IRRIGATION_STOP_CONFIRMED' : 'SYSTEM_ERROR';
    await m.addEvent(t, type, { run_id: b.run_id, seconds: secs, reason: b.stop_reason, pump: b.pump, valve: b.valve }, run.zone_id);
    // فشل أبلغت عنه اللوحة: يدخل النظام في ERROR حتى يمسحه المسؤول يدويًا.
    // وإلا يعود إلى NORMAL فقط إن كان IRRIGATING (لا يُلغى قفل مطر بدأ أثناء الري).
    if (b.status === 'failed') {
      await m.setState(t, { mode: 'ERROR', since: new Date().toISOString(), errorReason: b.stop_reason || 'DEVICE_REPORTED_FAILURE' });
    } else if (state.mode === 'IRRIGATING') {
      await m.setState(t, { mode: 'NORMAL', since: new Date().toISOString() });
    }
    return { ok: true };
  });
  live.broadcast('changed', { reason: 'run' });
  return out;
}

module.exports = { inputs, reportDecisions, reportRun };
