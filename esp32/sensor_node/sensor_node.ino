/*
 * سَقاي (SAQAI) — لوحة ESP32 رقم 1: عقدة الحساسات (Sensor node)
 * ----------------------------------------------------------------
 * ما هذا الملف:
 *   البرنامج الكامل للوحة ESP32 الأولى. مهمتها القراءة فقط: لا تشغّل مضخة ولا صمامًا ولا تتخذ قرار ري.
 *   تقرأ كل الحساسات لحظيًا وترسلها إلى الـbackend (خادم Node.js على اللابتوب):
 *     BME280  عبر I2C        درجة الحرارة والرطوبة الجوية والضغط الجوي
 *     MH-RD لوحة قطرات المطر  عبر موديول LM393: مخرج تماثلي AO (كمية البلل) ومخرج رقمي DO (مبلل/جاف)،
 *                            تُقرأ كل ثانية وتتحول إلى مستوى مطر من 0 إلى 3
 *     3 حساسات رطوبة تربة سعوية (capacitive) على ADC1، حساس لكل منطقة (zone)
 *
 * ما ترسله إلى الـbackend:
 *   كل 2 ثانية     POST /api/readings     إطار (frame) واحد فيه كل القيم؛ الـbackend يحفظ "القيمة الحالية"
 *                                         ويخزّن السجل التاريخي
 *   عند التغيّر    POST /api/rain-event   فورًا عند بدء المطر أو توقفه (بعد التأكد/debounce)،
 *                                         ويُعاد الإرسال حتى يقبله الـbackend
 *
 * علاقته ببقية النظام:
 *   الـbackend يجمع هذه القراءات مع توقع المطر (نموذج الذكاء الاصطناعي) وإعدادات المناطق، ثم لوحة
 *   ESP32 رقم 2 (actuator_node) تسحب هذه المدخلات كل ثانية وتقرر بنفسها هل تسقي أم لا.
 *   لا يوجد اتصال مباشر بين اللوحتين؛ كل شيء يمر عبر الـbackend.
 *
 * اللوحة في Arduino IDE: "ESP32 Dev Module" (نواة arduino-esp32 الإصدار 3.x)
 * المكتبات: Adafruit BME280 Library (ومعها Unified Sensor وBusIO)، وArduinoJson (الإصدار 7)
 *
 * التوصيل (التفاصيل في docs/hardware.md):
 *   BME280   VIN→3V3  GND→GND  SDA→GPIO21  SCL→GPIO22        (العنوان 0x76 أو 0x77)
 *   MH-RD    اللوحة→الموديول بسلكين (بأي اتجاه)
 *            الموديول: VCC→3V3 (وليس 5V!)  GND→GND  AO→GPIO35  DO→GPIO16
 *            مقاومة 100kΩ بين AO وGND (يُنصح بها): لو انفصل سلك AO تُقرأ 0 = "مبلل" فيتوقف الري (آمن)
 *   التربة 1 AOUT→GPIO32   التربة 2 AOUT→GPIO33   التربة 3 AOUT→GPIO34   VCC→3V3  GND→GND
 *            أطراف ADC1 فقط: أطراف ADC2 تتوقف عن العمل ما دام Wi-Fi شغالًا.
 *
 * كيف يعمل MH-RD:
 *   اللوحة خطوط نحاسية متداخلة غير متلامسة. الماء يوصل بينها فتقل مقاومتها، فينخفض جهد AO:
 *   لوحة جافة ≈ 4095 (أعلى قراءة)، وكلما زاد الماء نزلت القراءة. شريحة LM393 تقارن الجهد بحد
 *   يُضبط بالمقاومة المتغيرة (البرغي الأزرق): إذا تعداه يصبح DO = LOW ويضيء LED الموديول.
 *   نستخدم الاثنين معًا: AO لمعرفة كمية البلل (المستوى 0..3)، وDO كتأكيد من العتاد.
 */
#include <WiFi.h>
#include <HTTPClient.h>
#include <Wire.h>
#include <Adafruit_Sensor.h>
#include <Adafruit_BME280.h>
#include <ArduinoJson.h>
#include <esp_task_wdt.h>
// secrets.h فيه اسم الشبكة وكلمة مرورها وعنوان الـbackend ومفتاح الأجهزة (انظر secrets.example.h)
#include "secrets.h"

