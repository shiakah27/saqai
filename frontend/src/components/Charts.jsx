/**
 * Charts.jsx — رسم "بيانات الطقس" بمكتبة recharts (حرارة/رطوبة/ضغط آخر 24 ساعة بتبويبات، صفحة الطقس).
 * البيانات: history.points ({ t, temperature, humidity, pressure, ... }).
 * الألوان من useTokens لأن recharts يحتاج ألوانًا حقيقية لا متغيرات CSS.
 * الرسوم داخل dir="ltr" حتى يسير الوقت من اليسار لليمين كالمعتاد.
 */
import { useState } from 'react';
import {
  ResponsiveContainer, ComposedChart, Line, Area, XAxis, YAxis, CartesianGrid, Tooltip,
} from 'recharts';
import { useTokens } from '../hooks/useTokens';
import { fmtTime, fmtDateTime } from '../lib/format';

// إعدادات مشتركة للمحاور: لون وحجم خط الأرقام، بدون خط المحور وعلاماته.
const axisProps = (c) => ({
  tick: { fill: c['ink-3'], fontSize: 11, fontFamily: 'IBM Plex Sans Arabic, sans-serif' },
  axisLine: false,
  tickLine: false,
});

// صندوق التلميح (tooltip) عند المرور على الرسم: الوقت ثم صف لكل سلسلة (الاسم، القيمة، اللون).
// rows دالة تُرجع الصفوف من نقطة البيانات p.
function TipBox({ active, payload, label, rows }) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  return (
    <div className="tip" dir="rtl">
      <div className="tip-time">{fmtDateTime(label)}</div>
      {rows(p).map(([name, value, color]) => (
        <div className="tip-row" key={name}>
          <span><i style={{ background: color }} />{name}</span>
          <b className="num">{value}</b>
        </div>
      ))}
    </div>
  );
}

// تبويبات رسم الطقس: المفتاح في البيانات، الاسم، الوحدة، وعدد المنازل العشرية.
const WEATHER_TABS = [
  { key: 'temperature', label: 'الحرارة', unit: '°C', digits: 1 },
  { key: 'humidity', label: 'الرطوبة', unit: '%', digits: 0 },
  { key: 'pressure', label: 'الضغط', unit: ' hPa', digits: 1 },
];

// رسم الطقس: قراءة واحدة حسب التبويب المختار، خط مع مساحة خفيفة تحته، ومحور رأسي تلقائي.
export function WeatherChart({ history }) {
  const c = useTokens();
  const [tab, setTab] = useState('temperature');
  const t = WEATHER_TABS.find((x) => x.key === tab);
  return (
    <section className="panel chart-card" aria-labelledby="wchart">
      <header className="panel-head">
        <div>
          <h2 id="wchart">بيانات الطقس</h2>
        </div>
        <div className="seg" role="tablist" aria-label="اختر القراءة">
          {WEATHER_TABS.map((x) => (
            <button key={x.key} role="tab" id={`wtab-${x.key}`} aria-selected={tab === x.key}
              className={tab === x.key ? 'on' : ''} onClick={() => setTab(x.key)}>{x.label}</button>
          ))}
        </div>
      </header>
      <div className="chart" dir="ltr">
        <ResponsiveContainer width="100%" height={240}>
          <ComposedChart data={history} margin={{ top: 8, right: 8, bottom: 0, left: -10 }}>
            <CartesianGrid vertical={false} stroke={c.line} />
            <XAxis dataKey="t" tickFormatter={fmtTime} minTickGap={40} {...axisProps(c)} />
            <YAxis domain={['auto', 'auto']} {...axisProps(c)} width={52} />
            <Area type="monotone" dataKey={tab} stroke="none" fill={c['ink-2']} fillOpacity={0.08} isAnimationActive={false} />
            <Line type="monotone" dataKey={tab} stroke={c['ink-2']} strokeWidth={2} dot={false}
              activeDot={{ r: 4, strokeWidth: 2, stroke: c.surface }} isAnimationActive={false} />
            <Tooltip cursor={{ stroke: c['ink-3'], strokeWidth: 1 }} content={
              <TipBox rows={(p) => [[t.label, `${Number(p[tab]).toFixed(t.digits)}${t.unit}`, c['ink-2']]]} />
            } />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
}
