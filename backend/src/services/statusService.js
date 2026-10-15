/**
 * ما تعرضه لوحة التحكم: GET /api/status (الحالة الآن) و GET /api/history (الرسوم البيانية والخط الزمني).
 * قراءة فقط. قيم الحساسات اللحظية تأتي من الذاكرة (عمرها ≤ 2 ثانية تقريبًا)، والتاريخ من قاعدة البيانات.
 * يستدعيها: dashboardController.
 */
const { query } = require('../database/pool');
const m = require('../models');
const ai = require('./aiClient');
const live = require('./liveService');
const { config } = require('../config');
const scheduler = require('./schedulerState');

const db = { query };

// صحة كل جهاز: متصل إن ظهر خلال حد offlineAfterSeconds الخاص بنوعه، مع معلوماته التشخيصية.
function deviceHealth(devices) {
  const now = Date.now();
  return devices.map((d) => {
    const limit = config.offlineAfterSeconds[d.kind] * 1000;
    const age = d.last_seen_at ? now - new Date(d.last_seen_at) : null;
    return {
      id: d.id, kind: d.kind, online: age !== null && age <= limit, last_seen_at: d.last_seen_at,
      seconds_since_seen: age === null ? null : Math.round(age / 1000), rssi: d.rssi, uptime_s: d.uptime_s, firmware: d.firmware,
    };
  });
}

/**
 * إحصاءات توفير المياه من سجل الأحداث:
 *  - عدد التأجيلات التي أكدها المطر فعلًا، ومجموع اللترات الموفَّرة تقديريًا منها
 *  - عدد التأجيلات التي انتهت دون مطر (لتقييم دقة الذكاء الاصطناعي بأمانة)
 */
async function savings() {
  const { rows } = await query(`
    SELECT
      COUNT(*) FILTER (WHERE type = 'AI_DEFERRAL_CONFIRMED')::int AS deferrals_confirmed,
      COALESCE(SUM((details->>'est_liters')::numeric) FILTER (WHERE type = 'AI_DEFERRAL_CONFIRMED'), 0) AS est_liters_saved,
      COUNT(*) FILTER (WHERE type = 'DEFERRAL_ENDED_NO_RAIN')::int AS deferrals_ended_without_rain
    FROM system_events`);
  return { ...rows[0], est_liters_saved: +Number(rows[0].est_liters_saved).toFixed(2) };
}

// تحويل صف تشغيل من قاعدة البيانات إلى الشكل الذي تعرضه لوحة التحكم.
const runView = (r) => r && ({
  run_id: r.run_id, zone_id: r.zone_id, kind: r.kind, reason_code: r.reason_code, planned_seconds: r.planned_seconds,
  actual_seconds: r.actual_seconds, est_liters: r.est_liters, status: r.status, stop_reason: r.stop_reason,
  started_at: r.started_at, finished_at: r.finished_at, command_id: r.command_id,
});

/**
 * بناء رد GET /api/status: صورة كاملة عن النظام في طلب واحد.
 * كل الاستعلامات المستقلة تُنفذ بالتوازي (Promise.all) لتسريع الرد.
 */
