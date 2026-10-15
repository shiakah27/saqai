/*
 * سَقاي (SAQAI) — لوحة ESP32 رقم 2: عقدة التشغيل (Actuator node): تقرر وتسقي.
 * ---------------------------------------------------------------------------
 * ما هذا الملف:
 *   البرنامج الكامل للوحة ESP32 الثانية التي تتحكم في المضخة والصمامات الثلاثة عبر وحدة relay.
 *
 * علاقته ببقية النظام:
 *   كل ثانية تطلب اللوحة من الـbackend المدخلات (GET /api/actuator/inputs): رطوبة التربة والمطر اللحظية
 *   القادمة من ESP32 رقم 1، وآخر احتمال مطر من نموذج الذكاء الاصطناعي، وإعدادات المناطق، وحالة الأمان.
 *   ثم تقرر على اللوحة نفسها (ON THE DEVICE) باستخدام saqai_decision.h:
 *
 *   لكل منطقة   ← IRRIGATE / DEFER / SKIP / HOLD + عدد الثواني + السبب (trace بالقواعد المفحوصة)
 *   تختار واحدة ← المنطقة الأحوج إلى الماء. مضخة واحدة، لذلك لا يُفتح إلا صمام واحد في أي وقت.
 *   وتُبلغ الـbackend بقراراتها (POST /api/actuator/decisions) وبكل تشغيل (POST /api/actuator/run).
 *
 * تسلسل النبضة (pulse):
 *   إبلاغ "started" (قد يرفض الـbackend: مطر) ← فتح الصمام ← تشغيل المضخة ← … ←
 *   إيقاف المضخة ← إغلاق الصمام ← إبلاغ "finished" ← انتظار التشرّب (soak) ← قرار جديد بقراءة تربة حديثة
 *
 * المضخة تتوقف فورًا إذا حدث أي مما يلي عند أي سحب (poll):
 *   رُصد مطر، أو الـbackend في حالة RAIN_LOCKOUT / COOLDOWN / ERROR    ← RAIN_OVERRIDE / SAFETY_STATE
 *   رطوبة المنطقة المسقية بلغت الهدف + 2% (حلقة مغلقة لحظية)          ← completed، TARGET_REACHED
 *   بيانات الحساسات قديمة (ESP32 رقم 1 صامت أكثر من 10 ثوانٍ)          ← SENSORS_STALE
 *   فشل 3 سحوبات متتالية (الـbackend أو Wi-Fi متوقف، ≈3 ثوانٍ)         ← BACKEND_UNREACHABLE
 *   مرّت LOCAL_MAX_ON_S ثانية، مهما قال أي أمر أو إعداد              ← LOCAL_MAX_ON_TIME
 *
 * اللوحة: "ESP32 Dev Module". المكتبة: ArduinoJson (الإصدار 7)
 * التوصيل (docs/hardware.md): Relay IN1 المضخة ← GPIO22 · IN2 الصمام 1 ← GPIO21 · IN3 الصمام 2 ← GPIO19
 *   · IN4 الصمام 3 ← GPIO4
 * المضخة والصمامات موصولة على نقاط NO (Normally Open) في الـrelay: إذا انقطعت كهرباء ESP32 أو تعطلت
 *   تُفصل المضخة والصمامات تلقائيًا (fail-safe). نقاط NC ممنوعة لأنها تشغّل المضخة لو توقفت اللوحة.
 */
#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <esp_task_wdt.h>
#include <esp_random.h>
// محرك القرار (نفس الملف الذي يُختبر على الكمبيوتر)
#include "saqai_decision.h"
// secrets.h فيه اسم الشبكة وكلمة مرورها وعنوان الـbackend ومفتاح الأجهزة (انظر secrets.example.h)
#include "secrets.h"

// اسم هذه اللوحة عند الـbackend، ورقم إصدار البرنامج، وعدد المناطق (3)
#define DEVICE_ID  "actuator_node_01"
#define FIRMWARE   "an-2.0.0"
#define N_ZONES    3

