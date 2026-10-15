/**
 * Story.jsx — صفحة "الفكرة": شرح سَقاي بالتمرير (scroll storytelling) لزوار المعرض.
 * ----------------------------------------------------------------------------
 * المجسّم (FieldMap) يبقى ثابتًا في الشاشة (sticky)، ومع التمرير تتحرك "الكاميرا" عليه، وتظهر
 * حلقة تشير إلى الجزء المشروح، ويظهر بجانبه نص قصير وبطاقة فيها الأرقام الحية:
 *   المقدمة ← 1 التربة ← 2 الطقس ← 3 التنبؤ ← 4 القرار ← 5 المطر ← الخاتمة
 * الأرقام حقيقية من النظام (status). مشهد المطر توضيحي فقط ولا يغيّر شيئًا.
 *
 * الأداء: التمرير يُقرأ مرة لكل إطار (requestAnimationFrame)، والمجسّم لا يُعاد رسمه إلا عند تغيّر الفصل.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import FieldMap, { ANCHORS } from '../components/FieldMap';
import { LogoMark } from '../components/Logo';
import { fmtNum } from '../lib/format';
import { href } from '../lib/router';
import { zoneState } from '../lib/zones';

// ---- الفصول: الكاميرا (s تكبير، x/y النقطة في وسط الإطار كنسبة من المجسّم، tilt ميلان)، لون السماء، ونغمة النص ----
// spots: أماكن الحلقات التي تشير إلى ما يشرحه الفصل (نسبة من عرض/ارتفاع المجسّم)
const CH = [
  { cam: { s: 1.0, x: 0.5, y: 0.5, tilt: 38 }, sky: '#e7efea', tone: 'light' },                                           // المقدمة
  { name: 'التربة', cam: { s: 1.4, x: 0.53, y: 0.5, tilt: 0 }, sky: '#eaefe6', tone: 'light', spots: ANCHORS.zones },
  { name: 'الطقس', cam: { s: 2.0, x: ANCHORS.station[0], y: ANCHORS.station[1] + 0.06, tilt: 0 }, sky: '#e2eef2', tone: 'light', spots: [ANCHORS.station] },
  { name: 'التنبؤ', cam: { s: 0.95, x: 0.5, y: 0.5, tilt: 8 }, sky: '#1b3140', tone: 'dark' },
  { name: 'القرار', cam: { s: 1.6, x: ANCHORS.control[0] + 0.14, y: ANCHORS.control[1] + 0.02, tilt: 0 }, sky: '#0e261c', tone: 'dark', spots: [ANCHORS.control] },
  { name: 'المطر', cam: { s: 1.0, x: 0.5, y: 0.5, tilt: 0 }, sky: '#17293a', tone: 'dark' },
  { cam: { s: 0.7, x: 0.5, y: 0.5, tilt: 30 }, sky: '#003d2b', tone: 'dark' },                                            // الخاتمة
];
const N = CH.length;
const STEPS = CH.map((c, i) => ({ ...c, i })).filter((c) => c.name);   // الخطوات الست المرقّمة

// قواعد القرار كما تنفذها ESP32 رقم 2 بالترتيب
const RULES = ['هل يوجد مطر أو عطل؟', 'هل قراءة الحساس سليمة؟', 'هل التربة تحت الهدف؟', 'هل انتهى انتظار التشرّب؟',
  'هل بقيت نبضات في الدورة؟', 'هل بقي من حد اليوم؟', 'هل الجفاف حرج؟', 'هل لا يوجد تنبؤ بمطر؟'];

const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const ease = (t) => t * t * (3 - 2 * t);
const mix = (a, b, t) => a + (b - a) * t;
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const mixColor = (a, b, t) => `rgb(${hex(a).map((v, i) => Math.round(mix(v, hex(b)[i], t))).join(',')})`;

/** موضع التمرير داخل الصفحة كرقم من 0 إلى N-1 (رقم الفصل + التقدم داخله). */
function useStoryProgress(ref) {
  const [p, setP] = useState(0);
  useEffect(() => {
    let raf = 0;
    const read = () => {
      raf = 0;
      const el = ref.current;
      if (!el) return;
      const total = el.offsetHeight - window.innerHeight;
      setP(clamp(-el.getBoundingClientRect().top / Math.max(total, 1)) * (N - 1));
    };
    const on = () => { if (!raf) raf = requestAnimationFrame(read); };
    read();
    window.addEventListener('scroll', on, { passive: true });
    window.addEventListener('resize', on);
    return () => { window.removeEventListener('scroll', on); window.removeEventListener('resize', on); cancelAnimationFrame(raf); };
  }, [ref]);
  return p;
}

