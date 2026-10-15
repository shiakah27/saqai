/**
 * client.js — طبقة الاتصال بالخادم (Backend)، وهي المكان الوحيد الذي يتحدث مع الخادم.
 * لا يظهر على الشاشة مباشرة؛ تستخدمه الـhook المسمّاة useDashboard ولوحة الصيانة.
 * تقرأ اللوحة:
 *   GET /api/status   → النظام، الطقس، التنبؤ، المناطق مع قراراتها، الأوامر، الأجهزة، الأحداث، الجاهزية
 *   GET /api/history  → { points, decisions, runs, window } للرسوم البيانية والخط الزمني للقرارات
 * وفي لوحة الصيانة فقط تستدعي مسارات الإدارة (admin) بمفتاح الإدارة الذي يكتبه المستخدم.
 * اللوحة لا تقرر أي شيء؛ هي تعرض فقط ما قرره الخادم.
 */
// عنوان الخادم (اختياري)؛ فارغ يعني نفس العنوان الذي فُتحت منه اللوحة. تُحذف الشرطة الأخيرة إن وُجدت.
const API_URL = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');
export const POLL_MS = Number(import.meta.env.VITE_POLL_MS || 5000);   // مدة التحديث الكامل الدوري؛ القيم الحية تصل عبر SSE

// دالة عامة لإرسال طلب HTTP وإرجاع JSON.
// - تضيف مفتاح الإدارة في الترويسة x-admin-key عند الحاجة.
// - تلغي الطلب بعد timeoutMs (افتراضيًا 4 ثوانٍ) حتى لا تتعلق اللوحة إن لم يرد الخادم.
// - إذا كان الرد خطأ (ليس ok) ترمي Error يحمل رسالة الخادم ورمز الحالة status.
async function request(method, path, { body, adminKey, timeoutMs = 4000 } = {}) {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: {
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(adminKey ? { 'x-admin-key': adminKey } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(json?.message || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return json;
}

// هل هذه نسخة المعاينة (ملف HTML واحد ببيانات مسجّلة)؟ تُضبط في vite.preview.config.js.
export const IS_PREVIEW = import.meta.env.VITE_PREVIEW === '1';

// جلب لقطة كاملة: الحالة الحالية + سجل آخر hours ساعة، بالتوازي.
// في المعاينة تُستورد بيانات مسجّلة بدل الاتصال بالخادم (استيراد ديناميكي فلا يدخل كود المعاينة في البناء الحقيقي).
export async function fetchSnapshot(hours = 24) {
  if (IS_PREVIEW) return (await import('../preview/preview.js')).previewSnapshot();
  const [status, history] = await Promise.all([request('GET', '/api/status'), request('GET', `/api/history?hours=${hours}`)]);
  return { status, history };
}

// في المعاينة تُرفض كل أوامر الإدارة برسالة توضيحية بالعربية.
const refuse = async () => (await import('../preview/preview.js')).previewRefusal();

// أوامر الإدارة (لوحة الصيانة): فحص المفتاح، تشغيل يدوي لصمام، طلب تنبؤ جديد، مسح حالة العطل، تعديل إعدادات منطقة.
// كلها تحتاج مفتاح الإدارة key. طلب التنبؤ له مهلة أطول (15 ث) لأن النموذج قد يتأخر.
export const admin = IS_PREVIEW ? { check: refuse, run: refuse, predict: refuse, resetError: refuse, patchZone: refuse } : {
  check: (key) => request('GET', '/api/admin/check', { adminKey: key }),
  run: (key, zoneId, seconds) => request('POST', '/api/admin/manual-run', { adminKey: key, body: { zone_id: zoneId, seconds } }),
  predict: (key) => request('POST', '/api/admin/predict', { adminKey: key, timeoutMs: 15000 }),
  resetError: (key) => request('POST', '/api/admin/reset-error', { adminKey: key }),
  patchZone: (key, id, body) => request('PATCH', `/api/admin/zones/${id}`, { adminKey: key, body }),
};