// ---- المرحلات (relays) ----
// وحدة الـrelay عندنا Active HIGH: تعمل (ON) عندما يكون طرف IN بمستوى HIGH، وتبقى مطفأة على LOW.
// لذلك false: وقت الراحة كل الأطراف LOW (المضخة والصمامات مطفأة)، وعند الفتح يصير الطرف HIGH.
// (لو كانت الوحدة Active LOW، أي كل شيء يشتغل عند الإقلاع، غيّرها إلى true)
const bool RELAY_ACTIVE_LOW = false;
// طرف المضخة
const int  PUMP_PIN = 22;
// أطراف الصمامات: المنطقة 1، 2، 3
const int  VALVE_PIN[N_ZONES] = {21, 19, 4};

// ---- التوقيتات والحدود المحلية (مستقلة عن الـbackend؛ تحمي حتى لو أرسل الخادم قيمًا خاطئة) ----
// سحب المدخلات من الـbackend كل 1000 ms (ثانية)
const uint32_t POLL_MS = 1000;
// بعد 3 سحوبات فاشلة متتالية يُعتبر الـbackend غير متاح وتُوقف المضخة
const uint8_t  MAX_FAILED_POLLS = 3;
// أقصى مدة لتشغيل المضخة في النبضة الواحدة: 60 ثانية، لا يمكن لأي أمر أو إعداد تجاوزها
const uint32_t LOCAL_MAX_ON_S = 60;
// 300 ms بين الصمام والمضخة: يُفتح الصمام قبل المضخة حتى لا تضخ المضخة ضد صمام مغلق (dead-heading)
const uint32_t VALVE_SETTLE_MS = 300;
// أساس فترة إعادة إرسال القرارات (5000 ms)؛ الإرسال الفعلي عند التغيّر أو كل 6 × 5 = 30 ثانية
const uint32_t DECISION_REPORT_MS = 5000;
// إيقاف مبكر إذا صارت رطوبة المنطقة فوق الهدف بهذا المقدار (2%)
const float    TARGET_STOP_MARGIN = 2.0f;
// الـwatchdog: إذا علق البرنامج 30 ثانية تُعاد تشغيل اللوحة (وsetup() تطفئ كل شيء)
const uint32_t WDT_TIMEOUT_S = 30;

using namespace saqai;

// تعريف مسبق للدوال (forward declarations): البرنامج لا يعتمد على توليد Arduino التلقائي للتعريفات
void relay(int pin, bool on);
void allOff();
bool pollInputs();
void evaluateAndMaybeStart();
bool reportStarted(const char *reason, const char *commandId);
void stopRun(const char *status, const char *reason);
void flushFinished();
void reportDecisions(const ZoneDecision *ds, int chosen);
int  httpGet(const String &path, String &resp);
int  httpPost(const char *path, const String &body, String &resp);
void setupWatchdog();
void superviseRun(bool polled);
void setup();
void loop();

// ---- الحالة (state) ----
// cfg: إعدادات المحرك، in: المدخلات العامة، zones: مدخلات كل منطقة، mem: ذاكرة كل منطقة بين التقييمات
Config     cfg;
Inputs     in;
ZoneInput  zones[N_ZONES];
ZoneMemory mem[N_ZONES];
// آخر رد JSON كامل من الـbackend (يُحتفظ به لقراءة active_run_id والأمر اليدوي manual)
JsonDocument inputsDoc;
// haveInputs: وصل رد صالح واحد على الأقل، failedPolls: عدد السحوبات الفاشلة المتتالية
bool       haveInputs = false;
uint8_t    failedPolls = 0;
uint32_t   lastPoll = 0, lastDecisionReport = 0;
// مفتاح اليوم الحالي (لتصفير المجموع اليومي عند تغيّر التاريخ)؛ -1 = لم يُعرف بعد
int        lastDayKey = -1;
// ملخص آخر قرارات أُرسلت (لإرسالها فقط عند التغيّر)
String     lastReportKey;

