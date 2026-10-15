/**
 * إعدادات الـ backend.
 * كل الإعدادات تأتي من متغيرات البيئة (الملف backend/.env)، والقيم الافتراضية مناسبة للنموذج الأولي.
 * يستورده تقريبًا كل ملف في الـ backend (الخدمات والمتحكمات والـ middleware وقاعدة البيانات).
 */
require('dotenv').config();

// قراءة متغير بيئة رقمي: إن لم يُضبط تُعاد القيمة الافتراضية، وإن كان نصًا غير رقمي يتوقف التشغيل
// برسالة واضحة بدل أن يعمل النظام بقيمة خاطئة بصمت.
const num = (name, def) => {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Environment variable ${name} must be a number, got "${v}"`);
  return n;
};
// قراءة متغير بيئة منطقي (true/false): القيم '1' أو 'true' أو 'yes' تعني «نعم».
const bool = (name, def) => (process.env[name] === undefined ? def : ['1', 'true', 'yes'].includes(process.env[name].toLowerCase()));

const config = {
  // بيئة التشغيل: development أو test أو production.
  env: process.env.NODE_ENV || 'development',
  // منفذ HTTP الذي يستمع عليه الخادم (الافتراضي 3000).
  port: num('PORT', 3000),
  // رابط الاتصال بقاعدة PostgreSQL (إلزامي).
  databaseUrl: process.env.DATABASE_URL,
  // المفتاح الذي ترسله لوحتا ESP32 في الترويسة x-api-key (إلزامي).
  deviceApiKey: process.env.DEVICE_API_KEY,
  // مفتاح لوحة الإدارة (x-admin-key)؛ إن لم يُضبط يُستخدم مفتاح الأجهزة نفسه.
  adminApiKey: process.env.ADMIN_API_KEY || process.env.DEVICE_API_KEY,
  // عنوان خدمة الذكاء الاصطناعي (Python FastAPI)، مع حذف الشرطة المائلة الأخيرة إن وُجدت.
  aiServiceUrl: (process.env.AI_SERVICE_URL || 'http://localhost:8000').replace(/\/$/, ''),
  // أقصى زمن انتظار لرد خدمة الذكاء الاصطناعي، بالمللي ثانية.
  aiTimeoutMs: num('AI_TIMEOUT_MS', 3000),
  // المصادر المسموح لها بطلب الـ API من المتصفح (CORS)؛ '*' تعني الجميع.
  corsOrigin: process.env.CORS_ORIGIN || '*',
  // الأجهزة الحقيقية تُختم قراءاتها دائمًا بوقت الخادم. فقط اختبار end-to-end الآلي (NODE_ENV=test)
  // يُسمح له بإدخال قراءات بتاريخ سابق (backfill)؛ ولا يمكن تفعيل هذا أبدًا في التطوير أو الإنتاج.
  allowDeviceTimestamps: (process.env.NODE_ENV === 'test') && bool('ALLOW_DEVICE_TIMESTAMPS', false),

  // ---- تدفق الحساسات اللحظي ----
  // كل كم ثانية تُحفظ قراءة طقس في قاعدة البيانات: تصل لحظيًا كل ~2 ثانية، ويُحفظ صف واحد في الدقيقة.
  weatherStoreSeconds: num('WEATHER_STORE_SECONDS', 60),
  // كل كم ثانية تُحفظ قراءات رطوبة التربة (الافتراضي كل 10 ثوانٍ).
  soilStoreSeconds: num('SOIL_STORE_SECONDS', 10),
  // عمر بيانات الحساسات بالثواني الذي تُعدّ بعده قديمة؛ عندها تتوقف ESP32 #2 عن الري (HOLD).
  sensorStaleSeconds: num('SENSOR_STALE_SECONDS', 10),

  // الفاصل بالدقائق بين كل طلب تنبؤ بالمطر من خدمة الذكاء الاصطناعي.
  predictionIntervalMinutes: num('PREDICTION_INTERVAL_MINUTES', 30),
  // مدة فترة الانتظار (cooldown) بالدقائق بعد توقف المطر قبل السماح بالري من جديد.
  cooldownMinutes: num('RAIN_COOLDOWN_MINUTES', 5),
  // مدة صلاحية أمر التشغيل اليدوي بالثواني؛ بعدها ينتهي إن لم تلتقطه ESP32 #2.
  manualTtlSeconds: num('MANUAL_TTL_SECONDS', 60),
  // مهلة إضافية بالثواني بعد المدة المخططة للري قبل اعتبار التشغيل فاشلًا لغياب تقرير الانتهاء.
  runGraceSeconds: num('RUN_GRACE_SECONDS', 30),
  // أقصى مدة تشغيل للمضخة في النبضة الواحدة، بالثواني.
  maxPumpOnSeconds: num('MAX_PUMP_ON_SECONDS', 60),
  // تدفق المضخة باللتر في الدقيقة؛ تُحسب منه كمية المياه التقديرية (لا يوجد حساس تدفق).
  pumpFlowLpm: num('PUMP_FLOW_LPM', 2.0),

  // إعدادات محرك القرار، تُرسل إلى ESP32 #2 مع كل استطلاع (poll)، فيمكن ضبط قواعد القرار
  // دون إعادة برمجة اللوحة.
  engine: {
    // أقصى مدة لتأجيل الري بسبب توقع المطر (MAX_DEFER_HOURS بالساعات، تُحوَّل إلى ثوانٍ).
    max_defer_s: num('MAX_DEFER_HOURS', 3) * 3600,
    // هامش (hysteresis) لمنع التذبذب: التأجيل القائم لا ينتهي إلا إذا نزل الاحتمال تحت (العتبة − هذا الهامش).
    defer_hysteresis: num('DEFER_HYSTERESIS', 0.03),
    // زمن التشرّب (soak) بالثواني بعد كل نبضة، حتى يصل الماء إلى الحساس قبل الحكم على المنطقة من جديد.
    soak_s: num('SOAK_SECONDS', 120),
    // أقصى عدد نبضات متتالية دون بلوغ الرطوبة المستهدفة؛ بعدها تتوقف المنطقة مؤقتًا
    // (احتمال حساس عالق أو موضوع في مكان خاطئ).
    max_pulses: num('MAX_PULSES', 3),
    // مدة إيقاف المنطقة بعد استنفاد النبضات (PULSE_LOCK_MINUTES بالدقائق، تُحوَّل إلى ثوانٍ).
    pulse_lock_s: num('PULSE_LOCK_MINUTES', 30) * 60,
    // أقصى مدة بالثواني للنبضة التكميلية (closed-loop)؛ هذه النبضات صغيرة عمدًا.
    followup_max_s: num('FOLLOWUP_MAX_SECONDS', 10),
    // أقصى مجموع ثوانٍ للري في اليوم لكل منطقة.
    daily_max_s: num('DAILY_MAX_SECONDS_PER_ZONE', 300),
    // أقصى مدة تشغيل للمضخة في النبضة الواحدة، بالثواني.
    max_s: num('MAX_PUMP_ON_SECONDS', 60),
    // تدفق المضخة باللتر في الدقيقة (لحساب اللترات على اللوحة).
    pump_flow_lpm: num('PUMP_FLOW_LPM', 2.0),
    // أقصى نسبة لتقليل كمية الماء كلما اقترب احتمال المطر من العتبة (0 = معطّل افتراضيًا لأنه غير مُختبر؛
    // مثلًا 0.3 = حتى 30% ماء أقل).
    forecast_trim_max: num('FORECAST_TRIM_MAX', 0),
  },

  // بعد كم ثانية من آخر اتصال يُعدّ الجهاز غير متصل (offline)، لكل نوع جهاز.
  offlineAfterSeconds: { sensor: num('SENSOR_OFFLINE_S', 15), actuator: num('ACTUATOR_OFFLINE_S', 15) },
  // الفاصل بالمللي ثانية بين دورات الـ scheduler في الخلفية.
  schedulerTickMs: num('SCHEDULER_TICK_MS', 5000),
};

// يتحقق عند بدء التشغيل من وجود الإعدادات الإلزامية، ويوقف الخادم برسالة واضحة إن نقص شيء.
function assertConfig() {
  const missing = ['databaseUrl', 'deviceApiKey'].filter((k) => !config[k]);
  if (missing.length) throw new Error(`Missing configuration: ${missing.join(', ')} (see .env.example)`);
}

module.exports = { config, assertConfig };
