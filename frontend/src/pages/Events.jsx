/**
 * Events.jsx — صفحة "الأحداث" (#/events): سجل كل ما حدث، الأحدث أولًا، مع أزرار تصفية.
 * البيانات: status.events، وتُترجم كل حدث عبر describeEvent في i18n/ar.js.
 */
import { useState } from 'react';
import Icon from '../components/Icon';
import { describeEvent } from '../i18n/ar';
import { fmtDay, fmtTime } from '../lib/format';

// مجموعات التصفية: كل مجموعة تختبر نوع الحدث (e.type) بتعبير نمطي (regex).
const GROUPS = [
  { id: 'all', label: 'الكل', test: () => true },
  { id: 'rain', label: 'المطر والأمان', test: (t) => /RAIN|COOLDOWN|STOP|REFUSED|DEFER|RECALC/.test(t) },
  { id: 'water', label: 'الري', test: (t) => /IRRIGATION|RUN|MANUAL|COMMAND/.test(t) },
  { id: 'system', label: 'الأجهزة والنظام', test: (t) => /DEVICE|ERROR|ZONE/.test(t) },
];

// التاريخ يظهر فقط للأحداث القديمة؛ أحداث اليوم يكفيها الوقت.
const isToday = (iso) => new Date(iso).toDateString() === new Date().toDateString();

// الصفحة: تُخفى أحداث DECISION_CYCLE (دورات القرار الروتينية) لأنها كثيرة ولا تفيد القارئ.
export default function Events({ status }) {
  const [g, setG] = useState('all');
  const byId = Object.fromEntries(status.zones.map((z) => [z.id, z]));
  const group = GROUPS.find((x) => x.id === g);
  const list = (status.events || []).filter((e) => e.type !== 'DECISION_CYCLE' && group.test(e.type));

  return (
    <section className="panel" aria-labelledby="ev-title">
      <header className="panel-head">
        <h2 id="ev-title">آخر <span className="num">{(status.events || []).length}</span> حدثًا</h2>
        <div className="seg" role="tablist" aria-label="تصفية الأحداث">
          {GROUPS.map((x) => (
            <button key={x.id} type="button" role="tab" aria-selected={g === x.id} className={g === x.id ? 'on' : ''} onClick={() => setG(x.id)}>{x.label}</button>
          ))}
        </div>
      </header>
      {list.length === 0 ? <p className="empty">لا أحداث من هذا النوع بعد.</p> : (
        <ol className="event-list">
          {list.map((e) => {
            const d = describeEvent(e, byId);
            return (
              <li key={e.id || `${e.at}-${e.type}-${e.zone_id}`} className={`ev tone-${d.tone}`}>
                <span className="ev-icon"><Icon name={d.icon} size={15} /></span>
                <div className="ev-body">
                  <b>{d.title}</b>
                  {d.detail && <p>{d.detail}</p>}
                </div>
                <time><span className="num">{fmtTime(e.at)}</span>{!isToday(e.at) && <span>{fmtDay(e.at)}</span>}</time>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
