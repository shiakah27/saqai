/**
 * Forecast.jsx — بطاقة تنبؤ المطر بالذكاء الاصطناعي في صفحة الطقس.
 * تعرض: مقياس نصف دائري لاحتمال المطر خلال 3 ساعات مقابل حد التأجيل، أهم 3 عوامل حرّكت التنبؤ،
 * وبطاقة النموذج (الإصدار، الخوارزمية، نتائج الاختبار).
 * البيانات: status.prediction (rain_probability، threshold، drivers، status) و status.model.
 */
import Icon from './Icon';
import { FEATURES } from '../i18n/ar';
import { fmtTime } from '../lib/format';

// مقياس نصف دائري من 0 إلى 100%. at(v) نقطة على القوس للقيمة v (0 يسار، 1 يمين).
// القوس الملون يتغير لونه عند تجاوز الحد (is-over)، وعلامة صغيرة تمثل حد التأجيل threshold.
function Gauge({ p, threshold }) {
  const r = 78;
  const cx = 100;
  const cy = 96;
  const at = (v, rad = r) => { const a = Math.PI * (1 - v); return [cx + rad * Math.cos(a), cy - rad * Math.sin(a)]; };
  const arc = (v) => { const [x, y] = at(Math.max(0.001, Math.min(v, 0.999))); return `M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)}`; };
  const [ix, iy] = at(threshold, r - 16);
  const [ox, oy] = at(threshold, r + 9);
  return (
    <svg viewBox="0 0 200 112" className="gauge" dir="ltr" role="img"
      aria-label={`احتمال المطر ${p == null ? 'غير متاح' : `${Math.round(p * 100)}%`}، حد التأجيل ${Math.round(threshold * 100)}%`}>
      <path d={`M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`} className="gauge-track" />
      {p != null && <path d={arc(p)} className={`gauge-value ${p >= threshold ? 'is-over' : ''}`} />}
      <line x1={ix} y1={iy} x2={ox} y2={oy} className="gauge-tick" />
      <text x="22" y="110" className="gauge-scale">0</text>
      <text x="178" y="110" textAnchor="end" className="gauge-scale">100</text>
    </svg>
  );
}

// المكوّن: over = الاحتمال فوق الحد (أي سيُؤجَّل الري). عرض كل عامل نسبة إلى أكبر عامل (maxAbs).
// إن لم يوجد تنبؤ يُعرض السبب (status) بدل الرقم.
export default function Forecast({ prediction, model }) {
  const p = prediction?.rain_probability ?? null;
  const thr = prediction?.threshold ?? model?.threshold ?? 0.1;
  const over = p != null && p >= thr;
  // العوامل التي لم تحرّك التنبؤ فعلًا (أثرها صفر تقريبًا) لا تُعرض، فلا معنى لشريط فارغ
  const drivers = (prediction?.drivers || []).filter((d) => Math.abs(d.contribution ?? 0) > 0.0005).slice(0, 3);
  const maxAbs = Math.max(0.02, ...drivers.map((d) => Math.abs(d.contribution)));
  const status = prediction?.status;
  const t = model?.test;

  return (
    <section className="panel forecast" id="forecast" aria-labelledby="forecast-title">
      <header className="panel-head">
        <div>
          <h2 id="forecast-title">هل ستمطر خلال <span className="num">{prediction?.horizon_hours ?? 3}</span> ساعات؟</h2>
        </div>
      </header>

      <div className="gauge-wrap">
        <Gauge p={p} threshold={thr} />
        <div className="gauge-readout">
          <span className="gauge-number num">{p == null ? '—' : Math.round(p * 100)}<small>%</small></span>
          <span className={`chip ${p == null ? 'chip-hold' : over ? 'chip-warn' : 'chip-good'}`}>
            <Icon name={over ? 'rain' : 'sun'} size={14} />
            {p == null ? ({ INSUFFICIENT_HISTORY: 'يجمع 3 ساعات من القراءات', AI_UNAVAILABLE: 'خدمة الذكاء متوقفة', NO_WEATHER: 'لا قراءات طقس حديثة' }[status] || 'لا يوجد تنبؤ')
              : over ? 'فوق حد التأجيل' : 'تحت حد التأجيل'}
          </span>
          <span className="small muted">الحد <span className="num">{Math.round(thr * 100)}%</span> · صدر <span className="num">{fmtTime(prediction?.generated_at)}</span></span>
        </div>
      </div>

      {/* العوامل: شريط يبدأ من المنتصف؛ لليمين إذا رفع احتمال المطر، ولليسار إذا خفضه */}
      {drivers.length > 0 && (
        <div className="drivers">
          <h3 className="sub-title">ما الذي حرّك التنبؤ؟</h3>
          <ul>
            {drivers.map((d) => {
              const w = (Math.abs(d.contribution) / maxAbs) * 50;
              const up = d.contribution > 0;
              return (
                <li key={d.feature}>
                  <span className="driver-name">{FEATURES[d.feature] || d.feature}</span>
                  <span className="driver-bar" dir="ltr" aria-hidden="true">
                    <span className="driver-mid" />
                    <span className={`driver-fill ${up ? 'up' : 'down'}`} style={up ? { left: '50%', width: `${w}%` } : { right: '50%', width: `${w}%` }} />
                  </span>
                  <span className={`driver-dir ${up ? 'up' : 'down'}`}>{up ? 'يرفع' : 'يخفض'}</span>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {model && (
        <footer className="model-card">
          <div className="model-head" title={`${model.model_version} · ${model.algorithm}`}><Icon name="chip" size={15} /><span>نموذج التنبؤ بالمطر</span><span className="muted small">نتائج الاختبار</span></div>
          {t && (
            <dl className="model-metrics">
              {/* كلام بسيط للزائر؛ المصطلح التقني (PR-AUC / ROC-AUC) يظهر عند تمرير الماوس */}
              <div title={`PR-AUC ${t.pr_auc} مقابل ${t.base_rate} للتخمين العشوائي`}>
                <dt>أفضل من التخمين</dt><dd><span className="num">{Math.round(t.pr_auc / t.base_rate)}</span> أضعاف</dd><span>في التقاط المطر النادر</span></div>
              <div title={`ROC-AUC ${t.roc_auc}`}>
                <dt>دقة التمييز</dt><dd className="num">{Math.round(t.roc_auc * 100)}%</dd><span>بين ساعة ممطرة وجافة</span></div>
              <div title={`${model.onset_recall_test?.warned} من ${model.onset_recall_test?.onsets} بداية مطر في فترة الاختبار`}>
                <dt>تنبّأ بالمطر مسبقًا</dt><dd className="num">{Math.round((model.onset_recall_test?.rate ?? 0) * 100)}%</dd><span>قبل حدوثه بـ3 ساعات</span></div>
            </dl>
          )}
          <p className="small muted">نتائج على سنتين لم يرهما النموذج أثناء التدريب (يوليو 2024 → 2026). وللأمان، حساس المطر يوقف الري فورًا عند أي مطر.</p>
        </footer>
      )}
    </section>
  );
}
