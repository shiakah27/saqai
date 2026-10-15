/**
 * Weather.jsx — صفحة "الطقس" (#/weather).
 * بطاقات قراءات محطة الطقس (BME280 وحساس المطر)، ثم بطاقة تنبؤ الذكاء الاصطناعي بالمطر بجانب رسم الطقس.
 * البيانات: status.weather و status.prediction و status.model و history.points.
 */
import Forecast from '../components/Forecast';
import WeatherTiles from '../components/WeatherTiles';
import { WeatherChart } from '../components/Charts';

// إذا لم تصل أي قراءة بعد تظهر رسالة بدل البطاقات.
export default function Weather({ status, history }) {
  return (
    <>
      {status.weather ? <WeatherTiles weather={status.weather} />
        : <p className="panel empty">لم تصل قراءات من عقدة الحساسات بعد.</p>}
      <div className="split split-weather">
        <Forecast prediction={status.prediction} model={status.model} />
        <WeatherChart history={history.points} />
      </div>
    </>
  );
}
