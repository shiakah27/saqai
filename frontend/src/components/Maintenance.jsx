/**
 * Maintenance.jsx — صفحة "الصيانة" (#/maintenance): أدوات الفريق المحمية بمفتاح الإدارة.
 * البيانات: status (المناطق، الإعدادات config، وضع النظام)، وترسل أوامر عبر admin في api/client.js.
 * بعد كل أمر ناجح تستدعي onChange (أي refresh) لتحديث اللوحة. في نسخة المعاينة تُرفض كل الأوامر.
 */
import { useState } from 'react';
import Icon from './Icon';
import { admin } from '../api/client';

/**
 * التشغيل الأولي والمعايرة على الأجهزة الحقيقية (يتطلب مفتاح الإدارة، ويُحفظ في الذاكرة فقط، لا في المتصفح).
 *  - اختبار كل صمام بتشغيل قصير (بنفس قواعد الأمان في الري التلقائي)
 *  - تدفق المضخة: تشغيل 30 ث في وعاء مدرّج، ثم كتابة اللترات → لتر/دقيقة لقيمة PUMP_FLOW_LPM
 *  - ثوانٍ لكل 1%: مقارنة التربة قبل/بعد تشغيل اختباري → تُحفظ في إعداد المنطقة
 *  - قيمة ADC الخام لكل حساس لمعايرة الجاف/الرطب في الـfirmware
 */
