/**
 * Overview.jsx — الصفحة الرئيسية "المزرعة الآن" (#/overview).
 * التصميم: المجسّم هو قلب الصفحة (stage)، وتحته "شريط التعريف" (caption rail) مثل بطاقات المتاحف:
 * كل منطقة تحت قطعتها في المجسّم بالضبط (المنطقة 1 يمينًا، 3 يسارًا). تحته صف من ثلاث بطاقات:
 * المضخة، الطقس الآن، تنبؤ المطر. ثم آخر الأحداث.
 * البيانات: status (المناطق، الطقس، التنبؤ، الري الجاري، الأحداث) و progress (تقدّم الري الجاري).
 */
import FieldMap from '../components/FieldMap';
import Readiness from '../components/Readiness';
import Icon from '../components/Icon';
import { describeEvent } from '../i18n/ar';
import { fmtNum, fmtTime } from '../lib/format';
import { href } from '../lib/router';
import { queueOf, zoneState } from '../lib/zones';

const go = (id) => { window.location.hash = href('zones', id); };
const clamp01 = (v) => Math.max(0, Math.min(1, v));

/** المجسّم + شريط التعريف تحته. بطاقات الأرقام داخل المجسّم مخفية هنا لأن الشريط يعرضها بوضوح أكبر. */
function Stage({ status, colors }) {
  const mode = status.system.mode;
  const zs = Object.fromEntries(status.zones.map((z) => [z.id, zoneState(z, status)]));
  const states = Object.fromEntries(Object.entries(zs).map(([k, v]) => [k, v.key]));
  return (
    <section className={`hx-stage mode-${mode}`} aria-label="المزرعة الآن">
      <div className="hx-model">
        <FieldMap mode={mode} zones={status.zones} colors={colors} states={states} onPick={go} callouts />
      </div>
      <ol className="hx-rail">
        {status.zones.map((z) => {
          const st = zs[z.id];
          const gap = z.soil_moisture == null ? null : z.soil_moisture - z.target;
          return (
            <li key={z.id} style={{ '--zone': colors[z.id] }}>
              <a href={href('zones', z.id)} className={`hx-zone st-${st.key}`}>
                <span className="hx-zone-head">
                  <span className="hx-swatch" aria-hidden="true" />
                  <b>{z.name}</b>
                  <span className={`hx-state tone-${st.tone}`}>{st.label}</span>
                </span>
                <span className="hx-zone-value qty">{fmtNum(z.soil_moisture, 1)}<small>%</small></span>
                {/* شريط الرطوبة: التعبئة = الرطوبة الآن، والخط = هدف المنطقة (المقياس من 0 إلى 60%) */}
                <span className="hx-meter" aria-hidden="true">
                  <span className="hx-meter-fill" style={{ width: `${clamp01((z.soil_moisture ?? 0) / 60) * 100}%` }} />
                  <span className="hx-meter-target" style={{ insetInlineStart: `${clamp01(z.target / 60) * 100}%` }} />
                </span>
                <span className="hx-zone-foot">
                  الهدف <span className="num">{z.target}%</span>
                  {gap != null && <>، {gap < 0 ? 'ينقصها' : 'فوقه بـ'} <span className="num">{fmtNum(Math.abs(gap), 1)}%</span></>}
                </span>
              </a>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/** بطاقة المضخة: أثناء الري شريط تقدّم وثوانٍ متبقية، وإلا سبب توقفها ومن التالي. */
function PumpCard({ status, progress }) {
  const mode = status.system.mode;
  const run = status.active_run;
  const runZone = run && status.zones.find((z) => z.id === run.zone_id);
  const next = queueOf(status.zones).find((z) => z.id !== run?.zone_id);
  return (
    <section className={`hx-card hx-pump ${run ? 'is-on' : ''}`} aria-labelledby="hx-pump">
      <header><span className="hx-icon"><Icon name="pump" size={18} /></span><h2 id="hx-pump">المضخة</h2></header>
      {run ? (
        <>
          <p className="hx-big">تسقي {runZone?.name}</p>
          <span className="hx-progress" aria-hidden="true"><span style={{ transform: `scaleX(${progress?.frac ?? 0})` }} /></span>
          <p className="hx-sub"><span className="num">{progress?.left ?? run.planned_seconds}</span> ثانية متبقية{next ? `، بعدها ${next.name}` : ''}</p>
        </>
      ) : (
        <>
          <p className="hx-big">متوقفة</p>
          <p className="hx-sub">{mode === 'RAIN_LOCKOUT' ? 'أوقفها حساس المطر.' : mode === 'COOLDOWN' ? 'تنتظر حتى يتشرب ماء المطر.'
            : next ? `${next.name} تبدأ قريبًا.` : 'لا منطقة تحتاج ماء الآن.'}</p>
        </>
      )}
    </section>
  );
}

/** الطقس الآن من محطة الطقس، مع تغيّر الضغط خلال 3 ساعات (نزوله من علامات المطر). */
function WeatherCard({ w }) {
  const dp = w?.d_pressure_3h;
  return (
    <section className="hx-card" aria-labelledby="hx-wx">
      <header><span className="hx-icon"><Icon name="thermo" size={18} /></span><h2 id="hx-wx">الطقس الآن</h2></header>
      <dl className="hx-stats">
        <div><dt>الحرارة</dt><dd className="qty">{fmtNum(w?.temperature, 1)}<small>°C</small></dd></div>
        <div><dt>رطوبة الجو</dt><dd className="qty">{fmtNum(w?.humidity, 0)}<small>%</small></dd></div>
        <div><dt>الضغط</dt><dd className="qty">{fmtNum(w?.pressure, 0)}<small>hPa</small></dd></div>
      </dl>
      {dp != null && <p className="hx-sub">الضغط خلال 3 ساعات: <span className="num">{dp > 0 ? '+' : ''}{fmtNum(dp, 1)}</span> hPa</p>}
    </section>
  );
}

/** تنبؤ المطر: الاحتمال الآن مقارنة بحد التأجيل، وما يعنيه للري. */
function ForecastCard({ p }) {
  const prob = p?.rain_probability;
  const thr = p?.threshold;
  const over = prob != null && thr != null && prob >= thr;
  return (
    <a className={`hx-card hx-forecast ${over ? 'is-over' : ''}`} href={href('weather')} aria-labelledby="hx-fc">
      <header><span className="hx-icon"><Icon name="rain" size={18} /></span><h2 id="hx-fc">تنبؤ المطر</h2></header>
      <p className="hx-figure qty">{prob == null ? '—' : Math.round(prob * 100)}<small>%</small></p>
      {/* مقياس صغير: موضع الاحتمال وخط حد التأجيل (المقياس 0 إلى 30% لأن الاحتمالات صغيرة عادة) */}
      <span className="hx-scale" aria-hidden="true">
        <span className="hx-scale-fill" style={{ width: `${clamp01((prob ?? 0) / 0.3) * 100}%` }} />
        {thr != null && <span className="hx-scale-mark" style={{ insetInlineStart: `${clamp01(thr / 0.3) * 100}%` }} />}
      </span>
      <p className="hx-sub">{prob == null ? 'لا يوجد تنبؤ بعد.' : over ? 'فوق حد التأجيل: الري مؤجل.' : `خلال 3 ساعات. يؤجَّل الري إذا تجاوز ${Math.round((thr ?? 0) * 100)}%.`}</p>
    </a>
  );
}

/** آخر 5 أحداث مهمة (بدون أحداث اتصال الأجهزة). */
function RecentEvents({ events, zones }) {
  const byId = Object.fromEntries(zones.map((z) => [z.id, z]));
  const list = events.filter((e) => !/^DEVICE_|DECISION_CYCLE/.test(e.type)).slice(0, 5);
  return (
    <section className="hx-card hx-events" aria-labelledby="ov-ev">
      <header>
        <h2 id="ov-ev">آخر الأحداث</h2>
        <a className="hx-link" href={href('events')}>كل الأحداث</a>
      </header>
      {list.length === 0 ? <p className="empty">لا أحداث بعد.</p> : (
        <ol className="hx-timeline">
          {list.map((e) => {
            const d = describeEvent(e, byId);
            return (
              <li key={e.id || `${e.at}-${e.type}`} className={`tone-${d.tone}`}>
                <time className="num">{fmtTime(e.at)}</time>
                <span className="hx-dot" aria-hidden="true" />
                <span className="hx-ev">{d.title}</span>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

export default function Overview({ status, progress, colors }) {
  return (
    <>
      <Readiness status={status} />
      <Stage status={status} colors={colors} />
      <div className="hx-row">
        <PumpCard status={status} progress={progress} />
        <WeatherCard w={status.weather} />
        <ForecastCard p={status.prediction} />
      </div>
      <RecentEvents events={status.events || []} zones={status.zones} />
    </>
  );
}
