/**
 * Decision.jsx — صفحة "القرار" (#/decision أو #/decision/2).
 * تشرح أي منطقة تُسقى أولًا ولماذا، في ثلاثة أقسام: طابور الري، سلم القرار للمنطقة المختارة، والخط الزمني للقرارات.
 * البيانات: status.zones (القرارات الحالية) و history (القرارات السابقة). اللوحة تعرض فقط؛ عقدة التشغيل ESP32 #2 هي التي تقرر.
 */
import DecisionPath from '../components/DecisionPath';
import { fmtNum } from '../lib/format';
import { href } from '../lib/router';
import { queueOf, reasonText, zoneState } from '../lib/zones';

/** لماذا هذه المنطقة وليس غيرها: كل المناطق مرتبة حسب بعدها عن هدفها.
 *  المناطق في الطابور (تحتاج ري) أولًا برقم ترتيبها، ثم البقية بدون رقم (–). */
function Queue({ status, colors }) {
  const q = queueOf(status.zones);
  const rest = status.zones.filter((z) => !q.includes(z));
  const row = (z, pos) => {
    const st = zoneState(z, status);
    return (
      <li key={z.id} className={`qrow st-${st.key}`} style={{ '--zone': colors[z.id] }}>
        <span className="qpos">{pos ?? '–'}</span>
        <a className="qname" href={href('decision', z.id)}><b>{z.name}</b><span><span className="num">{fmtNum(z.soil_moisture)}%</span> من هدف <span className="num">{z.target}%</span></span></a>
        <span className={`state state-${st.tone}`}>{st.key === 'running' && <span className="state-flow" aria-hidden="true" />}{st.label}</span>
        <span className="qwhy">{reasonText(z.decision)}</span>
      </li>
    );
  };
  return (
    <section className="panel" aria-labelledby="q-title">
      <header className="panel-head">
        <div>
          <h2 id="q-title">دور الري</h2>
        </div>
      </header>
      <ol className="queue">
        {q.map((z, i) => row(z, i + 1))}
        {rest.map((z) => row(z, null))}
      </ol>
    </section>
  );
}

// الصفحة: المنطقة المختارة من الرابط (arg) أو الأولى افتراضيًا؛ اختيار منطقة أخرى يغيّر الرابط.
export default function Decision({ status, history, colors, arg }) {
  const zone = status.zones.find((z) => z.id === arg) || status.zones[0];
  return (
    <>
      <Queue status={status} colors={colors} />
      <DecisionPath zone={zone} zones={status.zones} onSelect={(id) => { window.location.hash = href('decision', id); }} />
    </>
  );
}