export default function Maintenance({ status, onChange }) {
  // state: key المفتاح، unlocked هل فُتحت الأدوات، msg رسالة النتيجة، busy أثناء تنفيذ أمر،
  // secs ثواني الاختبار لكل منطقة، flow مدخلات حاسبة التدفق، spp قيم ثوانٍ لكل 1% لكل منطقة.
  const [key, setKey] = useState('');
  const [unlocked, setUnlocked] = useState(false);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [secs, setSecs] = useState({ 1: 10, 2: 10, 3: 10 });
  const [flow, setFlow] = useState({ seconds: 30, liters: '' });
  const [spp, setSpp] = useState({});

  // تنفيذ أي أمر إداري بشكل موحّد: تعطيل الأزرار، عرض رسالة نجاح أو خطأ (401 = مفتاح خاطئ)، ثم تحديث البيانات.
  const act = async (fn, okText) => {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      setMsg({ ok: true, text: okText });
      onChange?.();
    } catch (e) {
      setMsg({ ok: false, text: e.status === 401 ? 'مفتاح الإدارة غير صحيح.' : e.message });
    } finally {
      setBusy(false);
    }
  };

  // فتح الأدوات: التحقق من المفتاح عند الخادم أولًا.
  const unlock = (e) => {
    e.preventDefault();
    act(async () => { await admin.check(key); setUnlocked(true); }, 'تم فتح لوحة الصيانة.');
  };

  // حاسبة التدفق: لتر/دقيقة = (اللترات ÷ الثواني) × 60.
  const lpm = flow.liters && flow.seconds ? (Number(flow.liters) / Number(flow.seconds)) * 60 : null;

  return (
    <section className="panel maint" id="maintenance" aria-labelledby="maint-title">
      <header className="panel-head">
        <div>
          <h2 id="maint-title">أدوات الفريق</h2>
          <span className="panel-sub">أدخل مفتاح الإدارة لفتح أدوات الصيانة.</span>
        </div>
      </header>

      {/* قبل الفتح: نموذج إدخال المفتاح. بعد الفتح: اختبار الصمامات، التدفق، المعايرة، وأزرار التنبؤ وإلغاء العطل */}
      {!unlocked ? (
        <form className="unlock" onSubmit={unlock}>
          <label htmlFor="admin-key" className="small">مفتاح الإدارة (ADMIN_API_KEY من backend/.env)</label>
          <div className="row">
            <input id="admin-key" type="password" value={key} onChange={(e) => setKey(e.target.value)} autoComplete="off" dir="ltr" />
            <button type="submit" className="btn" disabled={!key || busy}>فتح</button>
          </div>
        </form>
      ) : (
        <div className="maint-body">
          <div className="maint-block">
            <h3 className="sub-title">اختبار الصمامات والمضخة</h3>
            <p className="small muted">يُرسل لعقدة التشغيل فتنفذه خلال ثانية، بنفس حدود الأمان: يُرفض أثناء المطر، ويتوقف فورًا إذا بدأ المطر.</p>
            <div className="table-wrap">
              <table>
                <thead><tr><th>المنطقة</th><th>الرطوبة</th><th>القراءة الخام</th><th>ثوانٍ</th><th /></tr></thead>
                <tbody>
                  {status.zones.map((z) => (
                    <tr key={z.id}>
                      <td>{z.name}</td>
                      <td className="num">{z.soil_moisture == null ? '—' : `${Number(z.soil_moisture).toFixed(1)}%`}</td>
                      <td className="num">{z.raw_adc ?? '—'}</td>
                      <td><input id={`run-s-${z.id}`} type="number" min="1" max={status.config?.max_pump_on_seconds || 60} value={secs[z.id]}
                        onChange={(e) => setSecs({ ...secs, [z.id]: Number(e.target.value) })} className="num-input" dir="ltr" /></td>
                      <td><button type="button" className="btn btn-water" disabled={busy || status.system.mode !== 'NORMAL'}
                        onClick={() => act(() => admin.run(key, z.id, secs[z.id]), `أُرسل أمر تشغيل ${z.name} لمدة ${secs[z.id]} ث.`)}>تشغيل</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* زر التشغيل معطّل إلا في الوضع NORMAL (لا اختبار أثناء الري أو المطر أو العطل) */}
          <div className="maint-grid">
            <div className="maint-block">
              <h3 className="sub-title">معدل تدفق المضخة</h3>
              <p className="small muted">شغّل منطقة 30 ثانية والمخرج في وعاء مدرّج، ثم أدخل الكمية.</p>
              <div className="row">
                <label className="small" htmlFor="flow-s">ثوانٍ</label>
                <input id="flow-s" type="number" className="num-input" value={flow.seconds} onChange={(e) => setFlow({ ...flow, seconds: e.target.value })} dir="ltr" />
                <label className="small" htmlFor="flow-l">لتر</label>
                <input id="flow-l" type="number" step="0.05" className="num-input" value={flow.liters} onChange={(e) => setFlow({ ...flow, liters: e.target.value })} dir="ltr" />
              </div>
              {lpm != null && (
                <p className="result">التدفق ≈ <b className="num">{lpm.toFixed(2)}</b> لتر/دقيقة. ضعه في <code dir="ltr">PUMP_FLOW_LPM={lpm.toFixed(2)}</code> ثم أعد تشغيل الـBackend. الحالي: <span className="num">{status.config?.pump_flow_lpm}</span></p>
              )}
            </div>

            <div className="maint-block">
              <h3 className="sub-title">ثوانٍ لكل <span className="num">1%</span> رطوبة</h3>
              <p className="small muted">بعد تشغيل اختباري: الثواني ÷ مقدار ارتفاع الرطوبة بعد دقيقتين.</p>
              {status.zones.map((z) => (
                <div className="row" key={z.id}>
                  <span className="small zone-lbl">{z.name}</span>
                  <input id={`spp-${z.id}`} type="number" step="0.1" min="0.1" className="num-input" placeholder="2.0" value={spp[z.id] ?? ''}
                    onChange={(e) => setSpp({ ...spp, [z.id]: e.target.value })} dir="ltr" />
                  <button type="button" className="btn" disabled={busy || !spp[z.id]}
                    onClick={() => act(() => admin.patchZone(key, z.id, { seconds_per_percent: Number(spp[z.id]) }), `حُفظت معايرة ${z.name}.`)}>حفظ</button>
                </div>
              ))}
            </div>
          </div>

          <div className="row actions">
            <button type="button" className="btn" disabled={busy} onClick={() => act(() => admin.predict(key), 'صدر تنبؤ جديد من قراءات المحطة.')}>
              <Icon name="restart" size={15} /> حدّث تنبؤ المطر الآن
            </button>
            {status.system.mode === 'ERROR' && (
              <button type="button" className="btn btn-crit" disabled={busy} onClick={() => act(() => admin.resetError(key), 'أُلغي وضع العطل.')}>
                إلغاء وضع العطل
              </button>
            )}
          </div>
        </div>
      )}
      {msg && <p className={`toast ${msg.ok ? 'ok' : 'bad'}`} role="status">{msg.text}</p>}
    </section>
  );
}
