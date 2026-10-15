/*
 * سَقاي (SAQAI) — غلاف سطر أوامر (CLI) حول محرك القرار الحقيقي saqai_decision.h.
 * ------------------------------------------------------------------------------
 * ما هذا الملف:
 *   يستخدمه اختبار النظام الكامل (end-to-end) في الـbackend، حتى تقرر "ESP32 رقم 2" الوهمية في الاختبار
 *   بنفس الكود بالضبط الذي يعمل على اللوحة (وليس بنسخة مكتوبة من جديد بلغة JavaScript).
 *   الاختبار يكتب المدخلات في stdin، ويقرأ النتيجة JSON من stdout.
 *
 * الترجمة:
 *   g++ -std=c++17 -O2 -I../actuator_node decide_cli.cpp -o decide_cli
 *
 * المدخلات من stdin (قيم مفصولة بمسافات أو أسطر، والقيم المنطقية تُكتب 0 أو 1):
 *   mode                                   "decide" (قرار لكل المناطق) | "pulse" (تسجيل نبضة انتهت)
 *   lockout cooldown error rainNow stale hasPred p threshold hasWeather temperature humidity now
 *   maxDeferS hysteresis soakS maxPulses pulseLockS followupMaxS dailyMaxS maxS
 *   n                                      عدد المناطق
 *   n × منطقة:  id enabled hasReading valid soil target critical secondsPerPercent
 *   n × ذاكرة:  irrigatedOnce lastIrrigatedAt deferring deferredSince pulses pulseLockUntil secondsToday
 *   في وضع pulse فقط:  zoneIndex seconds   (رقم المنطقة يبدأ من 0، ومدة النبضة بالثواني)
 * المخرجات في stdout: JSON بالشكل { chosen, zones:[…], memory:[…] }
 *   والذاكرة تُعاد للاختبار ليمررها في الاستدعاء التالي (البرنامج نفسه لا يحفظ شيئًا بين التشغيلات).
 */
#include <cstdio>
#include <iostream>
#include <string>
#include <vector>
#include "saqai_decision.h"

using namespace saqai;

int main() {
  std::string mode;
  std::cin >> mode;
  // المدخلات العامة؛ القيم المنطقية تُقرأ أولًا كأرقام صحيحة في b ثم تُحوّل إلى bool
  Inputs in;
  int b[8];
  std::cin >> b[0] >> b[1] >> b[2] >> b[3] >> b[4] >> b[5] >> in.p >> in.threshold >> b[6] >> in.temperature >> in.humidity >> in.now;
  in.lockout = b[0]; in.cooldown = b[1]; in.error = b[2]; in.rainNow = b[3]; in.stale = b[4]; in.hasPrediction = b[5]; in.hasWeather = b[6];
  // الإعدادات؛ الحقول الصغيرة (uint8_t وuint16_t) تُقرأ عبر unsigned أولًا
  // (قراءة uint8_t مباشرة من cin تقرأ حرفًا واحدًا وليس رقمًا)
  Config c;
  unsigned maxPulses, followup, maxS;
  std::cin >> c.maxDeferS >> c.deferHysteresis >> c.soakS >> maxPulses >> c.pulseLockS >> followup >> c.dailyMaxS >> maxS;
  c.maxPulses = maxPulses; c.followupMaxS = followup; c.maxS = maxS;
  // المناطق ثم ذاكرة كل منطقة
  int n;
  std::cin >> n;
  std::vector<ZoneInput> z(n);
  std::vector<ZoneMemory> m(n);
  for (int i = 0; i < n; i++) {
    int en, hr, va;
    std::cin >> z[i].id >> en >> hr >> va >> z[i].soil >> z[i].target >> z[i].critical >> z[i].secondsPerPercent;
    z[i].enabled = en; z[i].hasReading = hr; z[i].valid = va;
  }
  for (int i = 0; i < n; i++) {
    int io, df; unsigned pulses;
    std::cin >> io >> m[i].lastIrrigatedAt >> df >> m[i].deferredSince >> pulses >> m[i].pulseLockUntil >> m[i].secondsToday;
    m[i].irrigatedOnce = io; m[i].deferring = df; m[i].pulses = pulses;
  }

  // وضع pulse: تحديث ذاكرة منطقة واحدة بعد نبضة (rememberPulse) دون قرار.
  // وضع decide: قرار لكل منطقة + تحديث ذاكرتها، ثم اختيار المنطقة الواحدة
  // (كما في evaluateAndMaybeStart على اللوحة).
  int chosen = -1;
  std::vector<ZoneDecision> ds(n);
  if (mode == "pulse") {
    int idx; unsigned secs;
    std::cin >> idx >> secs;
    rememberPulse(m[idx], secs, in.now, c);
  } else {
    for (int i = 0; i < n; i++) { ds[i] = decideZone(z[i], in, m[i], c); rememberDecision(m[i], ds[i], z[i], in.now); }
    chosen = chooseZone(ds.data(), n);
  }

  // طباعة النتيجة JSON يدويًا: قرارات المناطق مع الـtrace (في وضع decide فقط)، ثم الذاكرة المحدّثة
  // لكل منطقة كمصفوفة بنفس ترتيب حقول الإدخال
  printf("{\"chosen\":%d,\"zones\":[", chosen);
  for (int i = 0; mode == "decide" && i < n; i++) {
    printf("%s{\"zone_id\":%d,\"action\":\"%s\",\"seconds\":%u,\"planned_seconds\":%u,\"liters\":%.2f,\"planned_liters\":%.2f,\"reason\":\"%s\",\"urgency\":%.3f,\"trace\":[",
           i ? "," : "", ds[i].zoneId, actionName(ds[i].action), ds[i].seconds, ds[i].plannedSeconds, ds[i].liters, ds[i].plannedLiters, ds[i].reason, ds[i].urgency);
    for (int k = 0; k < ds[i].nTrace; k++)
      printf("%s{\"step\":\"%s\",\"pass\":%s,\"note\":\"%s\"}", k ? "," : "", ds[i].trace[k].step, ds[i].trace[k].pass ? "true" : "false", ds[i].trace[k].note);
    printf("]}");
  }
  printf("],\"memory\":[");
  for (int i = 0; i < n; i++)
    printf("%s[%d,%u,%d,%u,%u,%u,%u]", i ? "," : "", m[i].irrigatedOnce, m[i].lastIrrigatedAt, m[i].deferring, m[i].deferredSince,
           m[i].pulses, m[i].pulseLockUntil, m[i].secondsToday);
  printf("]}\n");
  return 0;
}
