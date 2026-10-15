/*
 * سَقاي (SAQAI) — اختبارات الوحدة (unit tests) لمحرك القرار الذي يعمل على ESP32 رقم 2.
 * ------------------------------------------------------------------------------------
 * ما هذا الملف:
 *   برنامج C++ عادي يعمل على أي كمبيوتر (لا يحتاج لوحة ESP32). يضم نفس الملف saqai_decision.h
 *   المستخدم داخل actuator_node.ino، ثم يجرّب حالات كثيرة ويتأكد أن كل قرار وسبب ومدة كما هو متوقع.
 *   بذلك يُتحقق من منطق الري قبل رفعه على اللوحة، دون مضخة أو حساسات حقيقية.
 *
 * التشغيل:
 *   g++ -std=c++17 -Wall -Wextra -I../actuator_node test_decision.cpp -o test_decision && ./test_decision
 *   أو من مجلد backend:  npm run test:firmware
 * الناتج: سطر PASS أو FAIL لكل حالة، ثم "N passed, M failed". رمز الخروج 1 إذا فشلت أي حالة.
 */
#include <cstdio>
#include <cstring>
#include <cmath>
#include "saqai_decision.h"

using namespace saqai;

// عدّادات النتائج
static int failed = 0, passed = 0;
// CHECK(الاسم، الشرط): يطبع PASS إذا تحقق الشرط، وإلا FAIL مع رقم السطر في هذا الملف
#define CHECK(name, cond) do { if (cond) { passed++; printf("  PASS  %s\n", name); } else { failed++; printf("  FAIL  %s  (line %d)\n", name, __LINE__); } } while (0)

// تبني منطقة اختبار بقراءة صالحة: الرطوبة soil%، والهدف 35% والحد الحرج 18% و2 ثانية لكل 1% افتراضيًا
static ZoneInput zone(int id, float soil, float target = 35, float critical = 18, float spp = 2.0f) {
  ZoneInput z; z.id = id; z.hasReading = true; z.valid = true; z.soil = soil; z.target = target; z.critical = critical; z.secondsPerPercent = spp;
  return z;
}
// مدخلات عامة "عادية": احتمال مطر p (افتراضيًا 0.05) والعتبة 0.28، طقس 30°C ورطوبة جو 30%
// (لا تعديل حر ولا رطوبة)، والوقت الحالي 100000 ثانية. الحالات تغيّر منها ما تحتاج فقط.
static Inputs base(float p = 0.05f) {
  Inputs in; in.hasPrediction = true; in.p = p; in.threshold = 0.28f; in.hasWeather = true; in.temperature = 30; in.humidity = 30; in.now = 100000;
  return in;
}

