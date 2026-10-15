/**
 * WeatherTiles.jsx — بطاقة "الطقس الآن" في صفحة الطقس.
 * أربع خانات في بطاقة واحدة: الحرارة، رطوبة الجو، الضغط الجوي، والمطر الآن (من حساس المطر).
 * تحت الرطوبة والضغط: كم تغيّرا خلال آخر 3 ساعات (نزول الضغط مع ارتفاع الرطوبة من علامات المطر).
 * الاتجاه خلال اليوم موجود في رسم "بيانات الطقس" أسفل الصفحة، فلا داعي لرسوم صغيرة هنا.
 */
import Icon from './Icon';
import { fmtNum, signed } from '../lib/format';

export default function WeatherTiles({ weather }) {
  const wet = weather.rain_detected;
  return (
    <section className="hx-card wx-now" aria-labelledby="wx-now">
      <header><span className="hx-icon"><Icon name="thermo" size={18} /></span><h2 id="wx-now">الطقس الآن</h2></header>
      <dl className="wx-grid">
        <div>
          <dt>الحرارة</dt>
          <dd className="qty">{fmtNum(weather.temperature, 1)}<small>°C</small></dd>
        </div>
        <div>
          <dt>رطوبة الجو</dt>
          <dd className="qty">{fmtNum(weather.humidity, 0)}<small>%</small></dd>
          <span className="hx-sub">آخر 3 ساعات <b className="num">{signed(weather.d_humidity_3h, 0)}</b></span>
        </div>
        <div>
          <dt>الضغط الجوي</dt>
          <dd className="qty">{fmtNum(weather.pressure, 1)}<small>hPa</small></dd>
          <span className="hx-sub">آخر 3 ساعات <b className="num">{signed(weather.d_pressure_3h)}</b></span>
        </div>
        <div className={wet ? 'is-wet' : ''}>
          <dt>المطر الآن</dt>
          <dd>{wet ? 'مطر' : 'جاف'}</dd>
          <span className="hx-sub">{wet ? 'الري متوقف' : 'حساس المطر جاف'}</span>
        </div>
      </dl>
    </section>
  );
}