// اسم هذه اللوحة كما يعرفها الـbackend، ورقم إصدار البرنامج (يُرسل مع كل إطار)
#define DEVICE_ID  "sensor_node_01"
#define FIRMWARE   "sn-2.1.0"

// ---- التوقيتات (كلها بالميلي ثانية ما لم يُذكر غير ذلك) ----
// كل 2000 ms (ثانيتان) يُرسل إطار كامل: هذا هو البث اللحظي
const uint32_t FRAME_PERIOD_MS   = 2000;
// كل 1000 ms (ثانية) تُقرأ لوحة المطر
const uint32_t RAIN_POLL_MS      = 1000;
// 3 إجابات "مبلل" متتالية (≈3 ثوانٍ) = بدأ المطر؛ يمنع قطرة عابرة من إيقاف الري
const uint8_t  WET_CONFIRM_READS = 3;
// جاف 5 دقائق متواصلة = توقف المطر؛ مدة أطول من البدء لأن إعلان "توقف" مبكرًا أخطر من التأخر
// const uint32_t DRY_CONFIRM_MS    = 5UL * 60UL * 1000UL;
   const uint32_t DRY_CONFIRM_MS    = 30UL * 1000UL;
// إذا فشل إرسال حدث المطر، يُعاد كل 1000 ms حتى يُقبل
const uint32_t EVENT_RETRY_MS    = 1000;
// الـwatchdog: إذا علق البرنامج 30 ثانية تُعاد تشغيل اللوحة تلقائيًا
const uint32_t WDT_TIMEOUT_S     = 30;

// ---- الأطراف (pins) ----
// موديول المطر: AO على GPIO35 (من ADC1، دخل فقط) وDO على GPIO16 (دخل رقمي)
const int RAIN_AO_PIN = 36, RAIN_DO_PIN = 27;
// أطراف حساسات التربة للمناطق 1 و2 و3؛ كلها من ADC1 لأن ADC2 لا يعمل مع Wi-Fi
const int SOIL_PIN[3] = {32, 35, 34};

// ---- معايرة حساسات التربة (docs/calibration.md: قراءة ADC الخام في الهواء الجاف وفي الماء) ----
// SOIL_DRY_RAW: القراءة الخام (من 0 إلى 4095) والحساس في هواء جاف = رطوبة 0%
// SOIL_WET_RAW: القراءة الخام والحساس مغموس في الماء = رطوبة 100%
// كل حساس له قيمه الخاصة بعد المعايرة؛ هذه قيم ابتدائية تقريبية
int SOIL_DRY_RAW[3] = {2900, 2900, 2900};
int SOIL_WET_RAW[3] = {1300, 1300, 1300};
// أي قراءة خارج المدى 300..3800 تعني أن الحساس مفصول أو فيه قصر (short)، فتُعتبر غير صالحة
const int SOIL_MIN_VALID_RAW = 300;
const int SOIL_MAX_VALID_RAW = 3800;

// ---- معايرة لوحة المطر MH-RD (docs/calibration.md) ----
// RAIN_DRY_RAW: قراءة AO واللوحة جافة ونظيفة (عادة قريبة من 4095)
// RAIN_WET_RAW: قراءة AO واللوحة مغطاة بالماء (رشّة كاملة) = بلل 100%
int RAIN_DRY_RAW = 4095;
int RAIN_WET_RAW = 1500;
// حدود البلل (نسبة مئوية) لكل مستوى: أقل من 15% = 0 جاف، 15% = 1 خفيف، 40% = 2 متوسط، 70% = 3 غزير.
// 15% وليس أعلى حتى تكفي قطرات قليلة لإيقاف الري؛ وليس أقل حتى لا تُحسب الرطوبة الجوية أو الغبار مطرًا.
const float RAIN_LEVEL_PCT[3] = {15.0f, 40.0f, 70.0f};
// قراءة AO أقل من هذا مع DO "جاف" لمدة 10 ثوانٍ = غالبًا سلك AO مفصول (المقاومة 100kΩ سحبته إلى 0).
// النظام يعتبرها "مطر" على أي حال (آمن)، وهذا فقط لطباعة تنبيه في Serial Monitor.
const int RAIN_AO_STUCK_LOW = 50;