/** شفافية نص الفصل: يظهر في بدايته، ويختفي قبل الانتقال للفصل التالي. */
function visibility(index, p) {
  const t = p - index;
  if (index === 0) return clamp(1 - (t - 0.35) / 0.3);
  if (index === N - 1) return clamp((t + 0.5) / 0.4);
  return clamp(Math.min((t + 0.45) / 0.3, 1 - (t - 0.35) / 0.3));
}

/** غلاف الفصل: رقم الخطوة واسمها، ثم العنوان والشرح، ثم المحتوى (بطاقة الأرقام). */
function Chapter({ index, p, title, text, children, className = '' }) {
  const o = visibility(index, p);
  const step = STEPS.find((s) => s.i === index);
  return (
    <section className={`st-chapter ${className}`} aria-hidden={o < 0.05}
      style={{ opacity: o, transform: `translateY(${(1 - o) * (p < index ? 20 : -20)}px)`, visibility: o < 0.01 ? 'hidden' : 'visible' }}>
      {step && <p className="st-step"><span className="num">{STEPS.indexOf(step) + 1}</span> من <span className="num">{STEPS.length}</span>: {step.name}</p>}
      <h2>{title}</h2>
      {text && <p className="st-text">{text}</p>}
      {children}
    </section>
  );
}

/** بطاقة الأرقام: صفوف (اسم ← قيمة) واضحة، مع شريط اختياري. */
function Card({ rows, foot }) {
  return (
    <div className="st-card">
      {rows.map((r) => (
        <div key={r.label} className="st-row" style={r.color ? { '--zone': r.color } : undefined}>
          <span className="st-row-label">{r.color && <i aria-hidden="true" />}{r.label}</span>
          <b className="st-row-value qty">{r.value}{r.unit && <small>{r.unit}</small>}</b>
          {r.note && <span className="st-row-note">{r.note}</span>}
          {r.bar != null && <span className="st-bar" aria-hidden="true"><span style={{ width: `${clamp(r.bar) * 100}%` }} />{r.mark != null && <em style={{ insetInlineStart: `${clamp(r.mark) * 100}%` }} />}</span>}
        </div>
      ))}
      {foot && <p className="st-card-foot">{foot}</p>}
    </div>
  );
}