// بيانات التشغيل الجاري (نبضة واحدة فقط في أي وقت)
struct Run {
  // هل توجد نبضة تعمل الآن
  bool     active = false;
  // معرّف النبضة (عشوائي) الذي يربط "started" و"finished" عند الـbackend
  String   runId;
  // رقم المنطقة يبدأ من 1 (وليس من 0)
  int      zone = 0;
  // تشغيل يدوي للاختبار من لوحة التحكم (لا يتوقف عند بلوغ الهدف)
  bool     manual = false;
  String   commandId;
  const char *reason = "";
  // المدة المخطط لها ووقت البدء بالميلي ثانية
  uint32_t plannedMs = 0;
  uint32_t startedAt = 0;
} run;

// تقرير "finished" لم يقبله الـbackend بعد، ونصه الجاهز لإعادة الإرسال
bool   finishedPending = false;
String finishedBody;

// ---------------------------------------------------------------- المرحلات (relays)

// تشغيل أو إطفاء relay واحد مع مراعاة أن الوحدة Active LOW:
// عند RELAY_ACTIVE_LOW = true: التشغيل يكتب LOW والإطفاء يكتب HIGH (عملية XOR تعكس المنطق).
void relay(int pin, bool on) { digitalWrite(pin, (on ^ RELAY_ACTIVE_LOW) ? HIGH : LOW); }

// إطفاء كل شيء بالترتيب الآمن: المضخة أولًا، ثم انتظار VALVE_SETTLE_MS، ثم إغلاق كل الصمامات.
void allOff() {
  // المضخة أولًا، حتى لا تضخ أبدًا ضد صمامات مغلقة (ضغط زائد على المضخة والأنابيب)
  relay(PUMP_PIN, false);
  delay(VALVE_SETTLE_MS);
  for (int i = 0; i < N_ZONES; i++) relay(VALVE_PIN[i], false);
}

// ---------------------------------------------------------------- HTTP

// طلب GET إلى الـbackend مع مفتاح الأجهزة. الرد يوضع في resp.
// تُرجع رمز HTTP، أو -1 إذا كان Wi-Fi غير متصل. المهلة 900 ms حتى لا يتجاوز السحب الواحد فترة الثانية.
int httpGet(const String &path, String &resp) {
  if (WiFi.status() != WL_CONNECTED) return -1;
  HTTPClient h;
  h.begin(String(BACKEND_URL) + path);
  h.setTimeout(900);
  h.addHeader("x-api-key", DEVICE_API_KEY);
  int code = h.GET();
  if (code > 0) resp = h.getString();
  h.end();
  return code;
}

// طلب POST بجسم JSON إلى الـbackend مع مفتاح الأجهزة (المهلة 1.5 ثانية). الرد يوضع في resp.
int httpPost(const char *path, const String &body, String &resp) {
  if (WiFi.status() != WL_CONNECTED) return -1;
  HTTPClient h;
  h.begin(String(BACKEND_URL) + path);
  h.setTimeout(1500);
  h.addHeader("x-api-key", DEVICE_API_KEY);
  h.addHeader("Content-Type", "application/json");
  int code = h.POST(body);
  if (code > 0) resp = h.getString();
  h.end();
  return code;
}

// ---------------------------------------------------------------- المدخلات (inputs)