// تعريف مسبق للدوال (forward declarations): البرنامج لا يعتمد على توليد Arduino التلقائي للتعريفات
int rainReadLevel();
void updateRain(int level);
int postJson(const char *path, JsonDocument &doc);
void sendRainEvent();
void sendFrame();
int readSoilRaw(int pin);
float soilPercent(int i, int raw);
void connectWiFi();
void setupWatchdog();

// كائن حساس BME280، وهل تم العثور عليه
Adafruit_BME280 bme;
bool bmeOk = false;

// ---- حالة المطر ----
// raining: الحالة المؤكدة (بعد debounce)، rainLevel: آخر مستوى محسوب (0..3)
// rainRaw: آخر قراءة AO (للمعايرة)، rainWetPct: نسبة البلل، rainDoWet: هل DO يقول "مبلل"
// wetStreak: عدد القراءات "المبللة" المتتالية، dryStartedAt: متى بدأ الجفاف (0 = لم يبدأ)
// stuckLowSince: منذ متى AO عند الصفر وDO جاف (لتنبيه سلك مفصول)
bool     raining = false;
uint8_t  rainLevel = 0;
int      rainRaw = 0;
float    rainWetPct = 0;
bool     rainDoWet = false;
uint8_t  wetStreak = 0;
uint32_t dryStartedAt = 0;
uint32_t stuckLowSince = 0;

// حدث مطر لم يقبله الـbackend بعد (eventPending) ونوعه (eventRain: true = بدأ، false = توقف)
bool     eventPending = false, eventRain = false;
// أوقات آخر محاولة إرسال حدث، وآخر إطار، وآخر سؤال لحساس المطر (لجدولة المهام بدون delay طويل)
uint32_t lastEventTry = 0;
uint32_t lastFrame = 0, lastRainPoll = 0;

// ---------------------------------------------------------------- MH-RD (لوحة المطر)

// قراءة لوحة المطر وتحويلها إلى مستوى 0..3:
//   1. متوسط 16 قراءة من AO (لتقليل التشويش) ← rainRaw
//   2. نسبة البلل = كم نزلت القراءة من "جاف" نحو "مبلل" حسب المعايرة ← rainWetPct
//   3. المستوى حسب حدود RAIN_LEVEL_PCT
//   4. إذا قال DO "مبلل" (LOW) والمستوى 0، يُرفع إلى 1: يكفي أن يرى أحد المخرجين ماءً لإيقاف الري
// تُرجع دائمًا مستوى (لا توجد حالة "لا رد" كما في الحساسات الرقمية).
int rainReadLevel() {
  long sum = 0;
  for (int i = 0; i < 16; i++) { sum += analogRead(RAIN_AO_PIN); delayMicroseconds(200); }
  rainRaw = sum / 16;
  // DO من الموديول: LOW = الجهد تحت حد البرغي الأزرق = مبلل
  rainDoWet = digitalRead(RAIN_DO_PIN) == LOW;

  float span = (float)(RAIN_DRY_RAW - RAIN_WET_RAW);
  float pct = span > 0 ? 100.0f * (RAIN_DRY_RAW - rainRaw) / span : 0;
  rainWetPct = constrain(pct, 0.0f, 100.0f);

  int level = 0;
  for (int i = 0; i < 3; i++) if (rainWetPct >= RAIN_LEVEL_PCT[i]) level = i + 1;
  if (rainDoWet && level == 0) level = 1;

  // تنبيه تشخيصي فقط: AO عند الصفر تقريبًا لكن DO يقول جاف لمدة 10 ثوانٍ = غالبًا سلك AO مفصول.
  // القراءة 0 تعني "مبلل 100%" فالنظام آمن أصلًا (يوقف الري)؛ الرسالة لتعرف السبب.
  if (rainRaw < RAIN_AO_STUCK_LOW && !rainDoWet) {
    if (!stuckLowSince) stuckLowSince = millis();
    else if (millis() - stuckLowSince > 10000UL) {
      Serial.println("[rain] AO reads ~0 but DO says dry: check the AO wire (treated as RAIN, safe)");
      stuckLowSince = millis();
    }
  } else stuckLowSince = 0;
  return level;
}

