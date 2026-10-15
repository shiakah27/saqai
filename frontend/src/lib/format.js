/**
 * format.js — دوال صغيرة لتنسيق الوقت والأرقام والنسب قبل عرضها.
 * تُستخدم في كل الصفحات تقريبًا. لا تقرأ أي بيانات من الخادم بنفسها.
 */
// طوابع الوقت القادمة من البيانات والخادم تحمل فرق التوقيت الخاص بها؛ نعرض دائمًا بتوقيت الرياض.
const tz = 'Asia/Riyadh';

// الوقت بصيغة 24 ساعة مثل 14:05 (أرقام لاتينية)، أو "—" إذا لا يوجد وقت.
export const fmtTime = (iso) =>
  iso ? new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz }).format(new Date(iso)) : '—';

// اليوم والشهر بالعربية (تقويم ميلادي وأرقام لاتينية) مثل "11 أكتوبر".
export const fmtDay = (iso) =>
  iso ? new Intl.DateTimeFormat('ar-SA-u-ca-gregory-nu-latn', { day: 'numeric', month: 'long', timeZone: tz }).format(new Date(iso)) : '';

// التاريخ والوقت معًا: "11 أكتوبر · 14:05".
export const fmtDateTime = (iso) => (iso ? `${fmtDay(iso)} · ${fmtTime(iso)}` : '—');

// رقم بعدد محدد من المنازل العشرية، أو "—" إذا القيمة غير موجودة.
export const fmtNum = (v, digits = 1) => (v == null || Number.isNaN(v) ? '—' : Number(v).toFixed(digits));

// رقم بإشارة واضحة (+ أو − أو ±) لعرض التغيّر، مثل ‎+1.2.
export const signed = (v, digits = 1) => (v == null ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : '±'}${Math.abs(v).toFixed(digits)}`);

// تحويل احتمال بين 0 و1 إلى نسبة مئوية مقرّبة مثل 35%.
export const pct = (p) => (p == null ? '—' : `${Math.round(p * 100)}%`);
