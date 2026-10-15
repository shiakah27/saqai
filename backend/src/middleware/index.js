/**
 * الـ middleware المشتركة: التحقق من المفاتيح، والتحقق من صحة البيانات بـ zod، ومعالجة 404 والأخطاء.
 * يستخدمها routes/index.js (للحماية والتحقق) و app.js (لـ notFound و errorHandler).
 */
const crypto = require('crypto');
const { ZodError } = require('zod');
const { config } = require('../config');
const logger = require('../config/logger');

/** مقارنة بزمن ثابت، حتى لا يمكن تخمين المفتاح بايتًا بايتًا من زمن الاستجابة. */
function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** على الأجهزة إرسال x-api-key. طلبات GET الخاصة بلوحة التحكم تبقى مفتوحة على الشبكة المحلية. */
function requireDeviceKey(req, res, next) {
  if (safeEqual(req.get('x-api-key'), config.deviceApiKey)) return next();
  return res.status(401).json({ error: 'UNAUTHORIZED', message: 'Missing or wrong x-api-key header' });
}
/** عمليات الإدارة (المعايرة، التشغيل اليدوي، مسح العطل) تتطلب الترويسة x-admin-key. */
function requireAdminKey(req, res, next) {
  if (safeEqual(req.get('x-admin-key'), config.adminApiKey)) return next();
  return res.status(401).json({ error: 'UNAUTHORIZED', message: 'Missing or wrong x-admin-key header' });
}

/**
 * التحقق من req.body (أو req.query) باستخدام zod schema.
 * عند الفشل يُعاد 400 مع قائمة الحقول الخاطئة؛ وعند النجاح توضع القيمة المُحلَّلة في req.valid
 * (وهي التي تستخدمها المتحكمات بدل البيانات الأصلية).
 */
const validate = (schema, where = 'body') => (req, res, next) => {
  const parsed = schema.safeParse(req[where]);
  if (!parsed.success) {
    return res.status(400).json({
      error: 'VALIDATION_ERROR',
      details: parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
    });
  }
  req.valid = parsed.data;
  return next();
};

/** أي مسار غير موجود: 404 بصيغة JSON. */
function notFound(req, res) {
  res.status(404).json({ error: 'NOT_FOUND', message: `${req.method} ${req.path} does not exist` });
}

/**
 * معالج الأخطاء الأخير: يحوّل أي خطأ إلى رد JSON منظم.
 * أخطاء العميل (JSON غير صالح، جسم كبير جدًا، أو خطأ يحمل status < 500) تُعاد برسالتها،
 * أما أخطاء الخادم (5xx) فتُسجَّل ويُعاد للعميل نص عام دون كشف التفاصيل الداخلية.
 * المعامل next غير مستخدم، لكن Express يحتاج إلى 4 معاملات ليعرف أنها دالة معالجة أخطاء.
 */
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (err instanceof ZodError) return res.status(400).json({ error: 'VALIDATION_ERROR', details: err.issues });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'INVALID_JSON', message: 'Body is not valid JSON' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'BODY_TOO_LARGE' });
  const status = err.status || 500;
  if (status >= 500) logger.error({ err, path: req.path }, 'request failed');
  return res.status(status).json({ error: status >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_ERROR', message: status >= 500 ? 'Unexpected server error' : err.message });
}

module.exports = { requireDeviceKey, requireAdminKey, validate, notFound, errorHandler };
