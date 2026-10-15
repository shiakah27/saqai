/**
 * useRunProgress.js — hook لحساب تقدّم عملية الري الجارية (الثواني المنقضية والمتبقية والنسبة).
 * تُستخدم في App وتُمرَّر كـprop باسم progress إلى الصفحات (بطاقة المضخة، الخريطة، المناطق).
 * البيانات: status.active_run و status.t (وقت الخادم).
 */
import { useEffect, useMemo, useState } from 'react';

/**
 * التقدّم الحي للري الجاري. تستخدم ساعة الخادم (status.t) مرجعًا،
 * فحتى لو كانت ساعة الجوال أو اللابتوب خاطئة تظهر الثواني صحيحة.
 * الطريقة: المنقضي = (وقت الخادم − وقت البدء) + الزمن المحلي الذي مرّ منذ وصول هذه الحالة.
 */
export function useRunProgress(status) {
  const run = status?.active_run;
  const [now, setNow] = useState(Date.now());
  // لحظة وصول الحالة الحالية (تتجدد كلما تغيّر status.t).
  const receivedAt = useMemo(() => Date.now(), [status?.t]);
  // أثناء الري فقط: تحديث الوقت 4 مرات في الثانية ليتحرك العدّاد بسلاسة.
  useEffect(() => {
    if (!run) return undefined;
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [run]);
  if (!run?.started_at) return null;
  const elapsed = Math.max(0, (new Date(status.t) - new Date(run.started_at)) / 1000 + (now - receivedAt) / 1000);
  return {
    run,
    elapsed,
    left: Math.max(0, Math.ceil(run.planned_seconds - elapsed)),
    frac: Math.min(1, elapsed / Math.max(1, run.planned_seconds)),
  };
}
