/**
 * حالة مشتركة صغيرة في الذاكرة لمعرفة موعد التنبؤ القادم.
 * يكتب فيها scheduler.js وقت آخر تنبؤ مجدول، ويقرأ منها statusService.js لعرض «التنبؤ التالي»
 * في لوحة التحكم. فُصلت في ملف مستقل لتجنّب الاعتماد الدائري بين scheduler و statusService.
 */
let lastScheduledAt = null;
// الفاصل بالدقائق بين التنبؤات (يُحدَّث من الـ scheduler).
let intervalMin = 30;

module.exports = {
  // تسجيل أن تنبؤًا جُدول الآن (أو في الوقت المعطى) مع الفاصل المستخدم بالدقائق.
  markScheduled(at = new Date(), minutes = intervalMin) { lastScheduledAt = at; intervalMin = minutes; },
  // وقت آخر تنبؤ مجدول (أو null إن لم يحدث بعد).
  lastScheduled: () => lastScheduledAt,
  // موعد التنبؤ القادم بصيغة ISO = آخر موعد + الفاصل.
  nextPredictionAt: () => (lastScheduledAt ? new Date(lastScheduledAt.getTime() + intervalMin * 60_000).toISOString() : null),
};
