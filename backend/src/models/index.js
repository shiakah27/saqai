/**
 * طبقة الوصول إلى البيانات (data access).
 * كل دالة تأخذ `db` أولًا: إما الـ pool (لاستعلام منفرد) أو اتصال معاملة (transaction client)
 * لعدة استعلامات يجب أن تنجح أو تفشل معًا. أوامر SQL موجودة في هذا الملف فقط.
 * تستخدمها: services و controllers.
 */

// ---------- الأجهزة (devices) ----------
/**
 * تحديث «آخر ظهور» للجهاز ومعلوماته التشخيصية (IP، RSSI، مدة التشغيل، الـ firmware).
 * COALESCE يُبقي القيمة القديمة إن لم يرسل الجهاز قيمة جديدة. منه يُعرف هل الجهاز متصل.
 */
async function touchDevice(db, id, info = {}) {
  await db.query(
    `UPDATE devices SET last_seen_at = now(),
       last_ip = COALESCE($2, last_ip), rssi = COALESCE($3, rssi),
       uptime_s = COALESCE($4, uptime_s), firmware = COALESCE($5, firmware)
     WHERE id = $1`,
    [id, info.ip ?? null, info.rssi ?? null, info.uptime_s ?? null, info.firmware ?? null],
  );
}
// كل الأجهزة المسجلة (عقدة الحساسات أولًا ثم المشغّلات).
const listDevices = (db) => db.query('SELECT * FROM devices ORDER BY kind DESC, id').then((r) => r.rows);
// هل الجهاز مسجّل بهذا النوع؟ يمنع جهازًا مجهولًا، أو عقدة حساسات تنتحل صفة عقدة المشغّلات.
const deviceExists = (db, id, kind) => db.query('SELECT 1 FROM devices WHERE id = $1 AND kind = $2', [id, kind]).then((r) => r.rowCount > 0);

// ---------- حالة النظام (system_state) ----------
/**
 * قراءة الصف الوحيد لحالة النظام.
 * forUpdate=true يقفل الصف (SELECT ... FOR UPDATE) داخل المعاملة، فلا يمكن لانتقالين في حالة الأمان
 * (مثل بدء مطر وبدء ري في اللحظة نفسها) أن يتسابقا.
 */
async function getState(db, { forUpdate = false } = {}) {
  const { rows } = await db.query(`SELECT * FROM system_state WHERE id = 1 ${forUpdate ? 'FOR UPDATE' : ''}`);
  return rows[0];
}
// كتابة حالة النظام الجديدة: الوضع، ووقت بدئه، ونهاية فترة الانتظار، وسبب العطل إن وُجد.
async function setState(db, { mode, since, cooldownUntil = null, errorReason = null }) {
  await db.query(
    'UPDATE system_state SET mode = $1, since = $2, cooldown_until = $3, error_reason = $4, updated_at = now() WHERE id = 1',
    [mode, since, cooldownUntil, errorReason],
  );
}

// ---------- الأحداث (system_events) ----------
// تسجيل حدث في سجل النظام (يظهر في الخط الزمني للوحة التحكم)، مع تفاصيل JSON ورقم المنطقة إن وُجد.
async function addEvent(db, type, details = {}, zoneId = null) {
  await db.query('INSERT INTO system_events (type, zone_id, details) VALUES ($1, $2, $3)', [type, zoneId, details]);
}
// آخر الأحداث، الأحدث أولًا.
const recentEvents = (db, limit = 40) =>
  db.query('SELECT id, type, zone_id, details, created_at FROM system_events ORDER BY created_at DESC, id DESC LIMIT $1', [limit]).then((r) => r.rows);

// ---------- المناطق (zones) ----------
const listZones = (db) => db.query('SELECT * FROM zones ORDER BY id').then((r) => r.rows);