// سحب المدخلات من الـbackend وتعبئة cfg وin وzones منها.
// يرسل مع الطلب قوة إشارة Wi-Fi ومدة التشغيل والإصدار (ليعرض الـbackend حالة اللوحة).
// تُرجع false عند الفشل (ويزيد عداد الفشل)، وtrue عند النجاح.
// العامل "|" في ArduinoJson يعني: إذا كان الحقل غير موجود تُستخدم القيمة بعده (الحالية أو الافتراضية).
bool pollInputs() {
  String resp;
  String path = String("/api/actuator/inputs?device_id=" DEVICE_ID "&rssi=") + WiFi.RSSI() + "&uptime_s=" + (millis() / 1000) + "&firmware=" FIRMWARE;
  int code = httpGet(path, resp);
  // أي رد غير 200 أو JSON تالف = سحب فاشل
  if (code != 200 || deserializeJson(inputsDoc, resp)) { failedPolls++; return false; }
  failedPolls = 0;
  haveInputs = true;

  // إعدادات المحرك من الـbackend (كل حقل غائب يُبقي القيمة السابقة)
  JsonObject e = inputsDoc["engine"];
  cfg.maxDeferS = e["max_defer_s"] | cfg.maxDeferS;
  cfg.deferHysteresis = e["defer_hysteresis"] | cfg.deferHysteresis;
  cfg.soakS = e["soak_s"] | cfg.soakS;
  cfg.maxPulses = e["max_pulses"] | cfg.maxPulses;
  cfg.pulseLockS = e["pulse_lock_s"] | cfg.pulseLockS;
  cfg.followupMaxS = e["followup_max_s"] | cfg.followupMaxS;
  cfg.dailyMaxS = e["daily_max_s"] | cfg.dailyMaxS;
  cfg.pumpFlowLpm = e["pump_flow_lpm"] | cfg.pumpFlowLpm;
  cfg.forecastTrimMax = e["forecast_trim_max"] | cfg.forecastTrimMax;
  uint16_t maxS = e["max_s"] | cfg.maxS;
  // الـbackend لا يستطيع أبدًا تجاوز الحد المحلي LOCAL_MAX_ON_S
  cfg.maxS = maxS < LOCAL_MAX_ON_S ? maxS : LOCAL_MAX_ON_S;

  // المدخلات العامة: الوقت، وحالة الأمان، والمطر، وحداثة الحساسات
  in.now = millis() / 1000;
  in.lockout = inputsDoc["rain_lockout"] | false;
  in.cooldown = inputsDoc["cooldown"] | false;
  in.error = inputsDoc["error"] | false;
  in.rainNow = inputsDoc["rain_detected"] | false;
  // إذا غاب الحقل sensors_fresh تُعتبر البيانات قديمة (افتراض آمن يمنع الري)
  in.stale = !(inputsDoc["sensors_fresh"] | false);
  // الطقس (من BME280 عبر الـbackend)
  JsonObject w = inputsDoc["weather"];
  in.hasWeather = !w.isNull();
  in.temperature = w["temperature"] | 0.0f;
  in.humidity = w["humidity"] | 0.0f;
  // توقع المطر من نموذج الذكاء الاصطناعي: الاحتمال والعتبة
  JsonObject p = inputsDoc["prediction"];
  in.hasPrediction = !p.isNull();
  in.p = p["rain_probability"] | 0.0f;
  in.threshold = p["threshold"] | 0.1f;

  // مدخلات كل منطقة، مع قيم افتراضية آمنة: لا قراءة وغير صالحة ← لن تُسقى
  JsonArray zs = inputsDoc["zones"];
  for (int i = 0; i < N_ZONES; i++) {
    JsonObject z = zs[i];
    zones[i].id = z["id"] | (i + 1);
    zones[i].enabled = z["enabled"] | true;
    zones[i].hasReading = z["has_reading"] | false;
    zones[i].valid = z["valid"] | false;
    zones[i].soil = z["soil"] | -1.0f;
    zones[i].target = z["target"] | 35.0f;
    zones[i].critical = z["critical"] | 18.0f;
    zones[i].secondsPerPercent = z["seconds_per_percent"] | 2.0f;
  }

  // يوم جديد في الرياض (UTC+3، أي يتغيّر التاريخ عند 21:00 UTC) ← تصفير مجموع ثواني الري اليومية.
  // وقت الخادم server_time يأتي بتوقيت UTC بصيغة "YYYY-MM-DDTHH...".
  const char *st = inputsDoc["server_time"] | "";
  int y, mo, d, hh;
  if (sscanf(st, "%d-%d-%dT%d", &y, &mo, &d, &hh) == 4) {
    // المفتاح ليس تاريخًا دقيقًا (لا يهتم بنهاية الشهر)؛ المهم فقط "هل تغيّر؟"
    int dayKey = mo * 100 + d + (hh >= 21 ? 1 : 0);
    if (dayKey != lastDayKey) {
      // لا يُصفَّر عند أول قراءة بعد التشغيل (lastDayKey = -1)، فقط عند تغيّر اليوم فعلًا
      if (lastDayKey >= 0) for (int i = 0; i < N_ZONES; i++) mem[i].secondsToday = 0;
      lastDayKey = dayKey;
    }
  }
  return true;
}

