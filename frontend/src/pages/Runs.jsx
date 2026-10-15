/**
 * Runs.jsx — صفحة "الري" (#/runs): كل مرة اشتغلت فيها المضخة خلال آخر 24 ساعة.
 * تعرض أرقام اليوم، جدول العمليات، ثم رسم رطوبة التربة.
 * البيانات: history.runs و history.points و today (ملخص اليوم من App) و status.config.pump_flow_lpm.
 * اللترات تقديرية دائمًا: الثواني × تدفق المضخة (لا يوجد عدّاد ماء حقيقي).
 */
import { CANCEL_REASONS, REASONS, RUN_STATUS } from '../i18n/ar';
import { fmtNum, fmtTime, fmtDay } from '../lib/format';

// لون شارة النتيجة لكل حالة عملية ري.
const TONE = { ACTIVE: 'water', COMPLETED: 'good', CANCELLED: 'crit', FAILED: 'crit' };

// الصفحة: total مجموع اليوم لكل المناطق، stopped عدد العمليات التي أُوقفت أو فشلت.
export default function Runs({ status, history, colors, today }) {
  const name = Object.fromEntries(status.zones.map((z) => [z.id, z.name]));
  const flow = status.config?.pump_flow_lpm || 2;
  const runs = (history?.runs || []).slice().reverse();
  const total = Object.values(today).reduce((a, x) => ({ runs: a.runs + x.runs, seconds: a.seconds + x.seconds, liters: a.liters + x.liters }), { runs: 0, seconds: 0, liters: 0 });

  // pending_manual: تشغيل اختباري طُلب من لوحة الصيانة ولم تستلمه عقدة التشغيل بعد.
  // في عمود السبب يُعرض الجزء الأول فقط من جملة السبب (حتى أول علامة ترقيم).
  return (
    <>
      {status.pending_manual && (
        <p className="notice">بانتظار عقدة التشغيل: تشغيل اختباري لـ{name[status.pending_manual.zone_id]} لمدة <span className="num">{status.pending_manual.seconds}</span> ث</p>
      )}
      <dl className="stats">
        <div><dt>عمليات اليوم</dt><dd className="num">{total.runs}</dd></div>
        <div><dt>زمن تشغيل المضخة</dt><dd><span className="num">{Math.round(total.seconds)}</span> <small>ث</small></dd></div>
        <div><dt>ماء تقديري</dt><dd><span className="num">{fmtNum(total.liters, 1)}</span> <small>لتر</small></dd></div>
      </dl>

      <section className="panel" aria-labelledby="runs-title">
        <header className="panel-head">
          <div>
            <h2 id="runs-title">آخر 24 ساعة</h2>
            <span className="panel-sub">كميات الماء تقديرية.</span>
          </div>
        </header>
        {runs.length === 0 ? <p className="empty">لم تُشغَّل المضخة خلال آخر 24 ساعة.</p> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>الوقت</th><th>المنطقة</th><th>السبب</th><th>المدة</th><th>الماء</th><th>النتيجة</th></tr></thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.run_id || r.started_at}>
                    <td><span className="num">{fmtTime(r.started_at)}</span> <span className="cell-sub">{fmtDay(r.started_at)}</span></td>
                    <td><span className="zdot" style={{ background: colors[r.zone_id] }} aria-hidden="true" />{name[r.zone_id]}</td>
                    <td>{r.kind === 'manual' ? 'اختبار يدوي' : (REASONS[r.reason_code] || r.reason_code || '—').replace(/[.،:].*$/, '')}</td>
                    <td>
                      <span className="num">{r.actual_seconds ?? '…'}</span>
                      <span className="cell-sub"> من <span className="num">{r.planned_seconds}</span> ث</span>
                    </td>
                    <td>{r.actual_seconds != null ? <>≈ <span className="num">{fmtNum(r.est_liters ?? (r.actual_seconds / 60) * flow, 2)}</span> ل</> : '—'}</td>
                    <td>
                      <span className={`state state-${TONE[r.status]}`}>{RUN_STATUS[r.status]}</span>
                      {r.stop_reason && <span className="cell-sub"> {CANCEL_REASONS[r.stop_reason] || r.stop_reason}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

    </>
  );
}