// ---------- الطقس (weather) ----------
// حفظ قراءة طقس. إن لم يُعطَ recorded_at يُستخدم وقت الخادم now() (القيمة المعطاة فقط لاختبار backfill).
async function insertWeather(db, r) {
  const { rows } = await db.query(
    `INSERT INTO weather_readings (device_id, temperature, humidity, pressure, rain_detected, rain_level, source, recorded_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7, COALESCE($8, now())) RETURNING *`,
    [r.device_id, r.temperature, r.humidity, r.pressure, r.rain_detected, r.rain_level ?? null, r.source || 'device', r.recorded_at ?? null],
  );
  return rows[0];
}
// آخر قراءة طقس محفوظة.
const latestWeather = (db) => db.query('SELECT * FROM weather_readings ORDER BY recorded_at DESC, id DESC LIMIT 1').then((r) => r.rows[0] || null);
// قراءات الطقس خلال آخر N ساعة بترتيب زمني (تُرسل إلى خدمة الذكاء الاصطناعي).
const weatherSince = (db, hours) =>
  db.query(`SELECT recorded_at, temperature, humidity, pressure FROM weather_readings
            WHERE recorded_at >= now() - make_interval(hours => $1) ORDER BY recorded_at`, [hours]).then((r) => r.rows);
// وقت أقدم قراءة خلال آخر N ساعة (لمعرفة كم دقيقة من السجل متوفرة للذكاء الاصطناعي).
const firstWeatherSince = (db, hours) =>
  db.query('SELECT MIN(recorded_at) AS t FROM weather_readings WHERE recorded_at >= now() - make_interval(hours => $1)', [hours]).then((r) => r.rows[0].t);
/**
 * أقرب قراءة طقس إلى لحظة معينة، ضمن ± toleranceMinutes دقيقة.
 * تُستخدم لحساب تغيّر الضغط والرطوبة خلال 3 ساعات في لوحة التحكم.
 */
async function weatherNear(db, at, toleranceMinutes = 10) {
  const { rows } = await db.query(
    `SELECT * FROM weather_readings
     WHERE recorded_at BETWEEN $1::timestamptz - make_interval(mins => $2) AND $1::timestamptz + make_interval(mins => $2)
     ORDER BY abs(extract(epoch FROM recorded_at - $1::timestamptz)) LIMIT 1`, [at, toleranceMinutes]);
  return rows[0] || null;
}
// حفظ حدث مطر (بدأ/توقف) كما أرسلته عقدة الحساسات.
async function insertRainEvent(db, e) {
  await db.query('INSERT INTO rain_events (device_id, event_type, rain_level) VALUES ($1,$2,$3)', [e.device_id, e.event, e.rain_level ?? null]);
}

// ---------- التربة (soil) ----------
// حفظ قراءة رطوبة تربة لمنطقة. القراءة غير الصالحة تُحفظ بقيمة null مع valid=false (للتشخيص فقط).
async function insertSoil(db, deviceId, z, source = 'device', recordedAt = null) {
  await db.query(
    `INSERT INTO soil_readings (device_id, zone_id, soil_moisture, raw_adc, valid, source, recorded_at)
     VALUES ($1,$2,$3,$4,$5,$6, COALESCE($7, now()))`,
    [deviceId, z.zone_id, z.valid ? z.soil_moisture : null, z.raw_adc ?? null, z.valid, source, recordedAt],
  );
}
// آخر قراءة محفوظة لكل منطقة (DISTINCT ON يأخذ أحدث صف لكل zone_id).
const latestSoilByZone = (db) =>
  db.query(`SELECT DISTINCT ON (zone_id) zone_id, soil_moisture, raw_adc, valid, recorded_at
            FROM soil_readings ORDER BY zone_id, recorded_at DESC, id DESC`).then((r) => r.rows);

