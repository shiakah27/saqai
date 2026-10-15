/**
 * القراءات اللحظية من ESP32 #1 (كل ~2 ثانية): BME280 + لوحة المطر MH-RD + 3 حساسات تربة في إطار واحد.
 *  - يصبح الإطار فورًا «القيمة الحالية» لـ ESP32 #2 ولوحة التحكم (عبر liveService)
 *  - أي تغيّر في المطر يمر عبر طبقة الأمان قبل إرسال الرد
 *  - السجل يُحفظ بمعدل أبطأ: الطقس كل 60 ثانية، والتربة كل 10 ثوانٍ
 * لماذا الحفظ أبطأ من البث؟ حفظ إطار كل ثانيتين يعني ~43,000 صف طقس يوميًا بلا فائدة: الطقس يتغير
 * ببطء، وصف واحد في الدقيقة يكفي لميزات الذكاء الاصطناعي (ساعة/3 ساعات) وللرسوم البيانية؛
 * بينما القرار والأمان يستخدمان القيمة اللحظية من الذاكرة.
 * يستدعيها: deviceController.postReadings.
 */
const { query } = require('../database/pool');
const m = require('../models');
const live = require('./liveService');
const { applyRainSignal } = require('./safetyService');
const { config } = require('../config');

const db = { query };
// وقت آخر حفظ (بالمللي ثانية) للطقس والتربة.
let lastWeatherStored = 0;
let lastSoilStored = 0;
// ذاكرة مؤقتة لأرقام المناطق المعروفة (تُفرَّغ عند تعديل منطقة عبر resetZoneCache).
let zoneIds = null;

// أرقام المناطق الموجودة في جدول zones (تُقرأ من قاعدة البيانات مرة واحدة فقط).
async function knownZones() {
  if (!zoneIds) zoneIds = new Set((await m.listZones(db)).map((z) => z.id));
  return zoneIds;
}

// قراءة رطوبة صالحة = رقم حقيقي بين 0 و 100 %. غير ذلك يعني حساسًا مفصولًا أو غير معاير.
const validSoil = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100;

/**
 * إشارة المطر من أي قراءة. لا يُستدعى applyRainSignal إلا عند وجود تغيير فعلي، لتجنب معاملة
 * مع قفل كل ثانيتين. إنهاء القفل يتم فقط عبر تقرير «جاف» من الجهاز بعد إزالة الارتداد (debounce) هناك.
 */
async function rainSignal(rainDetected, deviceId, source, rainLevel) {
  const state = await m.getState(db);
  if (rainDetected && state.mode !== 'RAIN_LOCKOUT') return applyRainSignal({ rainDetected: true, deviceId, source, rainLevel });
  if (!rainDetected && state.mode === 'RAIN_LOCKOUT') return applyRainSignal({ rainDetected: false, deviceId, source, rainLevel });
  return { changed: false, mode: state.mode };
}

/**
 * معالجة إطار قراءات واحد: التحقق من المناطق، تحديث «الآن» في الذاكرة، تطبيق إشارة المطر،
 * ثم الحفظ في قاعدة البيانات إن حان موعده.
 */
async function ingest(body, { ip, deviceTime = null }) {
  const zones = await knownZones();
  // رقم منطقة غير موجود في قاعدة البيانات: خطأ 422 (خطأ في إعداد الـ firmware).
  const unknown = body.soil.filter((s) => !zones.has(s.zone_id)).map((s) => s.zone_id);
  if (unknown.length) { const e = new Error(`Unknown zone(s): ${unknown.join(', ')}`); e.status = 422; throw e; }

  await m.touchDevice(db, body.device_id, { ip, rssi: body.rssi, uptime_s: body.uptime_s, firmware: body.firmware });
  const soil = body.soil.map((s) => ({ ...s, valid: validSoil(s.soil_moisture) }));

  // قراءات الاختبار ذات التاريخ السابق (NODE_ENV=test فقط) تذهب مباشرة إلى السجل،
  // ولا تمس «الآن» ولا طبقة الأمان أبدًا.
  if (deviceTime) {
    await m.insertWeather(db, { ...body, source: 'test', recorded_at: deviceTime });
    for (const s of soil) await m.insertSoil(db, body.device_id, s, 'test', deviceTime);
    return { stored: true, system_mode: (await m.getState(db)).mode };
  }

  // تحديث الإطار اللحظي في الذاكرة (وبثه إلى لوحات التحكم عبر SSE).
  live.setFrame({
    temperature: body.temperature, humidity: body.humidity, pressure: body.pressure,
    rain_detected: body.rain_detected, rain_level: body.rain_level ?? null,
    soil: soil.map((s) => ({ zone_id: s.zone_id, soil_moisture: s.valid ? s.soil_moisture : null, raw_adc: s.raw_adc ?? null, valid: s.valid })),
  });

  const safety = await rainSignal(body.rain_detected, body.device_id, 'readings', body.rain_level);

  // الحفظ في السجل فقط إن مرّ الفاصل المحدد منذ آخر حفظ.
  const now = Date.now();
  if (now - lastWeatherStored >= config.weatherStoreSeconds * 1000) {
    lastWeatherStored = now;
    await m.insertWeather(db, { ...body, source: 'device' });
  }
  if (now - lastSoilStored >= config.soilStoreSeconds * 1000) {
    lastSoilStored = now;
    for (const s of soil) await m.insertSoil(db, body.device_id, s, 'device');
  }
  return { system_mode: safety.mode };
}

module.exports = { ingest, rainSignal, resetZoneCache: () => { zoneIds = null; } };