// تحديث حالة المطر المؤكدة مع debounce:
//   بدء المطر يحتاج WET_CONFIRM_READS قراءات مبللة متتالية (≈3 ثوانٍ، قراءة كل ثانية)
//   توقف المطر يحتاج جفافًا متواصلًا لمدة DRY_CONFIRM_MS (5 دقائق)
// عند تغيّر الحالة يُرسل حدث مطر فورًا إلى الـbackend.
void updateRain(int level) {
  // لا توجد قراءة جديدة: لا تغيير
  if (level < 0) return;
  rainLevel = (uint8_t)level;
  if (level >= 1) {
    // أي بلل يلغي مؤقت الجفاف
    dryStartedAt = 0;
    if (!raining && ++wetStreak >= WET_CONFIRM_READS) {
      raining = true; wetStreak = 0;
      eventPending = true; eventRain = true;
      // يُرسل فورًا: عقدة التشغيل (ESP32 رقم 2) توقف المضخة خلال ثانية واحدة
      sendRainEvent();
    }
  } else {
    wetStreak = 0;
    if (raining) {
      // بدء عدّ مدة الجفاف عند أول قراءة جافة
      if (!dryStartedAt) dryStartedAt = millis();
      if (millis() - dryStartedAt >= DRY_CONFIRM_MS) {
        raining = false; dryStartedAt = 0;
        eventPending = true; eventRain = false;
        sendRainEvent();
      }
    }
  }
}

// ---------------------------------------------------------------- التربة

// قراءة خام لحساس التربة: متوسط 16 قراءة ADC بفاصل 200 µs لتقليل التشويش.
int readSoilRaw(int pin) {
  long sum = 0;
  for (int i = 0; i < 16; i++) { sum += analogRead(pin); delayMicroseconds(200); }
  return sum / 16;
}

// تحويل القراءة الخام إلى نسبة رطوبة 0..100% باستخدام معايرة الحساس رقم i.
// الحساس السعوي معكوس: كلما زادت القراءة الخام كانت التربة أجف.
// تُرجع -1 إذا كانت القراءة خارج المدى الصالح (حساس مفصول أو فيه قصر).
float soilPercent(int i, int raw) {
  if (raw < SOIL_MIN_VALID_RAW || raw > SOIL_MAX_VALID_RAW) return -1;
  float pct = 100.0f * (SOIL_DRY_RAW[i] - raw) / (float)(SOIL_DRY_RAW[i] - SOIL_WET_RAW[i]);
  return constrain(pct, 0.0f, 100.0f);
}

// ---------------------------------------------------------------- HTTP

// عميل HTTP واحد مشترك بين كل الطلبات
HTTPClient http;

// إرسال مستند JSON بطلب POST إلى مسار في الـbackend مع مفتاح الأجهزة (x-api-key).
// تُرجع رمز HTTP (مثل 201 = تم الحفظ)، أو -1 إذا كان Wi-Fi غير متصل، أو رقمًا سالبًا عند خطأ الاتصال.
// المهلة 1.5 ثانية حتى لا يتأخر البث اللحظي إذا تعطل الخادم.
int postJson(const char *path, JsonDocument &doc) {
  if (WiFi.status() != WL_CONNECTED) return -1;
  http.begin(String(BACKEND_URL) + path);
  // إبقاء الاتصال مفتوحًا بين الإطارات (أسرع من فتح اتصال جديد كل مرة)
  http.setReuse(true);
  http.setTimeout(1500);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("x-api-key", DEVICE_API_KEY);
  String body;
  serializeJson(doc, body);
  int code = http.POST(body);
  http.end();
  return code;
}

// إرسال حدث المطر الحالي (RAIN_STARTED أو RAIN_STOPPED) إلى /api/rain-event.
// لا يُلغى "الحدث المعلّق" إلا إذا رد الـbackend بـ201؛ وإلا تعيد loop() المحاولة كل EVENT_RETRY_MS.
void sendRainEvent() {
  JsonDocument doc;
  doc["device_id"] = DEVICE_ID;
  doc["event"] = eventRain ? "RAIN_STARTED" : "RAIN_STOPPED";
  doc["rain_detected"] = eventRain;
  doc["rain_level"] = rainLevel;
  int code = postJson("/api/rain-event", doc);
  lastEventTry = millis();
  Serial.printf("[rain-event] %s → HTTP %d\n", eventRain ? "RAIN_STARTED" : "RAIN_STOPPED", code);
  if (code == 201) eventPending = false;
}