// ---------------------------------------------------------------- الإبلاغ (reporting)

// إرسال قرارات كل المناطق (مع الـtrace) والمنطقة المختارة إلى /api/actuator/decisions لعرضها في لوحة التحكم.
void reportDecisions(const ZoneDecision *ds, int chosen) {
  // ملخص نصي للقرارات (القرار + السبب + الثواني لكل منطقة + المختارة) لمعرفة هل تغيّر شيء
  String key;
  for (int i = 0; i < N_ZONES; i++) key += String(ds[i].action) + ds[i].reason + ds[i].seconds + ",";
  key += chosen;
  // يُرسل فورًا عند أي تغيّر؛ وإلا يُحدَّث كل 30 ثانية (الـbackend يخزّن التغييرات فقط).
  if (key == lastReportKey && millis() - lastDecisionReport < DECISION_REPORT_MS * 6) return;
  lastReportKey = key;
  lastDecisionReport = millis();

  JsonDocument doc;
  doc["device_id"] = DEVICE_ID;
  // chosen_zone = null إذا لم تُختر أي منطقة
  if (chosen >= 0) doc["chosen_zone"] = ds[chosen].zoneId; else doc["chosen_zone"] = nullptr;
  JsonArray arr = doc["zones"].to<JsonArray>();
  for (int i = 0; i < N_ZONES; i++) {
    JsonObject o = arr.add<JsonObject>();
    o["zone_id"] = ds[i].zoneId;
    o["action"] = actionName(ds[i].action);
    o["seconds"] = ds[i].seconds;
    o["planned_seconds"] = ds[i].plannedSeconds;
    o["liters"] = ds[i].liters;
    o["reason"] = ds[i].reason;
    o["urgency"] = roundf(ds[i].urgency * 1000) / 1000;
    JsonArray tr = o["trace"].to<JsonArray>();
    for (int k = 0; k < ds[i].nTrace; k++) {
      JsonObject t = tr.add<JsonObject>();
      t["step"] = ds[i].trace[k].step;
      t["pass"] = ds[i].trace[k].pass;
      t["note"] = ds[i].trace[k].note;
    }
  }
  String body, resp;
  serializeJson(doc, body);
  httpPost("/api/actuator/decisions", body, resp);
}

// إبلاغ الـbackend قبل أن يتدفق أي ماء. إذا رفض (مثلًا بدأ المطر قبل لحظة) لا يُفتح شيء.
// لا تُعتبر الموافقة إلا برد 201 فيه "abort": false صراحةً؛ أي شيء آخر (خطأ، JSON تالف، حقل غائب) = رفض.
bool reportStarted(const char *reason, const char *commandId) {
  JsonDocument doc;
  doc["event"] = "started";
  doc["device_id"] = DEVICE_ID;
  doc["run_id"] = run.runId;
  doc["zone"] = run.zone;
  doc["planned_seconds"] = run.plannedMs / 1000;
  doc["reason"] = reason;
  if (commandId && *commandId) doc["command_id"] = commandId;
  String body, resp;
  serializeJson(doc, body);
  int code = httpPost("/api/actuator/run", body, resp);
  if (code != 201) return false;
  JsonDocument r;
  if (deserializeJson(r, resp)) return false;
  return !(r["abort"] | true);
}