async function buildStatus() {
  const [state, storedWeather, prediction, zones, storedSoil, decisions, run, lastRuns, devices, events, runs, card, sv, aiOk, firstRecent, pendingManual] = await Promise.all([
    m.getState(db), m.latestWeather(db), m.latestPrediction(db), m.listZones(db), m.latestSoilByZone(db),
    m.latestDecisions(db), m.activeRun(db), m.lastRunByZone(db), m.listDevices(db), m.recentEvents(db, 40),
    m.recentRuns(db, 10), ai.getModelCard(), savings(), ai.isHealthy(), m.firstWeatherSince(db, 4), m.pendingManual(db),
  ]);
  const frame = live.getFrame();
  const fresh = live.frameAgeSeconds() <= config.sensorStaleSeconds;
  // قراءة الطقس قبل 3 ساعات تقريبًا (±20 دقيقة) لحساب اتجاه الضغط والرطوبة.
  const ago3h = storedWeather && await m.weatherNear(db, new Date(Date.now() - 3 * 3600_000).toISOString(), 20);
  // الطقس الحالي: الإطار اللحظي إن كان حديثًا، وإلا آخر قراءة محفوظة.
  const weatherNow = fresh ? frame : storedWeather;
  const liveSoil = Object.fromEntries((fresh ? frame.soil : []).map((s) => [s.zone_id, s]));
  const soilBy = Object.fromEntries(storedSoil.map((s) => [s.zone_id, s]));
  const decBy = Object.fromEntries(decisions.map((d) => [d.zone_id, d]));
  const lastBy = Object.fromEntries(lastRuns.map((r) => [r.zone_id, r]));
  // كم دقيقة من سجل الطقس متوفرة خلال آخر 4 ساعات (الذكاء الاصطناعي يحتاج إلى 180 دقيقة).
  const historyMinutes = firstRecent && storedWeather ? Math.round((new Date(storedWeather.recorded_at) - new Date(firstRecent)) / 60_000) : 0;

  return {
    t: new Date().toISOString(),
    system: { mode: state.mode, since: state.since, cooldown_until: state.cooldown_until, error_reason: state.error_reason },
    // الطقس مع الفرق خلال 3 ساعات (هبوط الضغط وارتفاع الرطوبة من مؤشرات اقتراب المطر).
    weather: weatherNow && {
      temperature: weatherNow.temperature, humidity: weatherNow.humidity, pressure: weatherNow.pressure,
      rain_detected: weatherNow.rain_detected, rain_level: weatherNow.rain_level,
      recorded_at: fresh ? frame.received_at : storedWeather.recorded_at, live: fresh,
      d_pressure_3h: ago3h ? +(weatherNow.pressure - ago3h.pressure).toFixed(1) : null,
      d_humidity_3h: ago3h ? +(weatherNow.humidity - ago3h.humidity).toFixed(0) : null,
    },
    // آخر تنبؤ؛ القيم الناقصة (عند فشل التنبؤ) تُكمَّل من بطاقة النموذج إن توفرت.
    prediction: prediction && {
      status: prediction.status,
      rain_probability: prediction.rain_probability,
      threshold: prediction.threshold ?? card?.threshold ?? null,
      horizon_hours: prediction.horizon_hours ?? card?.horizon_hours ?? 3,
      model_version: prediction.model_version ?? card?.model_version ?? null,
      generated_at: prediction.created_at,
      next_at: scheduler.nextPredictionAt(),
      drivers: prediction.drivers || [],
    },
    model: card,
    // لكل منطقة: الرطوبة (لحظية إن أمكن، وإلا آخر قيمة محفوظة)، حالة الصمام، آخر ري، وآخر قرار.
    zones: zones.map((z) => {
      const d = decBy[z.id];
      const l = liveSoil[z.id];
      const s = l || soilBy[z.id];
      return {
        id: z.id, name: z.name, plant: z.plant_type, target: z.target_moisture, critical: z.critical_moisture, enabled: z.enabled,
        seconds_per_percent: z.seconds_per_percent != null ? Number(z.seconds_per_percent) : null,
        soil_moisture: s?.valid ? s.soil_moisture : null,
        soil_valid: s ? s.valid : null,
        raw_adc: s?.raw_adc ?? null,
        soil_live: !!l,
        // صمام واحد فقط مفتوح في أي لحظة: صمام منطقة التشغيل النشط.
        valve: run && run.zone_id === z.id ? 'OPEN' : 'CLOSED',
        last_irrigated_at: lastBy[z.id]?.finished_at ?? null,
        decision: d && {
          action: d.action, seconds: d.seconds, est_liters: d.est_liters, reason_code: d.reason_code,
          sequence: d.chosen ? 1 : null, chosen: d.chosen, urgency: d.urgency, decided_at: d.created_at,
          trace: d.trace || [], planned_seconds: d.planned_seconds || null,
        },
      };
    }),
    pump: run ? 'ON' : 'OFF',
    active_run: runView(run),
    pending_manual: pendingManual && { command_id: pendingManual.command_id, zone_id: pendingManual.zone_id, seconds: pendingManual.duration_seconds },
    runs: runs.map(runView),
    devices: deviceHealth(devices),
    // جاهزية النظام: هل خدمة الذكاء الاصطناعي تعمل، وكم من السجل متوفر، وهل الحساسات لحظية.
    readiness: {
      ai_service: aiOk,
      history_minutes: historyMinutes,
      required_history_minutes: 180,
      sensors_live: fresh,
      last_weather_at: storedWeather?.recorded_at ?? null,
    },
    savings: sv,
    events: events.map((e) => ({ id: e.id, type: e.type, zone_id: e.zone_id, at: e.created_at, ...e.details })),
    config: { cooldown_minutes: config.cooldownMinutes, max_pump_on_seconds: config.maxPumpOnSeconds, pump_flow_lpm: config.pumpFlowLpm },
  };
}

/**
 * بناء رد GET /api/history: نقاط زمنية للرسوم البيانية + القرارات + التشغيلات خلال النافذة.
 * النافذة تُقسَّم إلى ~120 «دلوًا» (bucket) زمنيًا على الأكثر، حتى يبقى حجم الرد ثابتًا تقريبًا
 * سواء طُلبت ساعة أو أسبوع.
 */
