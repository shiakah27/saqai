/**
 * zones.js — منطق عرض حالة المناطق (Zones) بكلمات يفهمها الزائر.
 * لا يقرر الري (عقدة التشغيل ESP32 #2 هي التي تقرر)؛ فقط يترجم قرار الخادم لكل منطقة
 * إلى حالة واحدة واضحة ولون، ويحسب طابور الري وكمية ماء اليوم.
 * يُستخدم في الرئيسية وصفحة المناطق وصفحة القرار. البيانات: status.zones و status.active_run و history.runs.
 */
import { ACTIONS, REASONS } from '../i18n/ar';

// قرار SKIP بسبب بيانات مفقودة أو خاطئة لا يعني "التربة رطبة بما يكفي"؛ لذلك نميّز هذه الأسباب لنعرض "لا بيانات".
const NO_DATA = new Set(['NO_SOIL_DATA', 'SENSOR_INVALID', 'SOIL_STALE', 'INPUTS_STALE']);

/** طابور الري: المناطق التي تحتاج ماء (IRRIGATE)، الأكثر إلحاحًا أولًا (والمنطقة المختارة chosen في المقدمة).
 *  الترتيب: المختارة أولًا ← ثم الأعلى urgency ← ثم الأصغر رقمًا. */
export function queueOf(zones) {
  return zones
    .filter((z) => z.decision?.action === 'IRRIGATE')
    .sort((a, b) => (b.decision.chosen ? 1 : 0) - (a.decision.chosen ? 1 : 0) || (b.decision.urgency ?? 0) - (a.decision.urgency ?? 0) || a.id - b.id);
}

/**
 * كلمة واحدة تصف ما تفعله المنطقة الآن من وجهة نظر المستخدم:
 * running (الماء يتدفق)، next (مختارة وعلى وشك أن تُفتح)، waiting (تحتاج ماء لكن منطقة أخرى قبلها)،
 * deferred (مطر متوقع)، ok (رطبة بما يكفي)، resting (سُقيت للتو / بلغت الحدود)، paused (أمان)، nodata (لا بيانات).
 *
 * ترتيب الأولوية مهم، ويُفحص من الأعلى للأسفل وأول شرط يتحقق يفوز:
 *   1) المنطقة التي يجري ريّها فعلًا الآن (الحقيقة على الأرض تغلب أي قرار).
 *   2) وضع النظام كله: إيقاف بسبب المطر، انتظار بعد المطر، عطل — يوقف كل المناطق.
 *   3) لا يوجد قرار بعد، أو القرار مبني على بيانات ناقصة.
 *   4) نوع القرار نفسه: IRRIGATE ثم DEFER ثم HOLD، وأخيرًا الرطوبة كافية.
 * كل نتيجة تحمل key (للمنطق) و label (النص) و tone (اللون في CSS).
 */
