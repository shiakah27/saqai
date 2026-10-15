/**
 * Zones.jsx — صفحة "المناطق" (#/zones أو ‎#/zones/2).
 * تبويب لكل منطقة في الأعلى (اللون، الاسم، الرطوبة الآن). تحته المنطقة المختارة فقط بالتفصيل:
 *   - الرطوبة الآن بخط كبير مع شريط الهدف، وماذا تفعل المنطقة الآن ولماذا
 *   - ثلاث معلومات: آخر ري، ماء اليوم، الحد الحرج
 *   - رسم رطوبة آخر 24 ساعة (MoistureBand)
 *   - عمليات الري لهذه المنطقة اليوم
 * البيانات: status.zones (القراءات والقرار)، history (الرسم والعمليات)، today (ماء اليوم لكل منطقة).
 */
import Icon from '../components/Icon';
import MoistureBand, { zoneSeries } from '../components/MoistureBand';
import { CANCEL_REASONS, REASONS, RUN_STATUS } from '../i18n/ar';
import { fmtNum, fmtTime } from '../lib/format';
import { href } from '../lib/router';
import { actionWord, shortReason, zoneState } from '../lib/zones';

const clamp01 = (v) => Math.max(0, Math.min(1, v));

/** تبويبات المناطق: الضغط على تبويب يغيّر الرابط (‎#/zones/2) فتبقى المنطقة المختارة بعد التحديث. */
function ZoneTabs({ zones, status, colors, selected }) {
  return (
    <nav className="zx-tabs" aria-label="اختر المنطقة">
      {zones.map((z) => {
        const st = zoneState(z, status);
        return (
          <a key={z.id} href={href('zones', z.id)} style={{ '--zone': colors[z.id] }}
            className={`zx-tab ${z.id === selected.id ? 'is-on' : ''}`} aria-current={z.id === selected.id ? 'page' : undefined}>
            <span className="zx-tab-name"><span className="hx-swatch" aria-hidden="true" />{z.name}</span>
            <span className="zx-tab-value qty">{fmtNum(z.soil_moisture, 1)}<small>%</small></span>
            <span className={`hx-state tone-${st.tone}`}>{st.label}</span>
          </a>
        );
      })}
    </nav>
  );
}

export default function Zones({ status, history, colors, progress, today, arg }) {
  const zone = status.zones.find((z) => z.id === arg) || status.zones[0];
  if (!zone) return <p className="panel empty">لا توجد مناطق بعد.</p>;
  const st = zoneState(zone, status);
  const d = zone.decision;
  const running = st.key === 'running';
  const gap = zone.soil_moisture == null ? null : zone.soil_moisture - zone.target;
  const t = today[zone.id];
  const runs = (history?.runs || []).filter((r) => r.zone_id === zone.id).slice().reverse();
  const flow = status.config?.pump_flow_lpm;

  return (
    <>
      <ZoneTabs zones={status.zones} status={status} colors={colors} selected={zone} />

      <section className="hx-card zx-hero" style={{ '--zone': colors[zone.id] }} aria-labelledby="zx-title">
        <div className="zx-now-moisture">
          <h2 id="zx-title">رطوبة التربة الآن</h2>
          <p className="zx-figure qty">{fmtNum(zone.soil_moisture, 1)}<small>%</small></p>
          <span className="hx-meter" aria-hidden="true">
            <span className="hx-meter-fill" style={{ width: `${clamp01((zone.soil_moisture ?? 0) / 60) * 100}%` }} />
            <span className="hx-meter-target" style={{ insetInlineStart: `${clamp01(zone.target / 60) * 100}%` }} />
          </span>
          <p className="hx-sub">
            الهدف <span className="num">{zone.target}%</span>
            {gap != null && <>، {gap < 0 ? 'ينقصها' : 'فوقه بـ'} <span className="num">{fmtNum(Math.abs(gap), 1)}%</span></>}
          </p>
        </div>

        <div className={`zx-action st-${st.key}`}>
          <h2>ماذا تفعل الآن</h2>
          <p className="zx-action-word">{running ? `الصمام ${zone.id} مفتوح` : actionWord(d)}</p>
          {running && progress && (
            <>
              <span className="hx-progress" aria-hidden="true"><span style={{ transform: `scaleX(${progress.frac})` }} /></span>
              <p className="hx-sub"><span className="num">{progress.left}</span> ثانية متبقية</p>
            </>
          )}
          {!running && d?.action === 'IRRIGATE' && d.seconds > 0 && (
            <p className="hx-sub"><span className="num">{d.seconds}</span> ثانية، حوالي <span className="num">{d.est_liters}</span> لتر</p>
          )}
          <p className="zx-reason">{shortReason(d)}</p>
          <a className="hx-link" href={href('decision', zone.id)}>لماذا هذا القرار؟</a>
        </div>

        <dl className="zx-facts">
          <div><dt>آخر ري</dt><dd className="num">{zone.last_irrigated_at ? fmtTime(zone.last_irrigated_at) : '—'}</dd></div>
          <div><dt>ماء اليوم</dt><dd>{t ? <><span className="num">{fmtNum(t.liters, 1)}</span> <small>لتر</small></> : '—'}</dd></div>
          <div><dt>الحد الحرج</dt><dd className="num">{zone.critical}%</dd></div>
        </dl>
      </section>

      <section className="hx-card" style={{ '--zone': colors[zone.id] }} aria-labelledby="zx-chart">
        <header><span className="hx-icon"><Icon name="chart" size={18} /></span><h2 id="zx-chart">آخر 24 ساعة</h2></header>
        <MoistureBand points={zoneSeries(history, zone.id)} value={zone.soil_moisture} target={zone.target} critical={zone.critical}
          runs={history?.runs?.filter((r) => r.zone_id === zone.id)} live={zone.soil_live} height={240} from={history?.window?.from} to={status.t} />
      </section>

      <section className="hx-card" aria-labelledby="zx-runs">
        <header><span className="hx-icon"><Icon name="drop" size={18} /></span><h2 id="zx-runs">عمليات الري اليوم</h2></header>
        {runs.length === 0 ? <p className="empty">لم تُسقَ هذه المنطقة خلال آخر 24 ساعة.</p> : (
          <ol className="hx-timeline zx-runs">
            {runs.slice(0, 8).map((r) => {
              const tone = r.status === 'COMPLETED' ? 'good' : r.status === 'ACTIVE' ? 'water' : 'crit';
              return (
                <li key={r.run_id || r.started_at} className={`tone-${tone}`}>
                  <time className="num">{fmtTime(r.started_at)}</time>
                  <span className="hx-dot" aria-hidden="true" />
                  <span className="hx-ev">
                    {r.kind === 'manual' ? 'اختبار يدوي' : (REASONS[r.reason_code] || r.reason_code || '').replace(/[.،:].*$/, '')}
                    <span className="zx-run-meta">
                      <span className="num">{r.actual_seconds ?? r.planned_seconds}</span> ثانية
                      {flow && r.actual_seconds ? <>، <span className="num">{fmtNum((r.actual_seconds / 60) * flow, 2)}</span> لتر</> : null}
                      {'، '}{r.stop_reason ? CANCEL_REASONS[r.stop_reason] || r.stop_reason : RUN_STATUS[r.status]}
                    </span>
                  </span>
                </li>
              );
            })}
          </ol>
        )}
      </section>
    </>
  );
}
