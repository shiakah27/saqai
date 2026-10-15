/**
 * المتحكمات (controllers) لنقاط النهاية التي تستدعيها لوحة التحكم (React):
 *   - مسارات القراءة: الحالة، السجل، البث المباشر SSE، آخر تنبؤ، حالة النظام، المناطق.
 *   - مسارات الإدارة (x-admin-key): تعديل منطقة، مسح العطل، تنبؤ فوري، تشغيل يدوي.
 * يستدعيها: routes/index.js. وتستدعي: statusService و liveService و predictionService و manualService و models.
 */
const { query, tx } = require('../database/pool');
const m = require('../models');
const status = require('../services/statusService');
const live = require('../services/liveService');
const { runPrediction } = require('../services/predictionService');
const { manualRun } = require('../services/manualService');
const { resetZoneCache } = require('../services/readingsService');

const db = { query };

// GET /api/status — صورة كاملة عن النظام الآن (no-store حتى تكون القيم حديثة دائمًا).
const getStatus = async (req, res) => { res.set('Cache-Control', 'no-store'); res.json(await status.buildStatus()); };
// GET /api/history — بيانات الرسوم البيانية والخط الزمني لآخر N ساعة.
const getHistory = async (req, res) => res.json(await status.buildHistory(req.valid.hours));
// GET /api/stream — فتح اتصال SSE يبقى مفتوحًا لاستقبال التحديثات المباشرة.
const stream = (req, res) => live.attach(req, res);
// GET /api/prediction/latest — آخر تنبؤ (أيًّا كانت حالته)، أو 404 إن لم يوجد تنبؤ بعد.
const getLatestPrediction = async (req, res) => {
  const p = await m.latestPrediction(db);
  if (!p) return res.status(404).json({ error: 'NOT_FOUND', message: 'No prediction yet' });
  return res.json({
    rain_probability: p.rain_probability, status: p.status, threshold: p.threshold,
    forecast_horizon_hours: p.horizon_hours, model_version: p.model_version, generated_at: p.created_at, drivers: p.drivers,
  });
};
// GET /api/system/state — وضع الأمان الحالي فقط (أخف من /status، ويُستخدم للاستطلاع السريع).
const getSystemState = async (req, res) => {
  const s = await m.getState(db);
  res.set('Cache-Control', 'no-store');
  res.json({ mode: s.mode, rain_lockout: s.mode === 'RAIN_LOCKOUT', since: s.since, cooldown_until: s.cooldown_until, error_reason: s.error_reason });
};
// GET /api/zones — إعدادات كل المناطق.
const getZones = async (req, res) => res.json(await m.listZones(db));

// ---------- الإدارة (x-admin-key) ----------
/**
 * PATCH /api/admin/zones/:id — تعديل إعدادات منطقة (معايرة).
 * أسماء الأعمدة في جملة SET تأتي فقط من مفاتيح zonePatch المسموح بها (schema صارم)، والقيم تُمرَّر
 * كباراميترات ($2، $3...)، لذا لا يوجد خطر SQL injection.
 * تصل الإعدادات الجديدة إلى ESP32 #2 في الاستطلاع التالي دون إعادة برمجة.
 */
async function patchZone(req, res) {
  const id = Number(req.params.id);
  const fields = Object.entries(req.valid);
  if (!fields.length) return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'nothing to update' });
  const sets = fields.map(([k], i) => `${k} = $${i + 2}`).join(', ');
  try {
    const { rows } = await query(`UPDATE zones SET ${sets} WHERE id = $1 RETURNING *`, [id, ...fields.map(([, v]) => v)]);
    if (!rows.length) return res.status(404).json({ error: 'NOT_FOUND', message: `zone ${id}` });
    await m.addEvent(db, 'ZONE_UPDATED', req.valid, id);
    // تفريغ ذاكرة المناطق المؤقتة في readingsService حتى تُقرأ من جديد.
    resetZoneCache();
    live.broadcast('changed', { reason: 'zone' });
    return res.json(rows[0]);
  } catch (err) {
    // 23514 = خرق قيد CHECK في PostgreSQL: الرطوبة الحرجة يجب أن تكون أقل من الرطوبة المستهدفة.
    if (err.code === '23514') return res.status(422).json({ error: 'INVALID_ZONE', message: 'الحد الحرج يجب أن يكون أقل من الهدف' });
    throw err;
  }
}

/**
 * POST /api/admin/reset-error — مسح حالة العطل بعد إصلاح سببها يدويًا.
 * يتم داخل معاملة مع قفل صف الحالة حتى لا يتعارض مع انتقال أمان آخر في اللحظة نفسها.
 */
async function resetError(req, res) {
  const out = await tx(async (t) => {
    const s = await m.getState(t, { forUpdate: true });
    if (s.mode !== 'ERROR' && !s.error_reason) return { mode: s.mode, changed: false };
    // أثناء المطر يبقى القفل كما هو؛ يُمسح سبب العطل فقط فلا يعود النظام إلى ERROR بعد المطر.
    const mode = s.mode === 'ERROR' ? 'NORMAL' : s.mode;
    await m.setState(t, { mode, since: new Date().toISOString(), cooldownUntil: s.cooldown_until });
    await m.addEvent(t, 'ERROR_CLEARED', { previous: s.error_reason });
    return { mode, changed: true };
  });
  live.broadcast('changed', { reason: 'error_cleared' });
  res.json(out);
}

// POST /api/admin/predict — تشغيل تنبؤ فوري (مفيد في العرض والاختبار).
const predictNow = async (req, res) => res.json(await runPrediction());
// POST /api/admin/manual-run — إنشاء أمر تشغيل يدوي تجريبي لمنطقة واحدة.
const manualZoneRun = async (req, res) => res.status(201).json(await manualRun(req.valid.zone_id, req.valid.seconds));

module.exports = { getStatus, getHistory, stream, getLatestPrediction, getSystemState, getZones, patchZone, resetError, predictNow, manualZoneRun };
