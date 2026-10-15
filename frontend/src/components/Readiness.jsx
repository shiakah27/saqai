/**
 * Readiness.jsx — قسم "جاهزية النظام" أعلى الصفحة الرئيسية.
 * البيانات: status.devices (اتصال العقدتين) و status.readiness (الحساسات الحية، خدمة الذكاء الاصطناعي، دقائق التاريخ).
 */
import Icon from './Icon';
import { fmtTime } from '../lib/format';

/**
 * يظهر حتى يكتمل كل ما يحتاجه النظام. كل فحص يقول ما الناقص وكيف يُصلح،
 * فتشغيل الأجهزة الحقيقية لا يحتاج نافذة أوامر (terminal).
 * أربعة فحوص: عقدة الحساسات، عقدة التشغيل، خدمة الذكاء الاصطناعي، وتاريخ كافٍ من القراءات (افتراضيًا 180 دقيقة، مع سماح 15 دقيقة).
 * إذا نجحت كل الفحوص لا يُعرض شيء (null).
 */
export default function Readiness({ status }) {
  const dev = Object.fromEntries((status.devices || []).map((d) => [d.kind, d]));
  const r = status.readiness || {};
  const minutes = r.history_minutes || 0;
  const need = r.required_history_minutes || 180;

  const checks = [
    {
      ok: dev.sensor?.online && r.sensors_live,
      title: 'عقدة الحساسات',
      detail: dev.sensor?.online ? (r.sensors_live ? 'ترسل الحساسات لحظيًا' : 'متصلة لكن لا ترسل قراءات: افحص حساس الطقس')
        : dev.sensor?.last_seen_at ? `انقطعت منذ ${Math.round(dev.sensor.seconds_since_seen / 60)} دقيقة` : 'لم تتصل بعد: افحص Wi-Fi وBACKEND_URL في secrets.h',
    },
    {
      ok: dev.actuator?.online,
      title: 'عقدة التشغيل',
      detail: dev.actuator?.online ? 'متصلة وتتخذ القرار' : dev.actuator?.last_seen_at ? 'انقطعت: المضخة متوقفة تلقائيًا' : 'لم تتصل بعد',
    },
    {
      ok: r.ai_service,
      title: 'خدمة الذكاء الاصطناعي',
      detail: r.ai_service ? 'تعمل' : 'متوقفة: القرار على التربة وحدها. شغّل start.bat',
    },
    {
      ok: minutes >= need - 15,
      title: 'تاريخ قراءات المحطة',
      detail: minutes >= need - 15 ? 'كافٍ للتنبؤ' : `${minutes} من ${need} دقيقة · التنبؤ يبدأ بعد 3 ساعات من القراءات الحقيقية`,
      progress: Math.min(1, minutes / need),
    },
  ];
  if (checks.every((c) => c.ok)) return null;

  return (
    <section className="panel readiness" aria-labelledby="ready-title">
      <header className="panel-head">
        <div>
          <h2 id="ready-title">جاهزية النظام</h2>
        </div>
      </header>
      <ul className="checks">
        {checks.map((c) => (
          <li key={c.title} className={c.ok ? 'ok' : 'wait'}>
            <span className="check-dot" aria-hidden="true">{c.ok ? <Icon name="check" size={13} /> : <Icon name="clock" size={13} />}</span>
            <div>
              <b>{c.title}</b>
              <span className="small muted">{c.detail}</span>
              {c.progress != null && !c.ok && <span className="check-bar" aria-hidden="true"><span style={{ transform: `scaleX(${c.progress})` }} /></span>}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
