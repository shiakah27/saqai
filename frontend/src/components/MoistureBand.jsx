/**
 * MoistureBand.jsx — رسم SVG مخصص لرطوبة منطقة واحدة خلال آخر يوم (في تفاصيل المنطقة بصفحة المناطق).
 * البيانات (props): points (سلسلة الرطوبة)، value (القراءة الحالية)، target، critical، runs، from/to (نافذة الوقت).
 */
import { useEffect, useRef, useState } from 'react';
import { fmtTime } from '../lib/format';

// hook تقيس عرض العنصر الفعلي (ResizeObserver) حتى يُرسم الـSVG بعرض الحاوية بالضبط؛ الحد الأدنى 120px.
function useWidth(initial = 320) {
  const ref = useRef(null);
  const [w, setW] = useState(initial);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(([e]) => setW(Math.max(120, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

/**
 * رطوبة التربة خلال آخر يوم، مرسومة مقابل حدود المنطقة نفسها:
 * الأرضية المخططة هي ما تحت الحد الحرج، والخط المتقطع هو الهدف.
 * الخط ينتهي عند القراءة الحية. عمليات الري معلّمة بعلامات ماء صغيرة على خط الأساس.
 * x(t) يحوّل الوقت إلى موقع أفقي، y(v) يحوّل الرطوبة إلى موقع رأسي (top أعلى قيمة، 60 على الأقل).
 */
export default function MoistureBand({
  points = [], value, target, critical, runs = [], height = 132, max = 60, live = false, axis = true, from, to,
}) {
  const [ref, w] = useWidth();
  const pad = { t: 8, b: axis ? 22 : 6, l: 0, r: 0 };
  const H = height;
  const plotH = H - pad.t - pad.b;
  const vals = points.filter((p) => p.v != null);
  const t0 = new Date(from || vals[0]?.t || Date.now() - 864e5).getTime();
  const t1 = Math.max(new Date(to || Date.now()).getTime(), t0 + 60_000);
  const top = Math.max(max, ...vals.map((p) => p.v), value ?? 0);
  const x = (t) => pad.l + ((new Date(t).getTime() - t0) / (t1 - t0)) * (w - pad.l - pad.r);
  const y = (v) => pad.t + plotH - (Math.max(0, Math.min(v, top)) / top) * plotH;

  // السلسلة + القراءة الحالية في آخرها؛ line مسار الخط، area نفس المسار مغلق حتى الصفر للتعبئة.
  // hatch اسم فريد لنمط التخطيط حتى لا تتعارض عدة رسوم في نفس الصفحة.
  const series = [...vals];
  if (value != null) series.push({ t: t1, v: value });
  const line = series.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join('');
  const area = series.length > 1 ? `${line}L${x(series.at(-1).t).toFixed(1)},${y(0)}L${x(series[0].t).toFixed(1)},${y(0)}Z` : '';
  const end = series.at(-1);
  const hatch = `hatch-${Math.round(t0 / 1000)}-${critical}-${target}`;

  return (
    <div className="band" ref={ref} dir="ltr">
      <svg width={w} height={H} role="img" aria-label={`رطوبة التربة خلال آخر 24 ساعة، الهدف ${target}% والحد الحرج ${critical}%`}>
        <defs>
          <pattern id={hatch} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="6" className="band-hatch-line" />
          </pattern>
        </defs>
        <rect x="0" y={y(critical)} width={w} height={y(0) - y(critical)} className="band-crit" />
        <rect x="0" y={y(critical)} width={w} height={y(0) - y(critical)} fill={`url(#${hatch})`} />
        <rect x="0" y={y(top)} width={w} height={y(target) - y(top)} className="band-ok" />
        {area && <path d={area} className="band-area" />}
        {line && <path d={line} className="band-line" />}
        <line x1="0" x2={w} y1={y(target)} y2={y(target)} className="band-target" />
        {runs.map((r) => r.started_at && new Date(r.started_at).getTime() >= t0 && (
          <rect key={r.run_id || r.started_at} x={x(r.started_at) - 1.5} y={y(0) - 7} width="3" height="7" rx="1.5" className="band-run" />
        ))}
        {end && (
          <g className={live ? 'band-now is-live' : 'band-now'}>
            <circle cx={Math.min(x(end.t), w - 6)} cy={y(end.v)} r="9" className="band-halo" />
            <circle cx={Math.min(x(end.t), w - 6)} cy={y(end.v)} r="4.5" className="band-dot" />
          </g>
        )}
        {axis && (
          <>
            <text x="2" y={H - 6} className="band-tick">{fmtTime(new Date(t0).toISOString())}</text>
            <text x={w / 2} y={H - 6} className="band-tick" textAnchor="middle">{fmtTime(new Date((t0 + t1) / 2).toISOString())}</text>
            <text x={w - 2} y={H - 6} className="band-tick" textAnchor="end">الآن</text>
          </>
        )}
      </svg>
    </div>
  );
}

/** نقاط منطقة واحدة من السجل المشترك ({t, z1, z2, z3}) بصيغة { t, v }. */
export const zoneSeries = (history, id) => (history?.points || []).map((p) => ({ t: p.t, v: p[`z${id}`] }));
