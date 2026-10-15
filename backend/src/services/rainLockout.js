/**
 * آلة حالات قفل المطر (دالة نقية: لا قاعدة بيانات ولا شبكة، لذا يسهل اختبارها).
 *
 *   NORMAL ──مطر──▶ RAIN_LOCKOUT ──جفاف──▶ COOLDOWN ──مرور الوقت──▶ NORMAL
 *      ▲                 ▲                    │
 *      └──── مطر مجددًا ─┴────────────────────┘ (المطر أثناء cooldown يعيد القفل)
 *
 * يستدعي الـ backend الدالة `step()` كلما وصلت إشارة مطر (POST /api/rain-event، أو rain_detected=true
 * داخل قراءة طقس دورية) وفي كل دورة للـ scheduler.
 * تعيد الحالة الجديدة مع الأحداث المطلوب تسجيلها؛ والمستدعي (safetyService) يحفظ الاثنين،
 * ويلغي أوامر الري المفتوحة عندما تكون `cancelCommands` تساوي true.
 * فترة cooldown موجودة لأن الحساس قد يجف لحظيًا بين دفعات المطر، ولأن التربة تحتاج وقتًا لتتشرب
 * ماء المطر قبل أن تعكس القراءة الحالة الحقيقية.
 */

/**
 * حساب الانتقال التالي.
 * current: { mode, since, cooldownUntil }
 * المدخلات: rainDetected (هل يوجد مطر الآن)، now (وقت ISO)، cooldownMinutes (مدة الانتظار بالدقائق).
 */
function step(current, { rainDetected, now, cooldownMinutes }) {
  const t = new Date(now);
  const events = [];
  let next = { ...current };
  let cancelCommands = false;

  // مطر: الانتقال إلى RAIN_LOCKOUT من أي وضع (إن لم يكن مقفلًا أصلًا).
  if (rainDetected) {
    if (current.mode !== 'RAIN_LOCKOUT') {
      next = { mode: 'RAIN_LOCKOUT', since: now, cooldownUntil: null };
      events.push({ type: 'RAIN_STARTED', at: now });
      if (current.mode === 'IRRIGATING') events.push({ type: 'IRRIGATION_STOPPED', at: now, reason: 'RAIN_OVERRIDE' });
      // المستدعي يُبطل كل أمر PENDING/ACTIVE، ويسجل حدثًا لكل أمر.
      cancelCommands = true;
    }
    return { state: next, events, cancelCommands };
  }

  // توقف المطر أثناء القفل: بدء فترة الانتظار حتى (الآن + cooldownMinutes).
  if (current.mode === 'RAIN_LOCKOUT') {
    const until = new Date(t.getTime() + cooldownMinutes * 60_000).toISOString();
    next = { mode: 'COOLDOWN', since: now, cooldownUntil: until };
    events.push({ type: 'RAIN_STOPPED', at: now });
    events.push({ type: 'COOLDOWN_STARTED', at: now, until });
    return { state: next, events, cancelCommands };
  }

  // انتهى وقت الانتظار: العودة إلى NORMAL، فتعيد اللوحة حساب القرار.
  if (current.mode === 'COOLDOWN' && current.cooldownUntil && t >= new Date(current.cooldownUntil)) {
    next = { mode: 'NORMAL', since: now, cooldownUntil: null };
    events.push({ type: 'DECISION_RECALCULATED', at: now });
  }

  return { state: next, events, cancelCommands };
}

module.exports = { step };