// إرسال تقرير "finished" المعلّق (إن وجد). يُعتبر مُنجزًا عند 201،
// وأيضًا عند 400 أو 403: أخطاء 4xx تعني أن الطلب نفسه مرفوض، وإعادة المحاولة لن تفيد.
// عند أي خطأ آخر (مثل انقطاع الشبكة) يبقى معلّقًا ويُعاد في loop().
void flushFinished() {
  if (!finishedPending) return;
  String resp;
  int code = httpPost("/api/actuator/run", finishedBody, resp);
  if (code == 201 || code == 400 || code == 403) finishedPending = false;
}

// ---------------------------------------------------------------- التشغيل (runs)

// بدء نبضة ري للمنطقة zoneIdx (يبدأ من 0) لمدة seconds ثانية (محصورة بـLOCAL_MAX_ON_S).
// الترتيب: إبلاغ الـbackend أولًا ← إغلاق كل شيء ← فتح صمام المنطقة ← انتظار ← تشغيل المضخة.
void startRun(int zoneIdx, uint16_t seconds, const char *reason, bool manual, const char *commandId) {
  // معرّف عشوائي للنبضة مثل run_3fa2c1d0 (من مولد الأرقام العشوائية في العتاد)
  run.runId = String("run_") + String(esp_random(), HEX);
  run.zone = zones[zoneIdx].id;
  run.manual = manual;
  run.commandId = commandId ? commandId : "";
  run.reason = reason;
  uint32_t s = seconds < LOCAL_MAX_ON_S ? seconds : LOCAL_MAX_ON_S;
  run.plannedMs = s * 1000UL;
  // إذا رفض الـbackend لا يُفتح أي صمام ولا تعمل المضخة
  if (!reportStarted(reason, commandId)) { Serial.printf("[run] zone %d refused by backend\n", run.zone); return; }

  // صمام واحد فقط: يُغلق كل شيء أولًا
  allOff();
  // الصمام قبل المضخة بـVALVE_SETTLE_MS حتى يكون للماء طريق مفتوح (لا dead-heading)
  relay(VALVE_PIN[zoneIdx], true);
  delay(VALVE_SETTLE_MS);
  relay(PUMP_PIN, true);
  run.active = true;
  run.startedAt = millis();
  Serial.printf("[run] START zone %d for %lus (%s)\n", run.zone, (unsigned long)s, reason);
}

// إيقاف النبضة الجارية: status = "completed" أو "cancelled"، وreason = سبب الإيقاف (أو nullptr).
// تحدّث ذاكرة المنطقة (للتشرّب والحد اليومي وعدد النبضات) ثم تُبلغ الـbackend بـ"finished".
void stopRun(const char *status, const char *reason) {
  // العتاد أولًا ثم الأوراق: الماء يتوقف قبل أي اتصال بالشبكة قد يتأخر
  allOff();
  float seconds = (millis() - run.startedAt) / 1000.0f;
  run.active = false;
  // رقم المنطقة يبدأ من 1، والمصفوفة من 0
  int idx = run.zone - 1;
  // تُسجّل الثواني الفعلية (وليس المخطط لها) في ذاكرة المنطقة
  if (idx >= 0 && idx < N_ZONES) rememberPulse(mem[idx], (uint16_t)lroundf(seconds), millis() / 1000, cfg);
  Serial.printf("[run] STOP zone %d %s %s after %.1fs\n", run.zone, status, reason ? reason : "", seconds);

  // تقرير "finished" مع المدة الفعلية وتأكيد أن المضخة OFF والصمام CLOSED
  JsonDocument doc;
  doc["event"] = "finished";
  doc["device_id"] = DEVICE_ID;
  doc["run_id"] = run.runId;
  doc["zone"] = run.zone;
  doc["status"] = status;
  doc["actual_seconds"] = roundf(seconds * 10) / 10;
  if (reason) doc["stop_reason"] = reason;
  doc["pump"] = "OFF";
  doc["valve"] = "CLOSED";
  // يُحفظ النص ويُعلَّم كمعلّق، ثم محاولة أولى فورية؛ إذا فشلت تُعاد لاحقًا
  finishedBody = "";
  serializeJson(doc, finishedBody);
  finishedPending = true;
  flushFinished();
}

