/**
 * عميل خدمة الذكاء الاصطناعي (Python FastAPI).
 * أي فشل (الخدمة متوقفة، بطيئة، أو ردها غير صالح) يعيد حالة (status) بدل رمي خطأ: عندها يعمل
 * محرك القرار اعتمادًا على بيانات التربة وحدها ويوضح ذلك. الذكاء الاصطناعي ليس أبدًا جزءًا من مسار
 * الأمان، فتعطله قد يؤخر «تأجيلًا ذكيًا» لكنه لا يمكن أبدًا أن يمنع قفل المطر.
 * يستدعيه: predictionService (التنبؤ) و statusService (الصحة وبطاقة النموذج).
 */
const { config } = require('../config');
const logger = require('../config/logger');

// بطاقة النموذج (model card) محفوظة مؤقتًا مع وقت جلبها.
let modelCard = null;
let modelCardAt = 0;

/**
 * POST /predict — يرسل قراءات المحطة الأخيرة ويستقبل احتمال المطر.
 * الحالات المعادة: 'OK' مع النتيجة، أو 'INSUFFICIENT_HISTORY' (السجل أقل من المطلوب)،
 * أو 'AI_UNAVAILABLE' عند أي خطأ آخر.
 */
async function predict(readings) {
  try {
    const res = await fetch(`${config.aiServiceUrl}/predict`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ readings }),
      signal: AbortSignal.timeout(config.aiTimeoutMs),
    });
    const body = await res.json().catch(() => ({}));
    // 422 مع INSUFFICIENT_HISTORY: الخدمة تعمل لكن البيانات المتوفرة لا تكفي بعد.
    if (res.status === 422 && body.detail === 'INSUFFICIENT_HISTORY') return { status: 'INSUFFICIENT_HISTORY' };
    if (!res.ok) throw new Error(`AI service HTTP ${res.status}`);
    // الاحتمال يجب أن يكون رقمًا بين 0 و 1، وإلا يُرفض الرد.
    if (typeof body.rain_probability !== 'number' || body.rain_probability < 0 || body.rain_probability > 1) {
      throw new Error('AI service returned an invalid probability');
    }
    return { status: 'OK', ...body };
  } catch (err) {
    logger.warn({ err: err.message }, 'AI service unavailable');
    return { status: 'AI_UNAVAILABLE', error: err.message };
  }
}

// نتيجة آخر فحص صحة مع وقته.
let health = { ok: false, at: 0 };
/** GET /health — هل الخدمة تعمل؟ النتيجة تُحفظ 10 ثوانٍ حتى لا تُفحص الخدمة مع كل طلب حالة. */
async function isHealthy() {
  if (Date.now() - health.at < 10_000) return health.ok;
  try {
    const res = await fetch(`${config.aiServiceUrl}/health`, { signal: AbortSignal.timeout(1500) });
    health = { ok: res.ok, at: Date.now() };
  } catch { health = { ok: false, at: Date.now() }; }
  return health.ok;
}

/**
 * GET /model — بطاقة النموذج (الإصدار، العتبة، أفق التنبؤ...)، تُحفظ 10 دقائق لأنها نادرًا ما تتغير.
 * إن فشل الجلب تبقى النسخة المحفوظة سابقًا.
 */
async function getModelCard() {
  if (modelCard && Date.now() - modelCardAt < 10 * 60_000) return modelCard;
  try {
    const res = await fetch(`${config.aiServiceUrl}/model`, { signal: AbortSignal.timeout(config.aiTimeoutMs) });
    if (res.ok) { modelCard = await res.json(); modelCardAt = Date.now(); }
  } catch { /* تبقى البطاقة المحفوظة مؤقتًا */ }
  return modelCard;
}

module.exports = { predict, getModelCard, isHealthy };
