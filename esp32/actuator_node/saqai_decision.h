/*
 * سَقاي (SAQAI) — محرك القرار (decision engine): يعمل على لوحة ESP32 رقم 2 (عقدة التشغيل).
 * ---------------------------------------------------------------------------------------
 * ما هذا الملف:
 *   "عقل" النظام: يقرر لكل منطقة هل تُسقى الآن، أو يُؤجَّل الري، أو تُتخطّى، أو تُوقَف مؤقتًا،
 *   وكم ثانية تعمل المضخة، ولماذا (مع سجل trace بالقواعد التي فُحصت).
 *
 * علاقته ببقية النظام:
 *   - actuator_node.ino يملأ مدخلاته (رطوبة التربة من ESP32 رقم 1، حالة المطر، احتمال المطر من نموذج
 *     الذكاء الاصطناعي، إعدادات المناطق، وحالة الأمان) من الـbackend كل ثانية، ثم يستدعي هذا الملف.
 *   - مكتوب بلغة C++ عادية بدون أي اعتماد على مكتبات Arduino، لذلك يُختبر نفس الملف بالضبط على
 *     الكمبيوتر (esp32/tests/test_decision.cpp وdecide_cli.cpp) ويُترجم أيضًا داخل برنامج اللوحة.
 *
 * في كل تقييم:
 *   1. decideZone() تمر على سلّم الأولويات لكل منطقة وتسجل trace بالقواعد التي فحصتها
 *   2. chooseZone() تختار منطقة واحدة فقط للري: الأحوج إلى الماء. مضخة واحدة ← صمام واحد في كل مرة.
 *
 * سلّم الأولويات (أول قاعدة توقف القرار هي التي تُطبَّق):
 *   SAFETY    مطر الآن / RAIN_LOCKOUT / COOLDOWN / ERROR / مدخلات قديمة ← HOLD
 *   SENSOR    لا توجد قراءة أو القراءة مستحيلة فيزيائيًا ← SKIP
 *   NEED      التربة عند الهدف أو أعلى ← SKIP
 *   SOAK      سُقيت قبل أقل من soakS ثانية ← HOLD (حتى يصل الماء إلى الحساس)
 *   PULSES    نبضات كثيرة دون الوصول للهدف (حساس عالق؟) ← HOLD لفترة
 *   DAILY     بلغت المنطقة حدها اليومي من الثواني ← HOLD (حماية من الإفراط في الري)
 *   CRITICAL  أقل من الرطوبة الحرجة ← IRRIGATE (التوقع لا يستطيع تأجيله)
 *   FORECAST  المطر محتمل ← DEFER (بحد أقصى maxDeferS = 3 ساعات، مع hysteresis)؛
 *             انتهت مدة التأجيل ← IRRIGATE بكمية مخفّضة
 *   الافتراضي ← IRRIGATE (BELOW_TARGET، أو CLOSED_LOOP_PULSE إذا كانت نبضة متابعة)
 *
 * الكمية: لا يوجد حساس تدفق (flow sensor). الثواني = (الهدف − التربة) × seconds_per_percent،
 *   مع تعديل للحر الشديد وللهواء الرطب، ثم حصرها بين حد أدنى وأعلى.
 *   اللترات تقدير فقط = الثواني × تدفق المضخة (L/min) ÷ 60.
 * الذكاء الاصطناعي لا يتحكم مباشرة في مخرجات هذا الملف: هو يقدّم احتمال المطر فقط، والقرار هنا.
 */
#pragma once
#include <stdint.h>
#include <stdio.h>
#include <math.h>