export function zoneState(zone, status) {
  const d = zone.decision;
  const run = status.active_run;
  if (run && run.zone_id === zone.id) return { key: 'running', label: run.kind === 'manual' ? 'اختبار يدوي' : 'يُروى الآن', tone: 'water' };
  const mode = status.system?.mode;
  if (mode === 'RAIN_LOCKOUT') return { key: 'paused', label: 'متوقف: مطر', tone: 'rain' };
  if (mode === 'COOLDOWN') return { key: 'paused', label: 'انتظار بعد المطر', tone: 'cool' };
  if (mode === 'ERROR') return { key: 'paused', label: 'متوقف: عطل', tone: 'crit' };
  if (!d) return { key: 'nodata', label: 'بانتظار أول قرار', tone: 'hold' };
  if (NO_DATA.has(d.reason_code)) return { key: 'nodata', label: 'لا بيانات', tone: 'crit' };
  if (d.action === 'IRRIGATE') {
    // تحتاج ماء: إما هي التالية (مختارة ولا يوجد ري جارٍ) أو تنتظر دورها برقم ترتيبها في الطابور.
    const q = queueOf(status.zones);
    const pos = q.findIndex((z) => z.id === zone.id) + 1;
    if (d.chosen && !run) return { key: 'next', label: 'يبدأ الري', tone: 'water' };
    return { key: 'waiting', label: pos > 0 ? `ينتظر دوره · ${pos}` : 'ينتظر دوره', tone: 'water-soft', position: pos };
  }
  if (d.action === 'DEFER') return { key: 'deferred', label: 'مؤجل: تنبؤ بمطر', tone: 'warn' };
  if (d.action === 'HOLD') {
    // HOLD له أسباب مختلفة: مطر، انتظار بعد المطر، تشرّب الماء بعد ري، أو بلوغ حد النبضات/الحد اليومي.
    if (d.reason_code === 'RAIN_LOCKOUT' || status.system?.mode === 'RAIN_LOCKOUT') return { key: 'paused', label: 'متوقف: مطر', tone: 'rain' };
    if (d.reason_code === 'COOLDOWN' || status.system?.mode === 'COOLDOWN') return { key: 'paused', label: 'انتظار بعد المطر', tone: 'cool' };
    if (d.reason_code === 'SOAKING') return { key: 'resting', label: 'يتشرب الماء', tone: 'good' };
    if (d.reason_code === 'MAX_PULSES' || d.reason_code === 'DAILY_LIMIT') return { key: 'resting', label: 'استراحة', tone: 'hold' };
    return { key: 'paused', label: 'متوقف', tone: 'hold' };
  }
  if (d.reason_code === 'AT_TARGET') return { key: 'ok', label: 'رطوبة كافية', tone: 'good' };
  return { key: 'resting', label: ACTIONS[d.action], tone: 'good' };
}

// الجملة الكاملة التي تشرح سبب القرار بالعربية (من ملف الترجمة)، أو الرمز نفسه إن لم تكن له ترجمة.
export const reasonText = (d) => (d ? REASONS[d.reason_code] || d.reason_code : 'لم يصل قرار من عقدة التشغيل بعد.');

/** لترات ودقائق الري اليوم (يوم الرياض) لكل منطقة، محسوبة من قائمة عمليات الري.
 *  اللترات تقديرية: إن لم يرسل الخادم est_liters تُحسب = (الثواني ÷ 60) × تدفق المضخة باللتر/دقيقة. */
export function todayByZone(runs = [], flowLpm = 2) {
  // تحويل الوقت إلى تاريخ بصيغة YYYY-MM-DD بتوقيت الرياض للمقارنة مع اليوم.
  const day = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh' }).format(new Date(iso));
  const today = day(Date.now());
  const out = {};
  for (const r of runs) {
    if (!r.started_at || day(r.started_at) !== today) continue;
    const secs = Number(r.actual_seconds ?? 0);
    const o = (out[r.zone_id] ||= { runs: 0, seconds: 0, liters: 0 });
    o.runs += 1;
    o.seconds += secs;
    o.liters += r.est_liters != null ? Number(r.est_liters) : (secs / 60) * flowLpm;
  }
  return out;
}

/** القرار في كلمة واحدة؛ المنطقة التي سُقيت للتو تنتظر تشرّب الماء، وليست "متوقفة". */
export const actionWord = (d) => (!d ? '—' : d.reason_code === 'SOAKING' ? 'انتظار التشرّب' : ['MAX_PULSES', 'DAILY_LIMIT'].includes(d.reason_code) ? 'استراحة' : NO_DATA.has(d.reason_code) ? 'لا بيانات' : ACTIONS[d.action]);

/** السبب في كلمات قليلة: الجزء الأول من الجملة الكاملة (حتى أول نقطة أو فاصلة أو نقطتين). */
export const shortReason = (d) => reasonText(d).split(/[.،:]/)[0].trim() + '.';