// بناء الإطار اللحظي وإرساله إلى /api/readings:
// الطقس من BME280 + حالة المطر + رطوبة التربة للمناطق الثلاث + معلومات اللوحة (قوة الإشارة، مدة التشغيل، الإصدار).
// إذا كان BME280 غير موجود أو قراءته غير منطقية لا يُرسل أي إطار.
void sendFrame() {
  // محاولة العثور على BME280 من جديد في كل إطار إذا كان قد فُصل (العنوان 0x76 ثم 0x77)
  if (!bmeOk) bmeOk = bme.begin(0x76) || bme.begin(0x77);
  if (!bmeOk) { Serial.println("[bme280] not found — no frame sent (check SDA 21 / SCL 22)"); return; }
  // الوضع القسري (forced mode): قياس واحد عند الطلب فقط، فلا يسخن الحساس نفسه من القياس المستمر
  bme.takeForcedMeasurement();
  float t = bme.readTemperature();
  float h = bme.readHumidity();
  // التحويل من Pa إلى hPa (الـbackend يرفض القيم بوحدة Pa)
  float p = bme.readPressure() / 100.0F;
  // قيمة NaN أو ضغط خارج 850..1100 hPa يعني قراءة غير منطقية: يُعاد البحث عن الحساس في الإطار التالي
  if (isnan(t) || isnan(h) || isnan(p) || p < 850 || p > 1100) { Serial.println("[bme280] implausible reading"); bmeOk = false; return; }

  // القيم تُقرّب إلى منزلة عشرية واحدة
  JsonDocument doc;
  doc["device_id"] = DEVICE_ID;
  doc["temperature"] = roundf(t * 10) / 10;
  doc["humidity"] = roundf(h * 10) / 10;
  doc["pressure"] = roundf(p * 10) / 10;
  // حالة المطر المؤكدة (بعد debounce) ومستواه الحالي 0..3
  doc["rain_detected"] = raining;
  doc["rain_level"] = rainLevel;
  // مصفوفة التربة: عنصر لكل منطقة فيه النسبة المئوية (أو null إذا كانت القراءة غير صالحة) والقراءة الخام
  JsonArray soil = doc["soil"].to<JsonArray>();
  for (int i = 0; i < 3; i++) {
    int raw = readSoilRaw(SOIL_PIN[i]);
    float pct = soilPercent(i, raw);
    JsonObject z = soil.add<JsonObject>();
    z["zone_id"] = i + 1;
    if (pct < 0) z["soil_moisture"] = nullptr; else z["soil_moisture"] = roundf(pct * 10) / 10;
    z["raw_adc"] = raw;
  }
  doc["rssi"] = WiFi.RSSI();
  doc["uptime_s"] = millis() / 1000;
  doc["firmware"] = FIRMWARE;
  int code = postJson("/api/readings", doc);
  static uint32_t n = 0;
  // الطباعة على Serial كل 15 إطارًا (كل 30 ثانية)، أو فورًا عند أي مشكلة (رد غير 201)
  if (code != 201 || ++n % 15 == 0) {
    String s;
    // مثال الناتج: "31.2%(2410) 44.0%(2050) --(4095)": النسبة والقراءة الخام لكل منطقة
    for (int i = 0; i < 3; i++) {
      if (i) s += ' ';
      s += soil[i]["soil_moisture"].isNull() ? String("--") : String((float)soil[i]["soil_moisture"], 1) + "%";
      s += "(" + String((int)soil[i]["raw_adc"]) + ")";
    }
    // rain=الحالة المؤكدة L=المستوى، ثم قراءة AO الخام ونسبة البلل وحالة DO (للمعايرة)
    Serial.printf("[frame] %.1f°C %.0f%% %.1fhPa rain=%d L%u (AO %d, wet %.0f%%, DO %s) soil %s → HTTP %d\n",
                  t, h, p, raining, rainLevel, rainRaw, rainWetPct, rainDoWet ? "WET" : "dry", s.c_str(), code);
  }
}

// ---------------------------------------------------------------- الإعداد والحلقة الرئيسية (setup / loop)

// الاتصال بشبكة Wi-Fi (وضع STA = عميل) مع إعادة الاتصال التلقائي.
// ينتظر حتى 10 ثوانٍ (40 × 250 ms) ثم يكمل حتى لو لم يتصل؛ loop() تعيد المحاولة لاحقًا.
// إعادة ضبط الـwatchdog أثناء الانتظار تمنع إعادة تشغيل اللوحة بالخطأ.
void connectWiFi() {
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.printf("[wifi] connecting to %s", WIFI_SSID);
  for (int i = 0; i < 40 && WiFi.status() != WL_CONNECTED; i++) { delay(250); Serial.print('.'); esp_task_wdt_reset(); }
  Serial.printf("\n[wifi] %s, IP %s\n", WiFi.status() == WL_CONNECTED ? "connected" : "NOT connected (retrying)", WiFi.localIP().toString().c_str());
}