// ---------- التنبؤات (predictions) ----------
// حفظ محاولة تنبؤ (ناجحة أو فاشلة). features و drivers تُخزَّن كـ JSON لشرح سبب النتيجة.
async function insertPrediction(db, p) {
  const { rows } = await db.query(
    `INSERT INTO rain_predictions (rain_probability, threshold, horizon_hours, model_version, status, features, drivers)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [p.rain_probability ?? null, p.threshold ?? null, p.horizon_hours ?? null, p.model_version ?? null, p.status,
      p.features ? JSON.stringify(p.features) : null, p.drivers ? JSON.stringify(p.drivers) : null],
  );
  return rows[0];
}
// آخر محاولة تنبؤ أيًّا كانت حالتها (لعرضها في لوحة التحكم).
const latestPrediction = (db) => db.query('SELECT * FROM rain_predictions ORDER BY created_at DESC, id DESC LIMIT 1').then((r) => r.rows[0] || null);
// آخر تنبؤ ناجح (status = 'OK') فقط؛ هو ما يُرسل إلى ESP32 #2 لاتخاذ القرار.
const latestOkPrediction = (db) =>
  db.query(`SELECT * FROM rain_predictions WHERE status = 'OK' ORDER BY created_at DESC, id DESC LIMIT 1`).then((r) => r.rows[0] || null);

// ---------- القرارات (التي ترسلها ESP32 #2) ----------
// حفظ قرار منطقة مع سياقه (احتمال المطر، رطوبة التربة، وضع النظام) والـ trace كـ JSON.
async function insertDecision(db, d) {
  const { rows } = await db.query(
    `INSERT INTO irrigation_decisions (device_id, zone_id, action, seconds, planned_seconds, est_liters, reason_code, urgency,
       chosen, rain_probability, soil_moisture, system_mode, trace)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
    [d.device_id, d.zone_id, d.action, d.seconds, d.planned_seconds, d.est_liters, d.reason_code, d.urgency ?? null,
      d.chosen, d.rain_probability ?? null, d.soil_moisture ?? null, d.system_mode, JSON.stringify(d.trace || [])],
  );
  return rows[0];
}
// آخر قرار محفوظ لكل منطقة.
const latestDecisions = (db) =>
  db.query('SELECT DISTINCT ON (zone_id) * FROM irrigation_decisions ORDER BY zone_id, created_at DESC, id DESC').then((r) => r.rows);

// ---------- الأوامر اليدوية (manual commands) ----------
/**
 * إنشاء أمر تشغيل يدوي بحالة PENDING مع وقت انتهاء = الآن + ttl_seconds.
 * الانتهاء ضروري: لو تأخرت اللوحة (انقطاع Wi-Fi مثلًا) لا يجوز أن يُنفَّذ الأمر لاحقًا في وقت غير متوقع.
 */
async function insertManualCommand(db, c) {
  const { rows } = await db.query(
    `INSERT INTO manual_commands (command_id, zone_id, duration_seconds, status, expires_at)
     VALUES ($1,$2,$3,'PENDING', now() + make_interval(secs => $4)) RETURNING *`,
    [c.command_id, c.zone_id, c.duration_seconds, c.ttl_seconds],
  );
  return rows[0];
}
// الأمر اليدوي المنتظر الذي لم تنتهِ صلاحيته (الأقدم أولًا).
const pendingManual = (db) =>
  db.query(`SELECT * FROM manual_commands WHERE status = 'PENDING' AND expires_at > now() ORDER BY id LIMIT 1`).then((r) => r.rows[0] || null);
// تحويل الأوامر المنتظرة التي انتهى وقتها إلى EXPIRED، وإعادتها لتسجيل حدث لكل منها.
const expireManual = (db) =>
  db.query(`UPDATE manual_commands SET status = 'EXPIRED' WHERE status = 'PENDING' AND expires_at <= now() RETURNING command_id, zone_id`).then((r) => r.rows);
// إلغاء كل الأوامر المنتظرة مع ذكر السبب (مثل RAIN_OVERRIDE عند بدء المطر).
const cancelManual = (db, reason) =>
  db.query(`UPDATE manual_commands SET status = 'CANCELLED', cancel_reason = $1 WHERE status = 'PENDING' RETURNING command_id, zone_id`, [reason]).then((r) => r.rows);
/**
 * «استلام» أمر يدوي: ينجح فقط إن كان ما زال PENDING وصالحًا، ويحوّله إلى TAKEN في الخطوة نفسها.
 * بذلك لا يمكن تنفيذ الأمر الواحد مرتين (المحاولة الثانية تعيد null).
 */