// مراقبة النبضة الجارية في كل دورة من loop() وإيقافها عند أي شرط أمان أو اكتمال.
// polled = true إذا نجح سحب مدخلات جديدة في هذه الدورة (فالشروط المعتمدة على الـbackend تُفحص فقط حينها).
void superviseRun(bool polled) {
  if (!run.active) return;
  uint32_t elapsed = millis() - run.startedAt;
  // الحد المحلي الصارم: يُفحص في كل دورة ولا يعتمد على الشبكة
  if (elapsed >= LOCAL_MAX_ON_S * 1000UL) return stopRun("cancelled", "LOCAL_MAX_ON_TIME");
  // الـbackend غير متاح (3 سحوبات فاشلة متتالية): لا يُستمر في الري دون معلومات حديثة
  if (!polled && failedPolls >= MAX_FAILED_POLLS) return stopRun("cancelled", "BACKEND_UNREACHABLE");
  if (polled) {
    if (in.rainNow || in.lockout) return stopRun("cancelled", "RAIN_OVERRIDE");
    if (in.cooldown || in.error) return stopRun("cancelled", "SAFETY_STATE");
    if (in.stale) return stopRun("cancelled", "SENSORS_STALE");
    // الـbackend يرسل معرّف النبضة النشطة لديه؛ إذا اختلف عن نبضتنا فقد أُلغيت من الخادم (مثل زر إيقاف)
    const char *active = inputsDoc["active_run_id"] | "";
    if (run.runId != active) return stopRun("cancelled", "COMMAND_REVOKED");
    // حلقة مغلقة لحظية: إذا بلغت التربة الهدف + 2% تتوقف مبكرًا (لا تنطبق على التشغيل اليدوي للاختبار)
    ZoneInput &z = zones[run.zone - 1];
    if (!run.manual && z.valid && z.soil >= z.target + TARGET_STOP_MARGIN) return stopRun("completed", "TARGET_REACHED");
  }
  // انتهت المدة المخطط لها
  if (elapsed >= run.plannedMs) stopRun("completed", nullptr);
}

// تقييم كل المناطق، واختيار واحدة، وبدء نبضتها إن وجدت. تُستدعى فقط عندما لا توجد نبضة جارية.
void evaluateAndMaybeStart() {
  // تشغيل الاختبار اليدوي من لوحة الصيانة في لوحة التحكم له الأولوية (مع بقاء الحدود المحلية مطبّقة).
  // لا يُنفّذ أثناء المطر أو إذا كانت البيانات قديمة. المدة الافتراضية 5 ثوانٍ.
  JsonObject man = inputsDoc["manual"];
  if (!man.isNull() && !in.rainNow && !in.stale) {
    int idx = (man["zone"] | 0) - 1;
    if (idx >= 0 && idx < N_ZONES) { startRun(idx, man["seconds"] | 5, "MANUAL_TEST", true, man["command_id"] | ""); return; }
  }

  // قرار لكل منطقة، ثم تحديث ذاكرتها (مثل وقت بدء التأجيل)
  ZoneDecision ds[N_ZONES];
  for (int i = 0; i < N_ZONES; i++) {
    ds[i] = decideZone(zones[i], in, mem[i], cfg);
    rememberDecision(mem[i], ds[i], zones[i], in.now);
  }
  // اختيار المنطقة الأحوج (أو -1)، ثم الإبلاغ، ثم البدء
  int chosen = chooseZone(ds, N_ZONES);
  reportDecisions(ds, chosen);
  if (chosen >= 0) startRun(chosen, ds[chosen].seconds, ds[chosen].reason, false, nullptr);
}