// تفعيل الـwatchdog: إذا لم تُستدعَ esp_task_wdt_reset() خلال WDT_TIMEOUT_S ثانية تُعاد تشغيل اللوحة.
// الشرط #if لأن طريقة الإعداد تغيّرت في نواة arduino-esp32 الإصدار 3 عن الإصدارات الأقدم.
void setupWatchdog() {
#if ESP_ARDUINO_VERSION_MAJOR >= 3
  esp_task_wdt_config_t cfg = { .timeout_ms = WDT_TIMEOUT_S * 1000, .idle_core_mask = 0, .trigger_panic = true };
  esp_task_wdt_reconfigure(&cfg);
#else
  esp_task_wdt_init(WDT_TIMEOUT_S, true);
#endif
  esp_task_wdt_add(NULL);
}

// setup(): تعمل مرة واحدة عند التشغيل:
// Serial، ثم الـwatchdog، ثم BME280، ثم ADC (التربة ولوحة المطر)، ثم Wi-Fi.
void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println("\nSAQAI sensor node " FIRMWARE);
  setupWatchdog();

  // I2C على SDA=GPIO21 وSCL=GPIO22؛ ضبط BME280 على الوضع القسري بعيّنة واحدة وبدون فلتر
  Wire.begin(21, 22);
  bmeOk = bme.begin(0x76) || bme.begin(0x77);
  if (bmeOk) bme.setSampling(Adafruit_BME280::MODE_FORCED, Adafruit_BME280::SAMPLING_X1, Adafruit_BME280::SAMPLING_X1,
                             Adafruit_BME280::SAMPLING_X1, Adafruit_BME280::FILTER_OFF);
  Serial.printf("[bme280] %s\n", bmeOk ? "ok" : "NOT FOUND — check wiring/address");

  // دقة ADC بعرض 12 بت (0..4095)، وتوهين 11dB ليقيس الطرف جهدًا حتى ≈3.3V (كامل مدى خرج الحساس)
  analogReadResolution(12);
  for (int i = 0; i < 3; i++) analogSetPinAttenuation(SOIL_PIN[i], ADC_11db);
  analogSetPinAttenuation(RAIN_AO_PIN, ADC_11db);
  // DO: سحب داخلي لأعلى، فإذا انفصل سلك DO يُقرأ HIGH = جاف، ويبقى AO هو المرجع
  pinMode(RAIN_DO_PIN, INPUT_PULLUP);
  // قراءة أولى للطباعة: تساعد على التأكد من التوصيل والمعايرة من أول تشغيل
  rainReadLevel();
  Serial.printf("[rain] MH-RD AO=%d (dry≈%d wet≈%d) DO=%s\n", rainRaw, RAIN_DRY_RAW, RAIN_WET_RAW, rainDoWet ? "WET" : "dry");

  connectWiFi();
}

// loop(): حلقة غير حاجبة (non-blocking): كل مهمة لها مؤقت خاص بها بواسطة millis().
void loop() {
  // إبلاغ الـwatchdog أن البرنامج ما زال يعمل
  esp_task_wdt_reset();
  uint32_t now = millis();

  // إذا انقطع Wi-Fi: محاولة إعادة اتصال كل 10 ثوانٍ
  if (WiFi.status() != WL_CONNECTED) { static uint32_t lastTry = 0; if (now - lastTry > 10000) { lastTry = now; WiFi.reconnect(); } }

  // قراءة لوحة المطر كل ثانية وتحديث الحالة المؤكدة (debounce)
  if (now - lastRainPoll >= RAIN_POLL_MS) { lastRainPoll = now; updateRain(rainReadLevel()); }

  // إعادة إرسال حدث المطر المعلّق، ثم إرسال الإطار الدوري كل ثانيتين
  if (eventPending && now - lastEventTry >= EVENT_RETRY_MS) sendRainEvent();
  if (now - lastFrame >= FRAME_PERIOD_MS) { lastFrame = now; sendFrame(); }
  delay(5);
}