export default function Story({ status, colors }) {
  const wrap = useRef(null);
  const p = useStoryProgress(wrap);
  const c = Math.min(N - 2, Math.floor(p));
  const t = ease(clamp((p - c - 0.5) / 0.5));          // الانتقال للفصل التالي في النصف الثاني من كل فصل
  const chapter = Math.round(p);

  const a = CH[c].cam, b = CH[c + 1].cam;
  const cam = { s: mix(a.s, b.s, t), x: mix(a.x, b.x, t), y: mix(a.y, b.y, t), tilt: mix(a.tilt, b.tilt, t) };
  const sky = mixColor(CH[c].sky, CH[c + 1].sky, t);

  const zones = status.zones;

  // المجسّم: الفصل 5 يعرض المطر وكل الصمامات مغلقة (توضيح)
  const model = useMemo(() => {
    const shown = zones.map((z) => ({ ...z, valve: chapter === 5 ? 'CLOSED' : z.valve }));
    const mode = chapter === 5 ? 'RAIN_LOCKOUT' : status.system.mode;
    const fake = { ...status, system: { ...status.system, mode }, zones: shown, active_run: null };
    const labels = Object.fromEntries(shown.map((z) => [z.id, zoneState(z, fake)]));
    const states = Object.fromEntries(Object.entries(labels).map(([k, v]) => [k, v.key]));
    return <FieldMap mode={mode} zones={shown} colors={colors} states={states} />;
  }, [chapter, status, colors]);

  // الحلقات التي تشير إلى الجزء المشروح (تظهر مع نص الفصل)
  const spots = CH[chapter].spots || [];
  const spotOpacity = visibility(chapter, p);

  const w = status.weather || {};
  const pred = status.prediction || {};
  const thr = pred.threshold ?? status.model?.threshold;
  const onset = status.model?.onset_recall_test;
  const lit = Math.floor(clamp((p - 3.65) / 0.75) * RULES.length);   // القواعد تُفحص واحدة تلو الأخرى
  const go = (i) => {
    const el = wrap.current;
    window.scrollTo({ top: el.offsetTop + (i / (N - 1)) * (el.offsetHeight - window.innerHeight), behavior: 'smooth' });
  };
  const pct = (v) => (v == null ? '—' : Math.round(v * 100));
  const ltr = (x) => `\u2066${x}\u2069`;   // يعزل الرقم مع % أو الإشارة حتى لا تنقلب في النص العربي

  return (
    <div className={`story tone-${CH[chapter].tone}`} ref={wrap} style={{ '--sky': sky }}>
      <div className="st-stage">
        <div className="st-clouds" style={{ opacity: clamp(1 - Math.abs(p - 3) / 0.9) + clamp(1 - Math.abs(p - 5) / 0.9) }} aria-hidden="true">
          <span /><span /><span />
        </div>
        <div className="st-rain" style={{ opacity: clamp(1 - Math.abs(p - 5) / 0.6) }} aria-hidden="true" />

        {/* نافذة المجسّم: scale ثم translate لتصبح النقطة (x,y) في الوسط، مع ميلان tilt */}
        <div className="st-model-wrap" aria-hidden="true" style={{ opacity: 1 - clamp((p - 5.3) / 0.4) }}>
          <div className="st-model" style={{ transform: `perspective(1600px) rotateX(${cam.tilt}deg) scale(${cam.s}) translate(${(0.5 - cam.x) * 100}%, ${(0.5 - cam.y) * 100}%)` }}>
            {model}
            {spots.map(([x, y]) => (
              <span key={`${x}-${y}`} className="st-spot" style={{ left: `${x * 100}%`, top: `${y * 100}%`, opacity: spotOpacity, '--inv': 1 / cam.s }} />
            ))}
          </div>
        </div>

        <Chapter index={0} p={p} className="st-hero" title="كل قطرة بقرار."
          text="سَقاي نظام ري ذكي لثلاث مناطق زراعية. يقيس التربة والطقس، يتنبأ بالمطر، ثم يقرر بنفسه متى يسقي وكم.">
          <button type="button" className="st-scroll" onClick={() => go(1)}>
            كيف يعمل؟ <span className="st-arrow" aria-hidden="true">↓</span>
          </button>
        </Chapter>

        <Chapter index={1} p={p} title="يقيس رطوبة التربة"
          text="في كل منطقة حساس يقرأ الرطوبة كل ثانيتين. ولكل منطقة هدف حسب نباتاتها؛ إذا نزلت عنه تحتاج ماء.">
          <Card rows={zones.map((z) => ({
            label: z.name, color: colors[z.id], value: fmtNum(z.soil_moisture, 0), unit: '%',
            note: `الهدف ${ltr(`${z.target}%`)}`, bar: (z.soil_moisture ?? 0) / 60, mark: z.target / 60,
          }))} />
        </Chapter>

        <Chapter index={2} p={p} title="ويقرأ الطقس"
          text="محطة طقس صغيرة تقيس الحرارة ورطوبة الجو والضغط الجوي. إذا بدأ الضغط ينزل والرطوبة ترتفع، فهذه من أول علامات المطر.">
          <Card rows={[
            { label: 'الحرارة', value: fmtNum(w.temperature, 1), unit: '°C' },
            { label: 'رطوبة الجو', value: fmtNum(w.humidity, 0), unit: '%' },
            { label: 'الضغط الجوي', value: fmtNum(w.pressure, 0), unit: 'hPa',
              note: w.d_pressure_3h != null ? `تغيّر آخر 3 ساعات: ${ltr(`${w.d_pressure_3h > 0 ? '+' : ''}${fmtNum(w.d_pressure_3h, 1)} hPa`)}` : null },
          ]} />
        </Chapter>

        <Chapter index={3} p={p} title="ويتنبأ بالمطر قبل أن يأتي"
          text="ذكاء اصطناعي تدرّب على 11 سنة من طقس الرياض. كل نصف ساعة يحسب: ما احتمال المطر خلال الساعات الثلاث القادمة؟">
          <Card rows={[
            { label: 'احتمال المطر خلال 3 ساعات', value: pct(pred.rain_probability), unit: '%',
              note: thr == null || pred.rain_probability == null ? null
                : pred.rain_probability >= thr ? 'مطر قريب: الري مؤجل لتوفير الماء.' : 'لا مطر قريب: الري يعمل كالمعتاد.' },
          ]} foot={onset ? `في الاختبار تنبّأ بـ${ltr(`${Math.round(onset.rate * 100)}%`)} من حالات المطر قبل حدوثها بثلاث ساعات، وأدق من التخمين بعشرة أضعاف.` : null} />
        </Chapter>

        <Chapter index={4} p={p} title="ثم يقرر بنفسه"
          text="وحدة التحكم تطرح هذه الأسئلة على كل منطقة كل ثانية، بالترتيب. أي إجابة تمنع الري توقف القرار عندها.">
          <ol className="st-ladder">
            {RULES.map((r, i) => <li key={r} className={i < lit ? 'is-lit' : ''}>{r}</li>)}
          </ol>
        </Chapter>

        <Chapter index={5} p={p} title="والمطر يوقف كل شيء"
          text="إذا لمس الماء لوحة حساس المطر، تنطفئ المضخة خلال ثوانٍ، حتى لو لم يتنبأ به النموذج. الأمان لا يعتمد على التنبؤ.">
          <Card rows={[{ label: 'حساس المطر الآن', value: w.rain_detected ? 'مبلل' : 'جاف' }]} />
        </Chapter>

        <Chapter index={6} p={p} className="st-end" title="يقيس. يتنبأ. يقرر. يسقي.">
          <LogoMark size={64} />
          <p className="st-text">كل هذا يحدث الآن على المجسّم أمامك.</p>
          <a className="st-cta" href={href('overview')}>افتح لوحة التحكم</a>
        </Chapter>

        {/* شريط الخطوات أسفل الشاشة: اسم كل خطوة، والضغط عليها ينقل إليها */}
        <nav className="st-steps" aria-label="خطوات العرض">
          <span className="st-progress" aria-hidden="true"><span style={{ width: `${(p / (N - 1)) * 100}%` }} /></span>
          <ol>
            {STEPS.map((s, i) => (
              <li key={s.name}>
                <button type="button" className={chapter === s.i ? 'on' : chapter > s.i ? 'done' : ''} onClick={() => go(s.i)}
                  aria-current={chapter === s.i ? 'step' : undefined}>
                  <span className="num">{i + 1}</span>{s.name}
                </button>
              </li>
            ))}
          </ol>
        </nav>
      </div>
    </div>
  );
}
