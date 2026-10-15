/**
 * المتحكمات (controllers) لنقاط النهاية التي تستدعيها لوحتا ESP32.
 * كل ما يخص المطر يمر عبر طبقة الأمان (safetyService) قبل إرسال الرد،
 * لذا فإن الرد 201 يعني أن قفل المطر (lockout) أصبح مطبقًا بالفعل.
 * يستدعيها: routes/index.js. وتستدعي: readingsService و actuatorService و safetyService و models.
 */
const { query } = require('../database/pool');
const m = require('../models');
const readings = require('../services/readingsService');
const actuator = require('../services/actuatorService');
const { applyRainSignal } = require('../services/safetyService');
const { config } = require('../config');

const db = { query };

/**
 * التأكد من أن الجهاز مسجل في جدول devices وبالنوع الصحيح (sensor أو actuator).
 * إن لم يكن: خطأ 403. هذا يمنع جهازًا غريبًا، أو عقدة تنتحل دور العقدة الأخرى.
 */
async function assertDevice(id, kind) {
  if (!(await m.deviceExists(db, id, kind))) {
    const e = new Error(`Unknown ${kind} device "${id}". Register it in the devices table.`);
    e.status = 403;
    throw e;
  }
}

// ---------- ESP32 #1 (عقدة الحساسات) ----------
// POST /api/readings — إطار القراءات اللحظي (كل ~2 ثانية).
async function postReadings(req, res) {
  const b = req.valid;
  await assertDevice(b.device_id, 'sensor');
  // الأجهزة الحقيقية تُختم بوقت الخادم. فقط الاختبار الآلي يُسمح له بإدخال قراءات سابقة (backfill)،
  // وفقط إن كان الطابع الزمني أقدم من دقيقة.
  const backfill = config.allowDeviceTimestamps && b.timestamp && Date.now() - new Date(b.timestamp) > 60_000 ? b.timestamp : null;
  const out = await readings.ingest(b, { ip: req.ip, deviceTime: backfill });
  res.status(201).json(out);
}

// POST /api/rain-event — حدث مطر فوري (بدأ/توقف): يُحفظ ثم يُطبَّق على حالة الأمان قبل الرد.
async function postRainEvent(req, res) {
  const b = req.valid;
  await assertDevice(b.device_id, 'sensor');
  await m.touchDevice(db, b.device_id, { ip: req.ip });
  await m.insertRainEvent(db, b);
  const r = await applyRainSignal({ rainDetected: b.rain_detected, deviceId: b.device_id, source: 'rain_event', rainLevel: b.rain_level });
  res.status(201).json({ accepted: true, system_mode: r.mode, changed: r.changed });
}

// ---------- ESP32 #2 (عقدة المشغّلات) ----------
// GET /api/actuator/inputs — كل ما تحتاجه اللوحة لاتخاذ القرار (كل ثانية).
// no-store حتى لا يُعاد أبدًا رد قديم من ذاكرة تخزين مؤقت.
async function getInputs(req, res) {
  const q = req.valid;
  await assertDevice(q.device_id, 'actuator');
  res.set('Cache-Control', 'no-store');
  res.json(await actuator.inputs(q.device_id, { ip: req.ip, rssi: q.rssi, uptime_s: q.uptime_s, firmware: q.firmware }));
}

// POST /api/actuator/decisions — القرارات التي اتخذتها اللوحة لكل منطقة.
async function postDecisions(req, res) {
  await assertDevice(req.valid.device_id, 'actuator');
  res.status(201).json(await actuator.reportDecisions(req.valid.device_id, req.valid));
}

// POST /api/actuator/run — بدء نبضة ري أو انتهاؤها (قد يرد الخادم بـ abort: true لإيقافها).
async function postRun(req, res) {
  await assertDevice(req.valid.device_id, 'actuator');
  res.status(201).json(await actuator.reportRun(req.valid.device_id, req.valid));
}

module.exports = { postReadings, postRainEvent, getInputs, postDecisions, postRun };
