/**
 * خدمة التنبؤ بالمطر. كل 30 دقيقة (عبر الـ scheduler): قراءات المحطة الأخيرة ← خدمة الذكاء الاصطناعي
 * ← حفظ النتيجة، سواء نجحت أم لا (حتى تكون الفجوات ظاهرة ومفسَّرة).
 * ملف CSV التاريخي (بيانات التدريب) لا يُقرأ هنا أبدًا؛ التنبؤ يعتمد على قراءات المحطة نفسها فقط.
 * يستدعيها: scheduler.js و dashboardController.predictNow.
 */
const { query } = require('../database/pool');
const m = require('../models');
const ai = require('./aiClient');
const live = require('./liveService');

// تشغيل تنبؤ واحد وحفظه، وإعادة الصف المحفوظ.
async function runPrediction() {
  const db = { query };
  const latest = await m.latestWeather(db);
  // لا توجد قراءة طقس خلال آخر 10 دقائق (عقدة الحساسات متوقفة): لا معنى للتنبؤ، تُسجل الحالة NO_WEATHER.
  if (!latest || Date.now() - new Date(latest.recorded_at) > 10 * 60_000) {
    return m.insertPrediction(db, { status: 'NO_WEATHER' });
  }
  // آخر 4 ساعات من القراءات (النموذج يحتاج إلى ~3 ساعات لميزات تغيّر الضغط والرطوبة، مع هامش).
  const rows = await m.weatherSince(db, 4);
  const readings = rows.map((r) => ({ t: r.recorded_at, temperature: r.temperature, humidity: r.humidity, pressure: r.pressure }));
  const out = await ai.predict(readings);
  const saved = await m.insertPrediction(db, {
    status: out.status,
    rain_probability: out.status === 'OK' ? out.rain_probability : null,
    threshold: out.threshold,
    horizon_hours: out.horizon_hours,
    model_version: out.model_version,
    features: out.features,
    drivers: out.drivers,
  });
  live.broadcast('changed', { reason: 'prediction' });
  return saved;
}

module.exports = { runPrediction };
