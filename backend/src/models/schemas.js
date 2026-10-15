/**
 * مخططات التحقق من الطلبات (zod schemas).
 * الحدود الفيزيائية ترفض قيم الحساسات المستحيلة من البداية، قبل أن تصل إلى قاعدة البيانات أو إلى القرار.
 * .strict() يعني رفض أي حقل غير متوقع (يكشف أخطاء البرمجة في الـ firmware مبكرًا).
 * تستخدمها routes/index.js عبر الـ middleware المسمى validate.
 */
const { z } = require('zod');

// معرّف الجهاز: حروف إنجليزية صغيرة وأرقام و _ فقط (مثل sensor_node_01).
const deviceId = z.string().min(3).max(64).regex(/^[a-z0-9_]+$/, 'lowercase letters, digits and _ only');
// طابع زمني اختياري بصيغة ISO مع المنطقة الزمنية (يُستخدم فقط في اختبار backfill).
const timestamp = z.string().datetime({ offset: true }).optional();
// معلومات تشخيصية اختيارية عن اللوحة: قوة إشارة Wi-Fi (RSSI) ومدة التشغيل بالثواني وإصدار الـ firmware.
const deviceInfo = {
  rssi: z.number().int().optional(),
  uptime_s: z.number().int().nonnegative().optional(),
  firmware: z.string().max(32).optional(),
};

// ESP32 #1، كل ~2 ثانية: كل ما تقيسه في إطار (frame) واحد.
// الحرارة بالدرجة المئوية، الرطوبة بالنسبة المئوية، الضغط بالهيكتوباسكال (hPa)، مستوى المطر 0..3.
const readings = z.object({
  device_id: deviceId,
  temperature: z.number().min(-20).max(60),
  humidity: z.number().min(0).max(100),
  pressure: z.number().min(850).max(1100, 'pressure must be in hPa (divide BME280 Pa by 100)'),
  rain_detected: z.boolean(),
  rain_level: z.number().int().min(0).max(3).optional(),
  // قراءة لكل منطقة: رطوبة التربة % وقيمة الـ ADC الخام (0..4095 في ESP32).
  soil: z.array(z.object({
    zone_id: z.number().int().positive(),
    // القيم خارج المدى تُحفظ على أنها غير صالحة (invalid) ولا تُستخدم أبدًا.
    soil_moisture: z.number().nullable(),
    raw_adc: z.number().int().min(0).max(4095).optional(),
  }).strict()).min(1).max(16),
  timestamp,
  ...deviceInfo,
}).strict();

// حدث المطر الفوري. الشرط الإضافي: rain_detected يجب أن يطابق نوع الحدث (true مع RAIN_STARTED).
const rainEvent = z.object({
  device_id: deviceId,
  event: z.enum(['RAIN_STARTED', 'RAIN_STOPPED']),
  rain_detected: z.boolean(),
  rain_level: z.number().int().min(0).max(3).optional(),
  timestamp,
}).strict().refine((b) => (b.event === 'RAIN_STARTED') === b.rain_detected, {
  message: 'rain_detected must be true for RAIN_STARTED and false for RAIN_STOPPED', path: ['rain_detected'],
});

// باراميترات الاستعلام في GET /api/actuator/inputs. تصل كنصوص في الرابط، لذا يُحوِّلها coerce إلى أرقام.
const actuatorQuery = z.object({
  device_id: deviceId,
  rssi: z.coerce.number().int().optional(),
  uptime_s: z.coerce.number().int().nonnegative().optional(),
  firmware: z.string().max(32).optional(),
});

// ESP32 #2: ما قررته لكل منطقة، مع الـ trace (القواعد التي فحصتها خطوة بخطوة).
// chosen_zone هي المنطقة الوحيدة المختارة للري الآن (أو null). المدد بالثواني، والكميات باللتر.
const decisions = z.object({
  device_id: deviceId,
  chosen_zone: z.number().int().positive().nullable(),
  zones: z.array(z.object({
    zone_id: z.number().int().positive(),
    action: z.enum(['IRRIGATE', 'DEFER', 'SKIP', 'HOLD']),
    seconds: z.number().int().min(0).max(3600),
    planned_seconds: z.number().int().min(0).max(3600).optional(),
    liters: z.number().min(0).max(100).optional(),
    planned_liters: z.number().min(0).max(100).optional(),
    reason: z.string().min(2).max(40),
    urgency: z.number().optional(),
    trace: z.array(z.object({ step: z.string().max(16), pass: z.boolean(), note: z.string().max(48) }).strict()).max(12).optional(),
  }).strict()).min(1).max(16),
}).strict();

// تقرير نبضة ري: نوعان يُميَّزان بالحقل event.
//  - started: بدأت النبضة (command_id موجود فقط إن كانت تشغيلًا يدويًا).
//  - finished: انتهت؛ ولا تُقبل إلا إذا أكدت اللوحة أن المضخة OFF والصمام CLOSED.
const run = z.discriminatedUnion('event', [
  z.object({
    event: z.literal('started'),
    device_id: deviceId,
    run_id: z.string().min(3).max(64),
    zone: z.number().int().positive(),
    planned_seconds: z.number().int().positive().max(3600),
    reason: z.string().max(40).optional(),
    command_id: z.string().max(80).optional(),
  }).strict(),
  z.object({
    event: z.literal('finished'),
    device_id: deviceId,
    run_id: z.string().min(3).max(64),
    zone: z.number().int().positive(),
    status: z.enum(['completed', 'cancelled', 'failed']),
    actual_seconds: z.number().min(0).max(3600),
    stop_reason: z.string().max(40).optional(),
    pump: z.literal('OFF', { errorMap: () => ({ message: 'a run is only reported finished once the pump is OFF' }) }),
    valve: z.literal('CLOSED'),
  }).strict(),
]);

// طلب تشغيل يدوي من لوحة الإدارة: المنطقة والمدة بالثواني (1..600، ثم تُقصّ إلى MAX_PUMP_ON_SECONDS).
const manualRun = z.object({ zone_id: z.number().int().positive(), seconds: z.number().min(1).max(600) }).strict();
// عدد ساعات السجل المطلوبة: من 1 إلى 168 (أسبوع)، والافتراضي 24.
const historyQuery = z.object({ hours: z.coerce.number().min(1).max(168).default(24) });
// تعديل إعدادات منطقة: كل الحقول اختيارية (رطوبة مستهدفة وحرجة %، ثوانٍ لكل 1% رطوبة، تفعيل، نوع النبات).
const zonePatch = z.object({
  target_moisture: z.number().min(5).max(80).optional(),
  critical_moisture: z.number().min(0).max(70).optional(),
  seconds_per_percent: z.number().positive().max(60).optional(),
  enabled: z.boolean().optional(),
  plant_type: z.string().min(1).max(60).optional(),
}).strict();

module.exports = { readings, rainEvent, actuatorQuery, decisions, run, manualRun, historyQuery, zonePatch };