async function buildHistory(hours = 24) {
  // حصر عدد الساعات بين 1 و 168 (أسبوع).
  const h = Math.min(Math.max(Number(hours) || 24, 1), 168);
  const zones = await m.listZones(db);
  // النافذة = الساعات المطلوبة، لكن لا تبدأ قبل أول قراءة (النظام الجديد ليس لديه 24 ساعة بعد).
  const { rows: [first] } = await query(`SELECT LEAST(
      (SELECT MIN(recorded_at) FROM weather_readings WHERE recorded_at >= now() - make_interval(hours => $1)),
      (SELECT MIN(recorded_at) FROM soil_readings WHERE recorded_at >= now() - make_interval(hours => $1))) AS t`, [h]);
  const from = first.t ? new Date(Math.max(new Date(first.t).getTime(), Date.now() - h * 3600_000)) : new Date(Date.now() - h * 3600_000);
  const spanMin = Math.max(1, (Date.now() - from) / 60_000);
  // طول الدلو بالدقائق بحيث لا يزيد عدد النقاط على 120 تقريبًا.
  const bucketMin = Math.max(1, Math.ceil(spanMin / 120));
  // عمود لكل منطقة (z1، z2...): آخر رطوبة صالحة حتى لحظة الدلو. أرقام المناطق تمر عبر Number()
  // قبل وضعها في نص SQL، فلا يمكن حقن نص فيها.
  const soilCols = zones.map((z) => `(SELECT soil_moisture FROM soil_readings s WHERE s.zone_id = ${Number(z.id)} AND s.valid AND s.recorded_at <= b.t ORDER BY recorded_at DESC LIMIT 1) AS z${Number(z.id)}`).join(',\n');
  // generate_series يولّد لحظات الدلاء؛ ولكل لحظة تُؤخذ آخر قراءة طقس، وآخر حدث مطر، وآخر تنبؤ ناجح
  // حتى تلك اللحظة (LEFT JOIN LATERAL).
  const { rows: points } = await query(`
    WITH b AS (SELECT generate_series(date_trunc('minute', $1::timestamptz), now(), make_interval(mins => $2)) AS t)
    SELECT b.t, w.temperature, w.humidity, w.pressure,
      (SELECT event_type = 'RAIN_STARTED' FROM rain_events r WHERE r.recorded_at <= b.t ORDER BY recorded_at DESC LIMIT 1) AS rain_event_state,
      w.rain_detected, p.rain_probability, p.threshold,
      ${soilCols}
    FROM b
    LEFT JOIN LATERAL (SELECT * FROM weather_readings w WHERE w.recorded_at <= b.t ORDER BY recorded_at DESC LIMIT 1) w ON true
    LEFT JOIN LATERAL (SELECT * FROM rain_predictions p WHERE p.created_at <= b.t AND p.status = 'OK' ORDER BY created_at DESC LIMIT 1) p ON true
    ORDER BY b.t`, [from.toISOString(), bucketMin]);

  // القرارات والتشغيلات داخل النافذة (للخط الزمني).
  const { rows: decisions } = await query(
    `SELECT zone_id, action, reason_code, seconds, chosen, created_at AS t FROM irrigation_decisions WHERE created_at >= $1 ORDER BY created_at`, [from.toISOString()]);
  const { rows: runs } = await query(
    `SELECT run_id, zone_id, kind, reason_code, planned_seconds, status, stop_reason, actual_seconds, est_liters, started_at, finished_at, finished_at AS completed_at
       FROM irrigation_runs WHERE started_at >= $1 ORDER BY started_at`, [from.toISOString()]);

  return {
    hours: h,
    bucket_minutes: bucketMin,
    window: { from: from.toISOString(), to: new Date().toISOString() },
    points: points.map((r) => {
      const pt = {
        t: r.t, temperature: r.temperature, humidity: r.humidity, pressure: r.pressure,
        // حالة المطر: حدث المطر الفوري له الأولوية، وإلا قيمة rain_detected في قراءة الطقس.
        rain: (r.rain_event_state ?? r.rain_detected) ? 1 : 0,
        // الاحتمال والعتبة يُحوَّلان إلى نسبة مئوية للرسم.
        p: r.rain_probability == null ? null : +(r.rain_probability * 100).toFixed(1),
        threshold: r.threshold == null ? null : +(r.threshold * 100).toFixed(1),
      };
      for (const z of zones) pt[`z${z.id}`] = r[`z${z.id}`];
      return pt;
    }),
    decisions,
    runs: runs.map((r) => ({ ...r, execution_status: r.status === 'COMPLETED' ? 'completed' : r.status.toLowerCase() })),
  };
}

module.exports = { buildStatus, buildHistory };
