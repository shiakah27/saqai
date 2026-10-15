-- مخطط قاعدة بيانات SAQAI (schema v2) — أول ملف ترحيل، يطبقه backend/src/database/migrate.js مرة واحدة.
-- ESP32 #1 (عقدة الحساسات) تبث كل الحساسات لحظيًا. ESP32 #2 (عقدة المشغّلات) تتخذ القرار وتشغّل
-- صمامًا واحدًا في كل مرة. الـ backend يحفظ، ويتنبأ، ويطبق قفل المطر (lockout)، ويشرح.
-- كل الأوقات من نوع timestamptz (تُحفظ بتوقيت UTC).

-- الأجهزة المسجلة. الجهاز غير الموجود هنا يُرفض (403). last_seen_at يُحدَّث مع كل طلب، ومنه تُعرف حالة الاتصال.
CREATE TABLE devices (
  id             TEXT PRIMARY KEY,                                  -- مثل 'sensor_node_01'
  kind           TEXT NOT NULL CHECK (kind IN ('sensor', 'actuator')), -- نوع العقدة: حساسات أو مشغّلات
  last_seen_at   TIMESTAMPTZ,                                       -- آخر طلب وصل من الجهاز
  last_ip        TEXT,
  firmware       TEXT,
  rssi           INTEGER,                                           -- قوة إشارة Wi-Fi بالـ dBm
  uptime_s       BIGINT,                                            -- مدة تشغيل اللوحة منذ آخر إقلاع بالثواني
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- إعدادات المناطق. تستلمها ESP32 #2 مع كل استطلاع، فتُطبَّق تعديلات المعايرة دون إعادة برمجة اللوحة.
CREATE TABLE zones (
  id                   SMALLINT PRIMARY KEY,
  name                 TEXT NOT NULL,
  plant_type           TEXT NOT NULL,
  area_m2              NUMERIC(6,2),                                -- المساحة بالمتر المربع
  -- الرطوبة المستهدفة %، والحد الحرج % (تحته ري عاجل)، وثوانٍ لرفع الرطوبة 1% (من المعايرة).
  target_moisture      NUMERIC(5,2) NOT NULL CHECK (target_moisture BETWEEN 0 AND 100),
  critical_moisture    NUMERIC(5,2) NOT NULL CHECK (critical_moisture BETWEEN 0 AND 100),
  seconds_per_percent  NUMERIC(6,2) NOT NULL CHECK (seconds_per_percent > 0),
  enabled              BOOLEAN NOT NULL DEFAULT TRUE,
  -- الحد الحرج يجب أن يكون أقل من الهدف (خرق هذا القيد يعيد الخطأ 23514 للـ API).
  CHECK (critical_moisture < target_moisture)
);

-- الطقس من عقدة الحساسات. القيم اللحظية تصل كل ~2 ثانية؛ ويُحفظ صف واحد في الدقيقة (يكفي لميزات
-- الذكاء الاصطناعي على مدى ساعة / 3 ساعات وللرسوم البيانية). بيانات التدريب لا توضع هنا أبدًا.
-- الحرارة °C، الرطوبة %، الضغط hPa، مستوى المطر 0..3. source = 'test' لقراءات الاختبار السابقة فقط.
CREATE TABLE weather_readings (
  id            BIGSERIAL PRIMARY KEY,
  device_id     TEXT NOT NULL REFERENCES devices(id),
  temperature   NUMERIC(5,2) NOT NULL,
  humidity      NUMERIC(5,2) NOT NULL,
  pressure      NUMERIC(7,2) NOT NULL,
  rain_detected BOOLEAN NOT NULL,
  rain_level    SMALLINT CHECK (rain_level BETWEEN 0 AND 3),
  source        TEXT NOT NULL DEFAULT 'device' CHECK (source IN ('device', 'test')),
  recorded_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX weather_readings_recorded_idx ON weather_readings (recorded_at DESC);

-- تحولات المطر (بدأ/توقف)، ترسلها عقدة الحساسات فورًا (بعد إزالة الارتداد debounce على الجهاز).
CREATE TABLE rain_events (
  id           BIGSERIAL PRIMARY KEY,
  device_id    TEXT NOT NULL REFERENCES devices(id),
  event_type   TEXT NOT NULL CHECK (event_type IN ('RAIN_STARTED', 'RAIN_STOPPED')),
  rain_level   SMALLINT,
  recorded_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX rain_events_recorded_idx ON rain_events (recorded_at DESC);

-- رطوبة التربة من عقدة الحساسات (تُحفظ كل 10 ثوانٍ؛ والقيم اللحظية كل ~2 ثانية).
-- valid = false يعني قراءة خارج المدى (حساس مفصول أو غير معاير)، وعندها soil_moisture = NULL.
-- raw_adc هي القيمة الخام من محول ESP32 (0..4095)، مفيدة للمعايرة والتشخيص.
CREATE TABLE soil_readings (
  id             BIGSERIAL PRIMARY KEY,
  device_id      TEXT NOT NULL REFERENCES devices(id),
  zone_id        SMALLINT NOT NULL REFERENCES zones(id),
  soil_moisture  NUMERIC(5,2),
  raw_adc        INTEGER,
  valid          BOOLEAN NOT NULL,
  source         TEXT NOT NULL DEFAULT 'device' CHECK (source IN ('device', 'test')),
  recorded_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX soil_readings_zone_recorded_idx ON soil_readings (zone_id, recorded_at DESC);

-- كل محاولة تنبؤ، بما فيها الفاشلة، حتى تكون الفجوات ظاهرة ومفسَّرة.
-- rain_probability و threshold بين 0 و 1؛ horizon_hours أفق التنبؤ بالساعات.
-- features: الميزات المحسوبة التي دخلت النموذج؛ drivers: العوامل الأكثر تأثيرًا (لشرح النتيجة).
CREATE TABLE rain_predictions (
  id                 BIGSERIAL PRIMARY KEY,
  rain_probability   NUMERIC(6,4),
  threshold          NUMERIC(6,4),
  horizon_hours      SMALLINT,
  model_version      TEXT,
  status             TEXT NOT NULL CHECK (status IN ('OK', 'INSUFFICIENT_HISTORY', 'AI_UNAVAILABLE', 'NO_WEATHER')),
  features           JSONB,
  drivers            JSONB,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX rain_predictions_created_idx ON rain_predictions (created_at DESC);

-- القرارات التي اتُّخذت على ESP32 #2 نفسها، كما أبلغت عنها. يُحفظ صف عندما يتغير قرار المنطقة
-- (وعلى الأقل كل 10 دقائق)، ومع كل صف الـ trace الكامل للقواعد التي فحصها الجهاز.
CREATE TABLE irrigation_decisions (
  id               BIGSERIAL PRIMARY KEY,
  device_id        TEXT NOT NULL REFERENCES devices(id),
  zone_id          SMALLINT NOT NULL REFERENCES zones(id),
  action           TEXT NOT NULL CHECK (action IN ('IRRIGATE', 'DEFER', 'SKIP', 'HOLD')),
  seconds          INTEGER NOT NULL DEFAULT 0,
  planned_seconds  INTEGER NOT NULL DEFAULT 0,
  est_liters       NUMERIC(6,2) NOT NULL DEFAULT 0,
  reason_code      TEXT NOT NULL,
  urgency          NUMERIC(6,3),
  chosen           BOOLEAN NOT NULL DEFAULT FALSE,     -- المنطقة الوحيدة التي اختارها الجهاز للري
  rain_probability NUMERIC(6,4),
  soil_moisture    NUMERIC(5,2),
  system_mode      TEXT NOT NULL,
  trace            JSONB NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX irrigation_decisions_zone_created_idx ON irrigation_decisions (zone_id, created_at DESC);

-- طلبات التشغيل اليدوي التجريبي من لوحة الصيانة في لوحة التحكم. تلتقطها ESP32 #2 في استطلاعها التالي.
-- command_id + expires_at: لا يمكن لطلب أن يُنفَّذ مرتين أو متأخرًا.
-- دورة الحالة: PENDING ← TAKEN (التقطته اللوحة) أو CANCELLED (مطر/استبدال) أو EXPIRED (انتهت صلاحيته).
CREATE TABLE manual_commands (
  id               BIGSERIAL PRIMARY KEY,
  command_id       TEXT NOT NULL UNIQUE,
  zone_id          SMALLINT NOT NULL REFERENCES zones(id),
  duration_seconds INTEGER NOT NULL CHECK (duration_seconds > 0),
  status           TEXT NOT NULL CHECK (status IN ('PENDING', 'TAKEN', 'CANCELLED', 'EXPIRED')),
  cancel_reason    TEXT,
  expires_at       TIMESTAMPTZ NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- كل نبضة نفذتها ESP32 #2 فعلًا (تلقائية أو يدوية). الثواني تُقاس على الجهاز؛ واللترات تقديرية
-- (لا يوجد حساس تدفق). run_id فريد، فتكرار التقرير نفسه لا يُنشئ صفًا ثانيًا.
CREATE TABLE irrigation_runs (
  id                BIGSERIAL PRIMARY KEY,
  run_id            TEXT NOT NULL UNIQUE,
  device_id         TEXT NOT NULL REFERENCES devices(id),
  zone_id           SMALLINT NOT NULL REFERENCES zones(id),
  kind              TEXT NOT NULL CHECK (kind IN ('auto', 'manual')),
  command_id        TEXT REFERENCES manual_commands(command_id),
  reason_code       TEXT,
  planned_seconds   INTEGER NOT NULL CHECK (planned_seconds > 0),
  actual_seconds    NUMERIC(6,1),
  est_liters        NUMERIC(6,2),
  status            TEXT NOT NULL CHECK (status IN ('ACTIVE', 'COMPLETED', 'CANCELLED', 'FAILED')),
  stop_reason       TEXT,
  started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at       TIMESTAMPTZ
);
CREATE INDEX irrigation_runs_zone_idx ON irrigation_runs (zone_id, started_at DESC);
-- مضخة واحدة: يمكن أن يكون تشغيل واحد فقط نشطًا (ACTIVE) في أي لحظة.
-- فهرس فريد جزئي على قيمة ثابتة (true) لكل الصفوف النشطة: أي محاولة لإدخال تشغيل نشط ثانٍ تفشل.
-- القيد في قاعدة البيانات نفسها يضمن ذلك حتى لو وصل طلبان في اللحظة نفسها أو كان في الكود خطأ.
CREATE UNIQUE INDEX irrigation_runs_one_active ON irrigation_runs ((true)) WHERE status = 'ACTIVE';

-- صف واحد بالضبط (CHECK id = 1) يحمل وضع النظام الحالي.
-- انتقالات الأمان تقفله (SELECT … FOR UPDATE) فلا يمكن أن تتسابق.
-- cooldown_until: نهاية فترة الانتظار بعد المطر؛ error_reason: سبب العطل (يبقى حتى يُمسح يدويًا).
CREATE TABLE system_state (
  id              SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  mode            TEXT NOT NULL CHECK (mode IN ('NORMAL', 'IRRIGATING', 'RAIN_LOCKOUT', 'COOLDOWN', 'ERROR')),
  since           TIMESTAMPTZ NOT NULL DEFAULT now(),
  cooldown_until  TIMESTAMPTZ,
  error_reason    TEXT,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- سجل أحداث النظام (الخط الزمني في لوحة التحكم): بدء المطر، بدء الري، رفض تشغيل، انقطاع جهاز...
-- details: تفاصيل الحدث كـ JSON؛ zone_id اختياري.
CREATE TABLE system_events (
  id          BIGSERIAL PRIMARY KEY,
  type        TEXT NOT NULL,
  zone_id     SMALLINT REFERENCES zones(id),
  details     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX system_events_created_idx ON system_events (created_at DESC);