const takeManual = (db, commandId) =>
  db.query(`UPDATE manual_commands SET status = 'TAKEN' WHERE command_id = $1 AND status = 'PENDING' AND expires_at > now() RETURNING *`, [commandId]).then((r) => r.rows[0] || null);

// ---------- نبضات الري (runs) ----------
// التشغيل النشط الآن (يوجد واحد على الأكثر بفضل قيد في قاعدة البيانات).
const activeRun = (db) => db.query(`SELECT * FROM irrigation_runs WHERE status = 'ACTIVE' LIMIT 1`).then((r) => r.rows[0] || null);
const getRun = (db, runId) => db.query('SELECT * FROM irrigation_runs WHERE run_id = $1', [runId]).then((r) => r.rows[0] || null);
// تسجيل بدء نبضة بحالة ACTIVE. إن وُجد تشغيل نشط آخر يرفض الفهرس الفريد في قاعدة البيانات الإدخال.
async function insertRun(db, r) {
  const { rows } = await db.query(
    `INSERT INTO irrigation_runs (run_id, device_id, zone_id, kind, command_id, reason_code, planned_seconds, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'ACTIVE') RETURNING *`,
    [r.run_id, r.device_id, r.zone_id, r.kind, r.command_id ?? null, r.reason_code ?? null, r.planned_seconds],
  );
  return rows[0];
}
/**
 * إنهاء نبضة نشطة بالحالة والمدة الفعلية واللترات التقديرية.
 * الشرط status = 'ACTIVE' يجعل التقرير المكرر بلا أثر: يعيد null بدل تعديل تشغيل منتهٍ.
 */
async function finishRun(db, runId, { status, actualSeconds, estLiters, stopReason }) {
  const { rows } = await db.query(
    `UPDATE irrigation_runs SET status = $2, actual_seconds = $3, est_liters = $4, stop_reason = $5, finished_at = now()
     WHERE run_id = $1 AND status = 'ACTIVE' RETURNING *`, [runId, status, actualSeconds, estLiters, stopReason ?? null]);
  return rows[0] || null;
}
/**
 * تحويل التشغيلات التي تجاوزت (المدة المخططة + مهلة إضافية) دون تقرير انتهاء إلى FAILED.
 * هذا يمنع بقاء النظام «يروي» إلى الأبد إن انقطعت اللوحة (واللوحة لها حد أمان خاص بها للمضخة على أي حال).
 */
const failOverdueRuns = (db, graceSeconds) =>
  db.query(`UPDATE irrigation_runs SET status = 'FAILED', stop_reason = 'NO_COMPLETION_REPORT', finished_at = now()
            WHERE status = 'ACTIVE' AND started_at + make_interval(secs => planned_seconds + $1) < now()
            RETURNING run_id, zone_id`, [graceSeconds]).then((r) => r.rows);
// آخر التشغيلات، الأحدث أولًا.
const recentRuns = (db, limit = 10) => db.query('SELECT * FROM irrigation_runs ORDER BY started_at DESC, id DESC LIMIT $1', [limit]).then((r) => r.rows);
// آخر تشغيل منتهٍ لكل منطقة (لعرض «آخر ري» في لوحة التحكم).
const lastRunByZone = (db) =>
  db.query(`SELECT DISTINCT ON (zone_id) zone_id, finished_at, status FROM irrigation_runs
            WHERE status <> 'ACTIVE' ORDER BY zone_id, finished_at DESC`).then((r) => r.rows);

module.exports = {
  touchDevice, listDevices, deviceExists,
  getState, setState,
  addEvent, recentEvents,
  listZones,
  insertWeather, latestWeather, weatherSince, firstWeatherSince, weatherNear, insertRainEvent,
  insertSoil, latestSoilByZone,
  insertPrediction, latestPrediction, latestOkPrediction,
  insertDecision, latestDecisions,
  insertManualCommand, pendingManual, expireManual, cancelManual, takeManual,
  activeRun, getRun, insertRun, finishRun, failOverdueRuns, recentRuns, lastRunByZone,
};
