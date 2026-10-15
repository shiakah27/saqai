/**
 * preview.js — لنسخة المعاينة فقط (npm run build:preview). لا تستخدمه اللوحة الحقيقية أبدًا.
 * لقطة مسجّلة من الخادم الحقيقي، تُزاح أوقاتها إلى "الآن"، وتعيد تشغيل دورة ري واحدة
 * حتى يمكن رؤية التصميم وهو يتحرك بدون اللابتوب أو اللوحات الإلكترونية أو الخادم:
 *   0–25 ث   المنطقة 1 تُروى · المنطقة 3 تنتظر دورها
 *   25–45 ث  المنطقة 3 تُروى · المنطقة 1 تتشرب الماء
 *   45–60 ث  المضخة متوقفة، والمنطقتان تتشربان
 * تُستدعى من api/client.js بدل طلبات الخادم، وترفض أوامر الإدارة.
 */
import baseStatus from './status.json';
import baseHistory from './history.json';

// أسماء الحقول التي تحمل وقتًا: t أو at أو ما ينتهي بـ _at أو from أو to.
const TIME_KEYS = /(^t$|^at$|_at$|^from$|^to$)/;
const CYCLE = 60;   // طول الدورة بالثواني

// إزاحة كل الأوقات في كائن (بشكل متكرر داخل المصفوفات والكائنات) بمقدار ms ملّي ثانية،
// حتى تبدو البيانات المسجّلة وكأنها حدثت للتو.
function shift(obj, ms) {
  if (Array.isArray(obj)) return obj.map((v) => shift(v, ms));
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = typeof v === 'string' && TIME_KEYS.test(k) && !Number.isNaN(Date.parse(v)) ? new Date(Date.parse(v) + ms).toISOString() : shift(v, ms);
    }
    return out;
  }
  return obj;
}

// تُحسب الإزاحة مرة واحدة عند التحميل: الفرق بين الآن ووقت تسجيل اللقطة.
const loadedAt = Date.now();
const offset = loadedAt - Date.parse(baseStatus.t);
const status0 = shift(baseStatus, offset);
const history0 = shift(baseHistory, offset);

// نسخة من قرار المنطقة مع تعديلات patch ووقت قرار جديد.
const decision = (zone, patch) => ({ ...zone.decision, decided_at: new Date().toISOString(), ...patch });

// بناء حالة كاملة للحظة now حسب موقعها داخل دورة الـ60 ثانية (انظر الجدول أعلاه).
// wiggle تضيف اهتزازًا صغيرًا للرطوبة حتى تبدو القراءات حية. الرطوبة ترتفع تدريجيًا أثناء الري.
function frame(now) {
  const s = structuredClone(status0);
  const elapsed = (now - loadedAt) / 1000;
  const cycleStart = now - (elapsed % CYCLE) * 1000;
  const t = elapsed % CYCLE;
  const [z1, z2, z3] = s.zones;
  const wiggle = (k) => Math.sin(now / 9000 + k) * 0.15;
  s.t = new Date(now).toISOString();
  z2.soil_moisture = +(41 + wiggle(2)).toFixed(1);
  s.events = s.events.slice();

  let run = null;
  if (t < 25) {
    run = { run_id: 'preview-1', zone_id: 1, kind: 'auto', reason_code: 'BELOW_TARGET', planned_seconds: 25, started_at: new Date(cycleStart).toISOString(), status: 'ACTIVE' };
    z1.soil_moisture = +(28.2 + t * 0.32 + wiggle(1)).toFixed(1);
    z3.soil_moisture = +(25 + wiggle(3)).toFixed(1);
    z1.decision = decision(z1, { action: 'IRRIGATE', reason_code: 'BELOW_TARGET', chosen: true, seconds: 25, est_liters: 0.83 });
    z3.decision = decision(z3, { action: 'IRRIGATE', reason_code: 'BELOW_TARGET', chosen: false, seconds: 20, est_liters: 0.67 });
  } else if (t < 45) {
    run = { run_id: 'preview-3', zone_id: 3, kind: 'auto', reason_code: 'BELOW_TARGET', planned_seconds: 20, started_at: new Date(cycleStart + 25000).toISOString(), status: 'ACTIVE' };
    z1.soil_moisture = +(36.2 + wiggle(1)).toFixed(1);
    z3.soil_moisture = +(25 + (t - 25) * 0.3 + wiggle(3)).toFixed(1);
    z1.decision = decision(z1, { action: 'HOLD', reason_code: 'SOAKING', chosen: false, seconds: 0 });
    z3.decision = decision(z3, { action: 'IRRIGATE', reason_code: 'BELOW_TARGET', chosen: true, seconds: 20, est_liters: 0.67 });
  } else {
    z1.soil_moisture = +(36.2 + wiggle(1)).toFixed(1);
    z3.soil_moisture = +(31 + wiggle(3)).toFixed(1);
    z1.decision = decision(z1, { action: 'HOLD', reason_code: 'SOAKING', chosen: false, seconds: 0 });
    z3.decision = decision(z3, { action: 'HOLD', reason_code: 'SOAKING', chosen: false, seconds: 0 });
  }
  // مزامنة باقي الحالة مع الري الجاري: المضخة، وضع النظام، الصمامات، والأجهزة متصلة دائمًا.
  s.active_run = run;
  s.pump = run ? 'ON' : 'OFF';
  s.system = { ...s.system, mode: run ? 'IRRIGATING' : 'NORMAL' };
  s.zones.forEach((z) => { z.valve = run && run.zone_id === z.id ? 'OPEN' : 'CLOSED'; z.soil_live = true; });
  s.devices = s.devices.map((d) => ({ ...d, online: true, seconds_since_seen: 1, last_seen_at: s.t }));
  s.readiness = { ...s.readiness, sensors_live: true };
  return s;
}

// بديل fetchSnapshot في المعاينة: حالة اللحظة الحالية + السجل المزاح.
export async function previewSnapshot() {
  return { status: frame(Date.now()), history: history0 };
}

// بديل أوامر الإدارة في المعاينة: رفض دائم برسالة واضحة (status = 0 يعني ليس خطأ من الخادم).
export const previewRefusal = () => {
  const e = new Error('هذه معاينة ببيانات نموذجية: أدوات الصيانة تعمل على النظام الحقيقي فقط.');
  e.status = 0;
  return Promise.reject(e);
};
