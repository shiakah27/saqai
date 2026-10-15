/**
 * DecisionPath.jsx — قسم "مسار القرار" في صفحة القرار.
 * يعرض سلم القرار (STEPS) لمنطقة واحدة، مع الحكم النهائي بجانبه.
 * البيانات: zone.decision (خاصة trace: القواعد التي فحصها المحرك)، zones لأزرار اختيار المنطقة.
 */
import Icon from './Icon';
import { REASONS, STEPS } from '../i18n/ar';
import { actionWord } from '../lib/zones';
import { fmtTime } from '../lib/format';

// ESP32 #2 تكتب ملاحظة قصيرة بالإنجليزي لكل قاعدة (مثل "27.5% vs target 40%").
// هذه الدالة تترجمها للعربي للعرض فقط؛ إن لم تتعرف على الصيغة تعرضها كما هي.
// \u2066…\u2069 يعزل الرقم مع علامة % حتى لا تنقلب العلامة في النص العربي (RTL).
// ltr: يعزل نصًا (رقم أو نسبة) باتجاه LTR داخل جملة عربية. pct: احتمال 0..1 → نسبة مئوية معزولة.
const ltr = (x) => `\u2066${x}\u2069`;
const pct = (p) => ltr(`${Math.round(Number(p) * 100)}%`);
// قواعد الترجمة: [تعبير نمطي يطابق الملاحظة الإنجليزية، دالة تبني الجملة العربية من الأجزاء المطابقة m].
const NOTE_RULES = [
  [/^NORMAL$/, () => 'الوضع طبيعي'],
  [/^rain detected now$/, () => 'يوجد مطر الآن'],
  [/^RAIN_LOCKOUT$/, () => 'قفل المطر مفعّل'],
  [/^COOLDOWN$/, () => 'فترة انتظار بعد المطر'],
  [/^ERROR$/, () => 'عطل في النظام'],
  [/^inputs too old$/, () => 'البيانات قديمة'],
  [/^no reading yet$/, () => 'لا توجد قراءة بعد'],
  [/^invalid$/, () => 'قراءة غير صالحة'],
  [/^disabled$/, () => 'المنطقة معطّلة'],
  [/^([\d.]+)% vs target ([\d.]+)%$/, (m) => `الرطوبة ${ltr(`${m[1]}%`)} والهدف ${ltr(`${m[2]}%`)}`],
  [/^([\d.]+)% vs critical ([\d.]+)%$/, (m) => `الرطوبة ${ltr(`${m[1]}%`)} والحد الحرج ${ltr(`${m[2]}%`)}`],
  [/^([\d.]+)%$/, (m) => `الرطوبة ${ltr(`${m[1]}%`)}`],
  [/^(\d+)s since last pulse$/, (m) => `مرّت ${m[1]} ث منذ آخر نبضة`],
  [/^(\d+)\/(\d+) pulses$/, (m) => `${m[1]} من ${m[2]} نبضات`],
  [/^(\d+)\/(\d+)s today$/, (m) => `${m[1]} من ${m[2]} ث اليوم`],
  [/^no forecast$/, () => 'لا يوجد تنبؤ'],
  [/^p ([\d.]+) >= ([\d.]+)$/, (m) => `احتمال المطر ${pct(m[1])} ≥ الحد ${pct(m[2])}`],
  [/^p ([\d.]+) < ([\d.]+)$/, (m) => `احتمال المطر ${pct(m[1])} < الحد ${pct(m[2])}`],
  [/^deferred (\d+)s, limit$/, (m) => `أُجّل ${Math.round(m[1] / 60)} دقيقة ووصل الحد`],
];
// تجربة القواعد بالترتيب؛ أول قاعدة تطابق تُستخدم، وإلا تُعاد الملاحظة كما هي.
function noteAr(note) {
  for (const [re, f] of NOTE_RULES) { const m = note.match(re); if (m) return f(m); }
  return note;
}

/**
 * القرار، درجة بدرجة. المحرك يسجّل كل قاعدة فحصها (الـtrace)؛ هذه البطاقة تعرض
 * أي القواعد نجحت، وأين اتُّخذ القرار، وأي القواعد لم يُوصل إليها أبدًا.
 * درجتا MANUAL و ZONE تُخفيان إلا إذا ظهرتا في الـtrace. lastIdx = آخر درجة وصلها المحرك.
 */
export default function DecisionPath({ zone, zones, onSelect }) {
  const d = zone?.decision;
  const trace = d?.trace || [];
  const byStep = Object.fromEntries(trace.map((t) => [t.step, t]));
  const steps = STEPS.filter((s) => !['MANUAL', 'ZONE'].includes(s.key) || byStep[s.key]);
  const lastIdx = Math.max(-1, ...trace.map((t) => steps.findIndex((s) => s.key === t.step)));
  const tone = { IRRIGATE: 'water', DEFER: 'warn', SKIP: 'good', HOLD: 'hold' }[d?.action] || 'hold';

  // حالة كل درجة في السلم: passed (نجحت وتابع المحرك)، decided (هنا صدر القرار result=stop)،
  // skipped (لم تُسجَّل لكنها قبل آخر درجة وصلها المحرك)، unreached (بعد نقطة القرار فلم تُفحص).
  return (
    <section className="panel path" id="decision" aria-labelledby="path-title">
      <header className="panel-head">
        <div>
          <h2 id="path-title">مسار القرار</h2>
        </div>
        <div className="seg" role="tablist" aria-label="اختر المنطقة">
          {zones.map((z) => (
            <button key={z.id} id={`path-z${z.id}`} role="tab" aria-selected={z.id === zone?.id} className={z.id === zone?.id ? 'on' : ''}
              onClick={() => onSelect(z.id)}>{z.name}</button>
          ))}
        </div>
      </header>

      {!d ? <p className="empty muted">لا يوجد قرار بعد لهذه المنطقة.</p> : (
        <div className="path-body">
          <ol className="ladder">
            {steps.map((s, i) => {
              const t = byStep[s.key];
              let state = 'skipped';
              if (t) state = t.result === 'stop' ? 'decided' : 'passed';
              else if (i > lastIdx) state = 'unreached';
              return (
                <li key={s.key} className={`rung ${state}`}>
                  <span className="rung-dot" aria-hidden="true">
                    {state === 'passed' && <Icon name="check" size={13} />}
                    {state === 'decided' && <Icon name="target" size={13} />}
                  </span>
                  <div className="rung-text">
                    <b>{s.label}</b>
                    <span className="small muted">{s.q}</span>
                    {t?.note && <span className="rung-note">{noteAr(t.note)}</span>}
                  </div>
                </li>
              );
            })}
          </ol>
          <aside className={`verdict tone-${tone}`}>
            <span className="verdict-label">القرار لـ{zone.name}</span>
            <span className="verdict-act">{actionWord(d)}</span>
            {d.seconds > 0 && <span className="verdict-amount"><span className="num">{d.seconds}</span> ثانية · ≈ <span className="num">{d.est_liters}</span> لتر</span>}
            <p>{REASONS[d.reason_code] || d.reason_code}</p>
            <span className="verdict-time">صدر الساعة <span className="num">{fmtTime(d.decided_at)}</span> من عقدة التشغيل</span>
          </aside>
        </div>
      )}
    </section>
  );
}
