/**
 * خريطة مسارات الـ API (كلها تحت /api، ويركّبها app.js).
 * لكل مسار: الحماية المطلوبة (مفتاح الجهاز أو مفتاح الإدارة) ← التحقق من البيانات (zod schema)
 * ← المتحكم (controller) الذي ينفذ الطلب.
 * المجموعات: ESP32 #1 (الحساسات)، ESP32 #2 (المشغّلات)، لوحة التحكم (قراءة فقط)، الإدارة.
 */
const express = require('express');
const { requireDeviceKey, requireAdminKey, validate } = require('../middleware');
const s = require('../models/schemas');
const device = require('../controllers/deviceController');
const dash = require('../controllers/dashboardController');
const { pool } = require('../database/pool');

const r = express.Router();

// GET /api/health — فحص سريع: هل الخادم يعمل وهل قاعدة البيانات تستجيب؟ (503 إن كانت القاعدة متوقفة)
r.get('/health', async (req, res) => {
  const db = await pool.query('SELECT 1').then(() => 'ok').catch(() => 'down');
  res.status(db === 'ok' ? 200 : 503).json({ status: db === 'ok' ? 'ok' : 'degraded', database: db, time: new Date().toISOString() });
});

// ---------- ESP32 #1 — عقدة الحساسات (BME280 + لوحة المطر MH-RD + رطوبة التربة) ----------
// إطار القراءات اللحظي: كل ~2 ثانية.
r.post('/readings', requireDeviceKey, validate(s.readings), device.postReadings);
// حدث المطر: يُرسل فورًا عند تغيّر حالة المطر (بدأ/توقف).
r.post('/rain-event', requireDeviceKey, validate(s.rainEvent), device.postRainEvent);

// ---------- ESP32 #2 — عقدة المشغّلات (تتخذ القرار، وتشغّل المضخة والصمامات) ----------
// مدخلات القرار: تستطلعها اللوحة كل ثانية (الحساسات + التنبؤ + إعدادات المناطق + حالة الأمان).
r.get('/actuator/inputs', requireDeviceKey, validate(s.actuatorQuery, 'query'), device.getInputs);
// تقرير القرارات التي اتخذتها اللوحة لكل منطقة (مع اللترات والـ trace).
r.post('/actuator/decisions', requireDeviceKey, validate(s.decisions), device.postDecisions);
// تقرير بدء نبضة ري أو انتهائها.
r.post('/actuator/run', requireDeviceKey, validate(s.run), device.postRun);

// ---------- لوحة التحكم (قراءة فقط، مفتوحة على الشبكة المحلية) ----------
// الحالة الحالية الكاملة للنظام.
r.get('/status', dash.getStatus);
// السجل التاريخي للرسوم البيانية والخط الزمني (عدد الساعات في ?hours=).
r.get('/history', validate(s.historyQuery, 'query'), dash.getHistory);
// بث مباشر بتقنية Server-Sent Events (SSE).
r.get('/stream', dash.stream);
// آخر تنبؤ بالمطر.
r.get('/prediction/latest', dash.getLatestPrediction);
// حالة الأمان الحالية (NORMAL / RAIN_LOCKOUT / COOLDOWN ...).
r.get('/system/state', dash.getSystemState);
// إعدادات المناطق.
r.get('/zones', dash.getZones);

// ---------- الإدارة (تتطلب الترويسة x-admin-key) ----------
// التحقق من صحة مفتاح الإدارة فقط (للتأكد من المفتاح قبل تنفيذ عمليات الصيانة).
r.get('/admin/check', requireAdminKey, (req, res) => res.json({ ok: true }));
// تعديل إعدادات منطقة (المعايرة).
r.patch('/admin/zones/:id', requireAdminKey, validate(s.zonePatch), dash.patchZone);
// مسح حالة العطل ERROR بعد إصلاح سببها.
r.post('/admin/reset-error', requireAdminKey, dash.resetError);
// طلب تنبؤ فوري دون انتظار موعد الـ scheduler.
r.post('/admin/predict', requireAdminKey, dash.predictNow);
// طلب تشغيل يدوي تجريبي لمنطقة واحدة.
r.post('/admin/manual-run', requireAdminKey, validate(s.manualRun), dash.manualZoneRun);

module.exports = r;