// ---------------------------------------------------------------- الإعداد والحلقة الرئيسية (setup / loop)

// تفعيل الـwatchdog: إذا لم تُستدعَ esp_task_wdt_reset() خلال WDT_TIMEOUT_S ثانية تُعاد تشغيل اللوحة.
// الشرط #if لأن طريقة الإعداد تغيّرت في نواة arduino-esp32 الإصدار 3 عن الإصدارات الأقدم.
void setupWatchdog() {
#if ESP_ARDUINO_VERSION_MAJOR >= 3
  esp_task_wdt_config_t c = { .timeout_ms = WDT_TIMEOUT_S * 1000, .idle_core_mask = 0, .trigger_panic = true };
  esp_task_wdt_reconfigure(&c);
#else
  esp_task_wdt_init(WDT_TIMEOUT_S, true);
#endif
  esp_task_wdt_add(NULL);
}

// setup(): تعمل مرة واحدة عند التشغيل أو بعد إعادة التشغيل:
// إطفاء كل المرحلات أولًا، ثم Serial، ثم الـwatchdog، ثم Wi-Fi.
void setup() {
  // كل مدخل relay يُضبط على OFF *قبل* أن يصبح طرف خرج (OUTPUT)، حتى لا يعمل أي شيء لحظة الإقلاع.
  const int pins[] = {PUMP_PIN, VALVE_PIN[0], VALVE_PIN[1], VALVE_PIN[2]};
  for (int p : pins) { digitalWrite(p, RELAY_ACTIVE_LOW ? HIGH : LOW); pinMode(p, OUTPUT); }
  allOff();

  Serial.begin(115200);
  delay(200);
  Serial.println("\nSAQAI actuator node " FIRMWARE);
  setupWatchdog();

  // الاتصال بـWi-Fi (عميل STA) مع إعادة اتصال تلقائي؛ انتظار حتى 10 ثوانٍ (40 × 250 ms) ثم المتابعة
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  for (int i = 0; i < 40 && WiFi.status() != WL_CONNECTED; i++) { delay(250); esp_task_wdt_reset(); }
  Serial.printf("[wifi] %s %s\n", WiFi.status() == WL_CONNECTED ? "connected" : "not connected yet", WiFi.localIP().toString().c_str());
}

// loop(): حلقة غير حاجبة (non-blocking) تدور كل ≈10 ms:
// سحب المدخلات كل ثانية ← مراقبة النبضة الجارية ← إذا لا توجد نبضة: إرسال التقارير المعلّقة ثم قرار جديد.
void loop() {
  // إبلاغ الـwatchdog أن البرنامج ما زال يعمل
  esp_task_wdt_reset();
  uint32_t now = millis();

  // إذا انقطع Wi-Fi: محاولة إعادة اتصال كل 10 ثوانٍ
  if (WiFi.status() != WL_CONNECTED) {
    static uint32_t lastTry = 0;
    if (now - lastTry > 10000) { lastTry = now; WiFi.reconnect(); }
  }

  // سحب المدخلات كل POLL_MS؛ رسالة "unreachable" تُطبع مرة واحدة عند الفشل الثالث بالضبط
  bool polled = false;
  if (now - lastPoll >= POLL_MS) {
    lastPoll = now;
    polled = pollInputs();
    if (!polled && failedPolls == MAX_FAILED_POLLS) Serial.println("[poll] backend unreachable");
  }

  // تُفحص في كل دورة وليس فقط عند السحب (حتى يُطبّق الحد الزمني بدقة)
  superviseRun(polled);

  // لا يبدأ قرار جديد إلا بعد قبول تقرير "finished" السابق، وبمدخلات حديثة من هذه الدورة
  if (!run.active) {
    flushFinished();
    if (polled && haveInputs && !finishedPending) evaluateAndMaybeStart();
  }
  delay(10);
}