int main() {
  // c: الإعدادات الافتراضية للمحرك، fresh: ذاكرة منطقة جديدة لم تُسقَ ولم تؤجَّل
  Config c;
  ZoneMemory fresh;
  // ---- القرار الأساسي لكل منطقة: سلّم الأولويات (أمان، حساس، حاجة، حرج، توقع) ----
  // مثال الحساب: (35 − 25) × 2 = 20 ثانية
  printf("Decision engine (ESP32 #2)\n");

  { auto d = decideZone(zone(1, 25), base(), fresh, c);
    CHECK("dry soil + low rain chance → IRRIGATE 20 s", d.action == IRRIGATE && d.seconds == 20 && !strcmp(d.reason, "BELOW_TARGET")); }
  { auto d = decideZone(zone(1, 50), base(), fresh, c);
    CHECK("wet soil → SKIP AT_TARGET", d.action == SKIP && !strcmp(d.reason, "AT_TARGET")); }
  { auto d = decideZone(zone(1, 25), base(0.7f), fresh, c);
    CHECK("rain likely → DEFER with planned seconds", d.action == DEFER && d.plannedSeconds == 20); }
  { ZoneMemory m; m.deferring = true; m.deferredSince = 100000 - 4 * 3600;
    auto d = decideZone(zone(1, 25), base(0.7f), m, c);
    CHECK("deferral older than 3 h → reduced IRRIGATE", d.action == IRRIGATE && d.seconds == 10 && !strcmp(d.reason, "DEFER_LIMIT_REACHED")); }
  { ZoneMemory m; m.deferring = true; m.deferredSince = 100000 - 600;
    auto d = decideZone(zone(1, 25), base(0.26f), m, c);
    CHECK("hysteresis keeps an active deferral at p slightly below threshold", d.action == DEFER); }
  { auto d = decideZone(zone(1, 12), base(0.9f), fresh, c);
    CHECK("critically dry → IRRIGATE even when rain is likely", d.action == IRRIGATE && !strcmp(d.reason, "CRITICAL_DRY")); }
  { auto in = base(); in.rainNow = true;
    auto d = decideZone(zone(1, 5), in, fresh, c);
    CHECK("rain detected now → HOLD regardless of soil", d.action == HOLD && d.seconds == 0); }
  { auto in = base(); in.lockout = true;
    CHECK("RAIN_LOCKOUT → HOLD", decideZone(zone(1, 5), in, fresh, c).action == HOLD); }
  { auto in = base(); in.cooldown = true;
    CHECK("COOLDOWN → HOLD", !strcmp(decideZone(zone(1, 5), in, fresh, c).reason, "COOLDOWN")); }
  { auto in = base(); in.stale = true;
    CHECK("stale inputs → HOLD (fail-safe)", !strcmp(decideZone(zone(1, 5), in, fresh, c).reason, "INPUTS_STALE")); }
  { auto z = zone(1, 25); z.hasReading = false;
    CHECK("no soil reading yet → SKIP NO_SOIL_DATA", !strcmp(decideZone(z, base(), fresh, c).reason, "NO_SOIL_DATA")); }
  { auto z = zone(1, 140); z.valid = false;
    CHECK("impossible reading → SKIP SENSOR_INVALID", !strcmp(decideZone(z, base(), fresh, c).reason, "SENSOR_INVALID")); }
  { auto in = base(); in.hasPrediction = false;
    CHECK("no forecast → IRRIGATE on soil alone", !strcmp(decideZone(zone(1, 25), in, fresh, c).reason, "NO_FORECAST")); }
  { CHECK("seconds capped at 60", decideZone(zone(1, 0, 80), base(), fresh, c).seconds == 60); }
  { auto in = base(); in.temperature = 44;
    CHECK("hot day → 15% more water (20 → 23 s)", decideZone(zone(1, 25), in, fresh, c).seconds == 23); }

  // ---- الحلقة المغلقة والحماية: التشرّب، نبضات المتابعة، إيقاف النبضات، الحد اليومي، ذاكرة التأجيل ----
  printf("Closed loop & protection\n");
  { ZoneMemory m; rememberPulse(m, 20, 100000 - 60, c);
    CHECK("watered 60 s ago → HOLD SOAKING", !strcmp(decideZone(zone(1, 30), base(), m, c).reason, "SOAKING")); }
  { ZoneMemory m; rememberPulse(m, 20, 100000 - 300, c);
    auto d = decideZone(zone(1, 30), base(0.9f), m, c);
    CHECK("follow-up pulse: capped at 10 s and ignores the forecast", d.action == IRRIGATE && d.seconds == 10 && !strcmp(d.reason, "CLOSED_LOOP_PULSE")); }
  { ZoneMemory m; for (int i = 0; i < 3; i++) rememberPulse(m, 10, 100000 - 300, c);
    CHECK("3 pulses without reaching target → HOLD MAX_PULSES", !strcmp(decideZone(zone(1, 25), base(), m, c).reason, "MAX_PULSES")); }
  { ZoneMemory m; for (int i = 0; i < 3; i++) rememberPulse(m, 10, 100000 - 3600, c);
    auto d = decideZone(zone(1, 25), base(), m, c);
    CHECK("after the 30-min pause the zone may be watered again", d.action == IRRIGATE && !strcmp(d.reason, "BELOW_TARGET")); }
  { ZoneMemory m; m.secondsToday = 300;
    CHECK("daily cap → HOLD DAILY_LIMIT", !strcmp(decideZone(zone(1, 25), base(), m, c).reason, "DAILY_LIMIT")); }
  { ZoneMemory m; m.pulses = 2; rememberDecision(m, decideZone(zone(1, 40), base(), m, c), zone(1, 40), 100000);
    CHECK("reaching target resets the pulse series", m.pulses == 0); }
  { ZoneMemory m; auto z = zone(1, 25);
    rememberDecision(m, decideZone(z, base(0.7f), m, c), z, 100000);
    bool started = m.deferring && m.deferredSince == 100000;
    rememberDecision(m, decideZone(z, base(0.7f), m, c), z, 100500);
    CHECK("deferral start time is kept across evaluations", started && m.deferredSince == 100000); }

  // ---- اختيار منطقة واحدة فقط (مضخة واحدة): الأحوج نسبةً إلى هدفها، والحرجة أولًا ----
  printf("Choosing ONE zone\n");
  { ZoneDecision ds[3] = { decideZone(zone(1, 30), base(), fresh, c), decideZone(zone(2, 20, 40), base(), fresh, c), decideZone(zone(3, 50), base(), fresh, c) };
    int i = chooseZone(ds, 3);
    CHECK("driest relative to its target wins (zone 2: 50% deficit vs 14%)", i == 1 && ds[i].zoneId == 2); }
  { ZoneDecision ds[3] = { decideZone(zone(1, 10, 80, 5), base(), fresh, c), decideZone(zone(2, 15), base(), fresh, c), decideZone(zone(3, 50), base(), fresh, c) };
    CHECK("a critically dry zone outranks a larger relative deficit", ds[chooseZone(ds, 3)].zoneId == 2); }
  { ZoneDecision ds[3] = { decideZone(zone(1, 50), base(), fresh, c), decideZone(zone(2, 25), base(0.7f), fresh, c), decideZone(zone(3, 40), base(), fresh, c) };
    CHECK("nothing to water → -1 (no valve opens)", chooseZone(ds, 3) == -1); }
  { auto in = base(); in.rainNow = true;
    ZoneDecision ds[3] = { decideZone(zone(1, 5), in, fresh, c), decideZone(zone(2, 5), in, fresh, c), decideZone(zone(3, 5), in, fresh, c) };
    CHECK("rain → no zone chosen even if all are bone dry", chooseZone(ds, 3) == -1); }
  { ZoneDecision ds[2] = { decideZone(zone(1, 25), base(), fresh, c), decideZone(zone(2, 25), base(), fresh, c) };
    CHECK("tie → lower zone id", ds[chooseZone(ds, 2)].zoneId == 1); }
  { auto d = decideZone(zone(1, 25), base(), fresh, c);
    CHECK("trace lists the rules checked", d.nTrace >= 6 && !strcmp(d.trace[0].step, "SAFETY") && !strcmp(d.trace[d.nTrace - 1].step, "FORECAST")); }

  // ---- اللترات (ثوانٍ × تدفق المضخة ÷ 60) وتخفيض الكمية حسب التوقع (مطفأ افتراضيًا) ----
  printf("Litres\n");
  { auto d = decideZone(zone(1, 25), base(), fresh, c);
    CHECK("20 s at 2 L/min -> 0.67 L", fabsf(d.liters - 0.667f) < 0.01f); }
  { Config c2; c2.pumpFlowLpm = 3.0f; auto d = decideZone(zone(1, 25), base(), fresh, c2);
    CHECK("pump flow scales litres (3 L/min -> 1.0 L)", fabsf(d.liters - 1.0f) < 0.01f && d.seconds == 20); }
  { auto d = decideZone(zone(1, 25), base(0.25f), fresh, c);
    CHECK("trim is OFF by default (full 20 s)", d.action == IRRIGATE && d.seconds == 20); }
  // إعدادات بتخفيض التوقع مفعّلًا (FORECAST_TRIM_MAX=0.3، أي حتى 30% ماء أقل)
  Config ct; ct.forecastTrimMax = 0.3f;
  { auto d = decideZone(zone(1, 25), base(0.25f), fresh, ct);
    CHECK("rain chance just under threshold trims the amount (<20 s, >=14 s)", d.action == IRRIGATE && d.seconds < 20 && d.seconds >= 14); }
  { auto d = decideZone(zone(1, 25), base(0.1f), fresh, c);
    CHECK("low rain chance -> no trim", d.seconds == 20); }
  { auto d = decideZone(zone(1, 12), base(0.25f), fresh, ct);
    CHECK("critical dry -> never trimmed", d.seconds == decideZone(zone(1, 12), base(0.0f), fresh, ct).seconds); }
  { auto d = decideZone(zone(1, 25), base(0.7f), fresh, c);
    CHECK("DEFER reports planned litres, 0 now", d.liters == 0 && d.plannedLiters > 0); }

  // الملخص، ورمز خروج 1 عند أي فشل (حتى يفشل npm run test:firmware)
  printf("\n%d passed, %d failed\n", passed, failed);
  return failed ? 1 : 0;
}