namespace saqai {

// القرارات الأربعة الممكنة لكل منطقة:
//   IRRIGATE = اسقِ الآن، DEFER = أجّل لأن المطر محتمل، SKIP = لا حاجة أو لا يمكن (لا قراءة/هدف متحقق)،
//   HOLD = انتظر بسبب أمان أو حماية (مطر، تشبّع، حد يومي...)
enum Action : uint8_t { IRRIGATE = 0, DEFER = 1, SKIP = 2, HOLD = 3 };

// اسم القرار كنص، يُرسل إلى الـbackend ويظهر في لوحة التحكم
inline const char *actionName(Action a) {
  switch (a) { case IRRIGATE: return "IRRIGATE"; case DEFER: return "DEFER"; case SKIP: return "SKIP"; default: return "HOLD"; }
}

// إعدادات المحرك. هذه هي القيم الافتراضية؛ actuator_node.ino يستبدل معظمها بما يرسله الـbackend.
struct Config {
  // أقصى مدة تأجيل بسبب توقع المطر: 3 × 3600 = 3 ساعات (تساوي أفق التوقع)
  uint32_t maxDeferS = 3 * 3600;
  // hysteresis: التأجيل الجاري لا ينتهي إلا إذا نزل الاحتمال تحت (العتبة − 0.05)،
  // حتى لا يتذبذب القرار بين DEFER وIRRIGATE عندما يكون الاحتمال قريبًا من العتبة
  float    deferHysteresis = 0.05f;
  // ثوانٍ (120 = دقيقتان) يُنتظر بعد كل نبضة قبل الحكم على المنطقة من جديد (وقت تشرّب الماء)
  uint32_t soakS = 120;
  // عدد النبضات المتتالية (3) دون الوصول إلى الهدف …
  uint8_t  maxPulses = 3;
  // … بعدها تتوقف المنطقة مؤقتًا 30 × 60 = 30 دقيقة (احتمال حساس عالق أو في غير مكانه)
  uint32_t pulseLockS = 30 * 60;
  // نبضات المتابعة (closed-loop) صغيرة: 10 ثوانٍ كحد أقصى
  uint16_t followupMaxS = 10;
  // الحد اليومي لكل منطقة: 300 ثانية تشغيل (5 دقائق) في اليوم
  uint32_t dailyMaxS = 300;
  // أقل مدة نبضة: 3 ثوانٍ (أقل من ذلك لا يفيد)
  uint16_t minS = 3;
  // أطول مدة نبضة: 60 ثانية، وهي أيضًا حد المضخة الصارم المحلي على اللوحة
  uint16_t maxS = 60;
  // إذا كانت الحرارة فوق 40°C تُزاد الكمية 15% (×1.15)
  float    hotTempC = 40.0f, hotFactor = 1.15f;
  // إذا كانت رطوبة الجو فوق 60% تُخفّض الكمية 10% (×0.9) لأن التبخر أقل
  float    humidAirPct = 60.0f, humidFactor = 0.9f;
  // معامل الكمية المخفّضة (النصف) عند انتهاء مدة التأجيل دون مطر
  float    reducedFactor = 0.5f;
  // تدفق المضخة المقاس باللتر في الدقيقة (calibration.md): يحوّل الثواني إلى لترات
  float    pumpFlowLpm = 2.0f;
  // تخفيض الكمية حسب التوقع: مطفأ افتراضيًا (0) لأنه لم يُتحقق منه على بيانات حقيقية.
  // مثال: 0.3 = حتى 30% ماء أقل كلما اقترب احتمال المطر من العتبة
  float    forecastTrimMax = 0.0f;
};

// مدخلات منطقة واحدة (تأتي من الـbackend الذي يأخذها من ESP32 رقم 1 ومن إعدادات المناطق)
struct ZoneInput {
  // رقم المنطقة (1، 2، 3) وهل هي مفعّلة من لوحة التحكم
  int   id = 0;
  bool  enabled = true;
  // وصلت قراءة من عقدة الحساسات
  bool  hasReading = false;
  // تلك القراءة ممكنة فيزيائيًا (الحساس ليس مفصولًا أو في قصر)
  bool  valid = false;
  // رطوبة التربة الحالية بالنسبة المئوية %
  float soil = 0;
  // الهدف % (يُسقى حتى يصل إليه)، والحد الحرج % (أقل منه يُسقى حتى لو المطر محتمل)،
  // وكم ثانية تشغيل تلزم لرفع الرطوبة 1% (من المعايرة)
  float target = 35, critical = 18, secondsPerPercent = 2.0f;
};

// المدخلات العامة المشتركة بين كل المناطق في تقييم واحد
struct Inputs {
  // حالة الـbackend: RAIN_LOCKOUT (قفل بعد المطر)
  bool  lockout = false;
  // حالة الـbackend: COOLDOWN (فترة تهدئة)
  bool  cooldown = false;
  // حالة الـbackend: ERROR (خطأ في النظام)
  bool  error = false;
  // لوحة المطر (MH-RD على ESP32 رقم 1) تقول إنها تمطر الآن
  bool  rainNow = false;
  // المدخلات قديمة (عقدة الحساسات أو الـbackend صامت)
  bool  stale = false;
  // هل يوجد توقع، واحتمال المطر p (0..1)، والعتبة threshold التي يبدأ عندها التأجيل
  bool  hasPrediction = false;
  float p = 0, threshold = 0.1f;
  // هل توجد قراءة طقس، والحرارة °C ورطوبة الجو %
  bool  hasWeather = false;
  float temperature = 0, humidity = 0;
  // الوقت الحالي بالثواني، متزايد دائمًا (millis()/1000 على ESP32) وليس ساعة حقيقية
  uint32_t now = 0;
};

// ما تتذكره اللوحة عن كل منطقة بين تقييم وآخر (ذاكرة الحلقة المغلقة closed loop).
struct ZoneMemory {
  // هل سُقيت مرة على الأقل، ومتى آخر نبضة (بالثواني)
  bool     irrigatedOnce = false;
  uint32_t lastIrrigatedAt = 0;
  // هل التأجيل جارٍ الآن، ومتى بدأ (لحساب الحد الأقصى 3 ساعات)
  bool     deferring = false;
  uint32_t deferredSince = 0;
  // عدد النبضات المتتالية منذ آخر مرة وصلت فيها المنطقة إلى الهدف
  uint8_t  pulses = 0;
  // حتى أي وقت تبقى المنطقة موقوفة بسبب كثرة النبضات (0 = غير موقوفة)
  uint32_t pulseLockUntil = 0;
  // مجموع ثواني الري اليوم (يُصفّر عند بداية يوم جديد بتوقيت الرياض)
  uint32_t secondsToday = 0;
};

// خطوة واحدة في سجل القرار (trace): اسم القاعدة، هل نجحت (pass)، وملاحظة قصيرة (حتى 35 حرفًا)
struct Step { const char *step; bool pass; char note[36]; };

// نتيجة القرار لمنطقة واحدة، تُرسل كاملة إلى الـbackend لتظهر في لوحة التحكم
struct ZoneDecision {
  int      zoneId = 0;
  Action   action = SKIP;
  // ثواني الري الآن (0 إذا لم يكن القرار IRRIGATE)
  uint16_t seconds = 0;
  // الثواني التي أُجّلت (عند DEFER فقط)
  uint16_t plannedSeconds = 0;
  // تقدير اللترات = الثواني × تدفق المضخة (لا يوجد حساس تدفق)
  float    liters = 0;
  float    plannedLiters = 0;
  // رمز السبب، مثل BELOW_TARGET أو RAIN_LIKELY
  const char *reason = "";
  // الأولوية: الأعلى = أحوج للماء (معناها فقط مع IRRIGATE)
  float    urgency = 0;
  // سجل القواعد المفحوصة (10 خطوات كحد أقصى) وعددها الفعلي
  Step     trace[10];
  uint8_t  nTrace = 0;
};

// إضافة خطوة إلى سجل القرار. إذا امتلأ السجل (10 خطوات) تُهمل الخطوة بدل الكتابة خارج المصفوفة.
// snprintf تقص الملاحظة إذا كانت أطول من المساحة المتاحة.
inline void addStep(ZoneDecision &d, const char *step, bool pass, const char *note) {
  if (d.nTrace >= 10) return;
  Step &s = d.trace[d.nTrace++];
  s.step = step;
  s.pass = pass;
  snprintf(s.note, sizeof(s.note), "%s", note);
}

// حساب ثواني الري لمنطقة:
//   الأساس = (الهدف − الرطوبة الحالية) × ثواني لكل 1%
//   ×1.15 في الحر فوق 40°C، و×0.9 إذا كانت رطوبة الجو فوق 60%، ثم × factor (مثل 0.5 للكمية المخفّضة)
//   ثم الحصر: لا تقل عن minS، ولا تزيد عن cap (حد النبضة أو المتبقي من اليوم)، ولا عن maxS.
inline uint16_t computeSeconds(const ZoneInput &z, const Inputs &in, const Config &c, float factor, uint16_t cap) {
  float s = (z.target - z.soil) * z.secondsPerPercent;
  if (in.hasWeather && in.temperature > c.hotTempC) s *= c.hotFactor;
  if (in.hasWeather && in.humidity > c.humidAirPct) s *= c.humidFactor;
  s *= factor;
  long r = lroundf(s);
  if (r < c.minS) r = c.minS;
  if (r > cap) r = cap;
  if (r > c.maxS) r = c.maxS;
  return (uint16_t)r;
}

// تحويل الثواني إلى لترات: الثواني × تدفق المضخة (لتر/دقيقة) ÷ 60. مثال: 20 ثانية × 2 L/min = 0.67 لتر.
inline float litersFor(uint16_t seconds, const Config &c) { return seconds * c.pumpFlowLpm / 60.0f; }

// معامل تخفيض الكمية حسب التوقع (forecast trim):
// احتمال مطر أقل من عتبة التأجيل ما زال يخفّض الكمية قليلًا: لا تخفيض حتى نصف العتبة،
// ثم يزداد التخفيض خطيًا حتى forecastTrimMax عند العتبة نفسها.
// للري العادي فقط (لا يُطبّق أبدًا على الري الحرج أو نبضات المتابعة).
// eff هي العتبة الفعلية (العتبة، أو العتبة − hysteresis إذا كان التأجيل جاريًا).
// بما أن forecastTrimMax = 0 افتراضيًا فالنتيجة 1.0 دائمًا (بدون تخفيض) ما لم يُفعَّل.
inline float forecastFactor(const Inputs &in, const Config &c, float eff) {
  if (!in.hasPrediction || eff <= 0) return 1.0f;
  float lo = eff * 0.5f;
  if (in.p <= lo) return 1.0f;
  float t = (in.p - lo) / (eff - lo); if (t > 1) t = 1;
  return 1.0f - c.forecastTrimMax * t;
}

// قلب المحرك: يمر على سلّم الأولويات لمنطقة واحدة بالترتيب، وأول قاعدة توقف القرار تُرجع النتيجة.
// كل قاعدة تُسجَّل في الـtrace (نجحت أو فشلت) ليظهر سبب القرار بوضوح في لوحة التحكم.
inline ZoneDecision decideZoneCore(const ZoneInput &z, const Inputs &in, const ZoneMemory &m, const Config &c) {
  ZoneDecision d;
  d.zoneId = z.id;
  char note[36];
  // دالة مساعدة: تثبّت القرار والسبب ثم تُرجع النتيجة (لإنهاء السلّم مبكرًا)
  auto stop = [&](Action a, const char *reason) { d.action = a; d.reason = reason; return d; };

  // المنطقة معطّلة من لوحة التحكم: تُتخطّى قبل أي فحص
  if (!z.enabled) { addStep(d, "ZONE", false, "disabled"); return stop(SKIP, "ZONE_DISABLED"); }

  // 1. الأمان (SAFETY): حالة الحساسات والـbackend قبل أي شيء آخر. التوقع لا يُستشار هنا.
  if (in.rainNow)  { addStep(d, "SAFETY", false, "rain detected now");   return stop(HOLD, "RAIN_LOCKOUT"); }
  if (in.lockout)  { addStep(d, "SAFETY", false, "RAIN_LOCKOUT");        return stop(HOLD, "RAIN_LOCKOUT"); }
  if (in.cooldown) { addStep(d, "SAFETY", false, "COOLDOWN");            return stop(HOLD, "COOLDOWN"); }
  if (in.error)    { addStep(d, "SAFETY", false, "ERROR");               return stop(HOLD, "SYSTEM_ERROR"); }
  if (in.stale)    { addStep(d, "SAFETY", false, "inputs too old");      return stop(HOLD, "INPUTS_STALE"); }
  addStep(d, "SAFETY", true, "NORMAL");

  // 2. الحساس (SENSOR): يجب وجود قراءة صالحة بين 0 و100%، وإلا لا يُسقى بناءً على رقم غير موثوق.
  if (!z.hasReading) { addStep(d, "SENSOR", false, "no reading yet"); return stop(SKIP, "NO_SOIL_DATA"); }
  if (!z.valid || z.soil < 0 || z.soil > 100) { addStep(d, "SENSOR", false, "invalid"); return stop(SKIP, "SENSOR_INVALID"); }
  snprintf(note, sizeof(note), "%.1f%%", z.soil);
  addStep(d, "SENSOR", true, note);

  // 3. الحاجة (NEED): إذا كانت التربة عند الهدف أو أعلى فلا حاجة للري.
  snprintf(note, sizeof(note), "%.1f%% vs target %.0f%%", z.soil, z.target);
  if (z.soil >= z.target) { addStep(d, "NEED", false, note); return stop(SKIP, "AT_TARGET"); }
  addStep(d, "NEED", true, note);

  // 4. حدود الحلقة المغلقة (closed loop):
  //    وقت التشرّب (SOAK)، ثم عدد النبضات (PULSES)، ثم الحد اليومي (DAILY).
  // SOAK: بعد كل نبضة يُنتظر soakS ثانية حتى يتشرّب الماء ويصل إلى الحساس، وإلا سيبدو جافًا ويُسقى مرة أخرى.
  if (m.irrigatedOnce) {
    uint32_t since = in.now - m.lastIrrigatedAt;
    snprintf(note, sizeof(note), "%lus since last pulse", (unsigned long)since);
    if (since < c.soakS) { addStep(d, "SOAK", false, note); return stop(HOLD, "SOAKING"); }
    addStep(d, "SOAK", true, note);
  }
  // بعد انتهاء فترة الإيقاف تبدأ المنطقة سلسلة نبضات جديدة (العدّ من صفر).
  const uint8_t pulses = (m.pulseLockUntil && in.now >= m.pulseLockUntil) ? 0 : m.pulses;
  snprintf(note, sizeof(note), "%u/%u pulses", pulses, c.maxPulses);
  // PULSES: المنطقة ما زالت في فترة الإيقاف بسبب كثرة النبضات دون الوصول للهدف
  if (m.pulseLockUntil > in.now) { addStep(d, "PULSES", false, note); return stop(HOLD, "MAX_PULSES"); }
  addStep(d, "PULSES", true, note);
  // DAILY: حماية من الإفراط في الري؛ إذا بلغت ثواني اليوم الحد اليومي تتوقف المنطقة حتى الغد
  snprintf(note, sizeof(note), "%lu/%lus today", (unsigned long)m.secondsToday, (unsigned long)c.dailyMaxS);
  if (m.secondsToday >= c.dailyMaxS) { addStep(d, "DAILY", false, note); return stop(HOLD, "DAILY_LIMIT"); }
  addStep(d, "DAILY", true, note);

  // نبضة متابعة = سبقتها نبضة في نفس السلسلة ولم تصل المنطقة للهدف بعد
  const bool followup = pulses > 0;
  // المتبقي من الحد اليومي
  uint32_t left = c.dailyMaxS - m.secondsToday;
  // سقف هذه النبضة = الأصغر بين (followupMaxS لنبضة المتابعة أو maxS للنبضة الأولى) وبين المتبقي من اليوم
  uint16_t cap = (uint16_t)((followup ? c.followupMaxS : c.maxS) < left ? (followup ? c.followupMaxS : c.maxS) : left);
  // العجز النسبي عن الهدف (0..1): يُستخدم لترتيب أولوية المناطق
  const float deficit = (z.target - z.soil) / z.target;

  // 5. جفاف حرج (CRITICAL): يُسقى الآن مهما قال التوقع (النبات قد يتضرر قبل وصول المطر).
  snprintf(note, sizeof(note), "%.1f%% vs critical %.0f%%", z.soil, z.critical);
  if (z.soil < z.critical) {
    addStep(d, "CRITICAL", false, note);
    d.seconds = computeSeconds(z, in, c, 1.0f, cap);
    // المناطق الحرجة تتقدم دائمًا على غيرها (الأولوية 1 + العجز، وغير الحرجة لا تتجاوز 1)
    d.urgency = 1.0f + deficit;
    return stop(IRRIGATE, followup ? "CLOSED_LOOP_PULSE" : "CRITICAL_DRY");
  }
  addStep(d, "CRITICAL", true, note);
  d.urgency = deficit;

  // 6. التوقع (FORECAST).
  // لا يوجد توقع من الـbackend: الري على أساس التربة وحدها
  if (!in.hasPrediction) {
    addStep(d, "FORECAST", false, "no forecast");
    d.seconds = computeSeconds(z, in, c, 1.0f, cap);
    return stop(IRRIGATE, followup ? "CLOSED_LOOP_PULSE" : "NO_FORECAST");
  }
  // نبضة المتابعة تُكمل ريًّا سبق فحص توقعه، فلا يُفحص التوقع لها مرة أخرى
  if (!followup) {
    // العتبة الفعلية مع hysteresis: إذا كان التأجيل جاريًا تُخفّض العتبة 0.05 حتى لا يتذبذب القرار
    float eff = m.deferring ? in.threshold - c.deferHysteresis : in.threshold;
    if (in.p >= eff) {
      // المطر محتمل: كم مضى على التأجيل حتى الآن؟
      uint32_t deferredFor = m.deferring ? in.now - m.deferredSince : 0;
      if (deferredFor < c.maxDeferS) {
        // ما زال ضمن الحد الأقصى (3 ساعات): يُؤجَّل، وتُحفظ الثواني المخطط لها لعرضها
        snprintf(note, sizeof(note), "p %.2f >= %.2f", in.p, eff);
        addStep(d, "FORECAST", false, note);
        d.plannedSeconds = computeSeconds(z, in, c, 1.0f, cap);
        return stop(DEFER, "RAIN_LIKELY");
      }
      // انتهت مدة التأجيل ولم يأتِ المطر: ري بكمية مخفّضة (reducedFactor = النصف)
      snprintf(note, sizeof(note), "deferred %lus, limit", (unsigned long)deferredFor);
      addStep(d, "FORECAST", false, note);
      d.seconds = computeSeconds(z, in, c, c.reducedFactor, cap);
      return stop(IRRIGATE, "DEFER_LIMIT_REACHED");
    }
    snprintf(note, sizeof(note), "p %.2f < %.2f", in.p, eff);
    addStep(d, "FORECAST", true, note);
  }

  // الافتراضي: ري عادي (BELOW_TARGET) أو نبضة متابعة (CLOSED_LOOP_PULSE).
  // معامل التوقع يُطبّق على الري العادي فقط، ونبضة المتابعة تأخذ 1.0 دائمًا.
  float ff = followup ? 1.0f : forecastFactor(in, c, m.deferring ? in.threshold - c.deferHysteresis : in.threshold);
  d.seconds = computeSeconds(z, in, c, ff, cap);
  return stop(IRRIGATE, followup ? "CLOSED_LOOP_PULSE" : "BELOW_TARGET");
}

// الواجهة العامة للقرار: تستدعي decideZoneCore ثم تحسب تقدير اللترات (الآن والمؤجلة)
// بالمعادلة: لترات = ثوانٍ × تدفق المضخة ÷ 60.
inline ZoneDecision decideZone(const ZoneInput &z, const Inputs &in, const ZoneMemory &m, const Config &c) {
  ZoneDecision d = decideZoneCore(z, in, m, c);
  d.liters = litersFor(d.seconds, c);
  d.plannedLiters = litersFor(d.plannedSeconds, c);
  return d;
}

// اختيار المنطقة الواحدة التي تُسقى الآن: صاحبة أعلى urgency بين قرارات IRRIGATE، أو -1 إذا لا يوجد.
// عند التعادل تفوز المنطقة ذات الرقم الأصغر
// (المقارنة بـ"أكبر بفارق 1e-6" تتجاهل فروق الكسور العشرية الصغيرة).
// السبب: مضخة واحدة فقط، فلا يُفتح إلا صمام واحد في كل مرة.
inline int chooseZone(const ZoneDecision *ds, int n) {
  int best = -1;
  for (int i = 0; i < n; i++) {
    if (ds[i].action != IRRIGATE) continue;
    if (best < 0 || ds[i].urgency > ds[best].urgency + 1e-6f) best = i;
  }
  return best;
}

// تحديث ذاكرة المنطقة بعد كل تقييم (تُستدعى لكل منطقة في كل تقييم):
//   - DEFER أول مرة يسجّل وقت بداية التأجيل (ولا يغيّره في المرات التالية حتى يُحسب الحد 3 ساعات صحيحًا)
//   - IRRIGATE أو SKIP ينهي التأجيل؛ HOLD لا يغيّره
inline void rememberDecision(ZoneMemory &m, const ZoneDecision &d, const ZoneInput &z, uint32_t now) {
  if (d.action == DEFER) {
    if (!m.deferring) { m.deferring = true; m.deferredSince = now; }
  } else if (d.action == IRRIGATE || d.action == SKIP) {
    m.deferring = false;
  }
  // الوصول إلى الهدف ينهي سلسلة نبضات الحلقة المغلقة، وكذلك انتهاء فترة إيقاف النبضات.
  if ((z.hasReading && z.valid && z.soil >= z.target) || (m.pulseLockUntil && now >= m.pulseLockUntil)) {
    m.pulses = 0;
    m.pulseLockUntil = 0;
  }
}

// تحديث ذاكرة المنطقة بعد انتهاء نبضة (اكتملت أو قُطعت مبكرًا):
// يسجّل وقتها (لبدء SOAK)، ويضيف ثوانيها إلى مجموع اليوم، وينهي أي تأجيل،
// ويزيد عدد النبضات؛ إذا بلغ maxPulses تُوقف المنطقة pulseLockS ثانية.
inline void rememberPulse(ZoneMemory &m, uint16_t seconds, uint32_t now, const Config &c) {
  m.irrigatedOnce = true;
  m.lastIrrigatedAt = now;
  m.secondsToday += seconds;
  m.deferring = false;
  if (++m.pulses >= c.maxPulses) m.pulseLockUntil = now + c.pulseLockS;
}

}  // namespace saqai
