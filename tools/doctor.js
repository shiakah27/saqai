/**
 * فحص نظام SAQAI الشامل — يُشغَّل على الحاسوب المحمول كلما لم يعمل شيء كما يجب.
 *
 *   cd backend && npm run doctor
 *
 * يفحص بالترتيب: الإعدادات ← PostgreSQL ← خدمة الذكاء الاصطناعي ← الـ backend ← كل ESP32 ← تدفق البيانات
 * ← حالة الأمان، ويطبع العنوان الدقيق الذي يُوضع في BACKEND_URL على لوحتي ESP32.
 * يقرأ قاعدة البيانات مباشرة (قراءة فقط) ولا يغيّر شيئًا. لكل مشكلة يطبع سطر الإصلاح المقترح بعد السهم.
 */
const os = require('os');
const path = require('path');

// جذر المشروع؛ والحزم تُحمَّل من backend/node_modules لأن مجلد tools ليس له حزم خاصة به.
const ROOT = path.resolve(__dirname, '..');
const need = (m) => require(path.join(ROOT, 'backend/node_modules', m));
need('dotenv').config({ path: path.join(ROOT, 'backend/.env') });
const { Client } = need('pg');

const PORT = process.env.PORT || 3000;
const AI = (process.env.AI_SERVICE_URL || 'http://localhost:8000').replace(/\/$/, '');
// عدد المشكلات المكتشفة؛ وأدوات طباعة: ✔ نجاح، ! تحذير، ✘ مشكلة (مع اقتراح إصلاح).
let problems = 0;
const ok = (m) => console.log(`  ✔ ${m}`);
const warn = (m) => console.log(`  ! ${m}`);
const bad = (m, fix) => { problems++; console.log(`  ✘ ${m}${fix ? `\n      → ${fix}` : ''}`); };
// عرض الوقت المنقضي منذ لحظة معينة بالثواني ("never" إن لم يحدث).
const ago = (t) => (t ? `${Math.round((Date.now() - new Date(t)) / 1000)} s ago` : 'never');

// طلب GET بمهلة 3 ثوانٍ، يعيد الحالة والجسم كـ JSON (أو null).
async function get(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
  return { status: res.status, body: await res.json().catch(() => null) };
}

(async () => {
  console.log('\nSAQAI doctor\n');

  console.log('Configuration');
  for (const k of ['DATABASE_URL', 'DEVICE_API_KEY']) process.env[k] ? ok(`${k} set`) : bad(`${k} missing`, 'copy .env.example to backend/.env');
  if (process.env.DEVICE_API_KEY === 'replace_with_a_long_random_string') bad('DEVICE_API_KEY is still the placeholder', 'set a long random value here AND in both secrets.h');

  console.log('\nNetwork — put ONE of these in BACKEND_URL (esp32/*/secrets.h)');
  // كل عناوين IPv4 الخارجية للحاسوب (ليست 127.0.0.1).
  const ips = Object.entries(os.networkInterfaces()).flatMap(([n, a]) => (a || []).filter((x) => x.family === 'IPv4' && !x.internal).map((x) => [n, x.address]));
  if (!ips.length) bad('no network connection', 'connect the laptop to the same Wi-Fi/hotspot as the ESP32 boards');
  for (const [n, a] of ips) console.log(`    http://${a}:${PORT}   (${n})`);

  console.log('\nPostgreSQL');
  const db = new Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 4000 });
  try {
    await db.connect();
    ok('connected');
  } catch (e) {
    // بدون قاعدة البيانات لا يمكن متابعة بقية الفحوص، فيتوقف هنا.
    bad(`cannot connect: ${e.message}`, 'docker compose up -d   (then: docker compose ps)');
    console.log(`\n${problems} problem(s).`);
    process.exit(1);
  }

  console.log('\nAI service');
  try {
    const h = await get(`${AI}/health`);
    h.status === 200 ? ok(`${h.body.model_version} loaded`) : bad(`HTTP ${h.status}`);
  } catch {
    bad(`not reachable at ${AI}`, 'uvicorn main:app --app-dir ai/service --host 0.0.0.0 --port 8000   (venv active)');
  }

  console.log('\nBackend');
  try {
    const h = await get(`http://localhost:${PORT}/api/health`);
    h.status === 200 ? ok(`running on port ${PORT}`) : bad(`health HTTP ${h.status}`);
  } catch {
    bad(`not running on port ${PORT}`, 'cd backend && npm start');
  }

  console.log('\nDevices');
  const { rows: devices } = await db.query('SELECT * FROM devices ORDER BY id');
  for (const d of devices) {
    const age = d.last_seen_at ? (Date.now() - new Date(d.last_seen_at)) / 1000 : Infinity;
    // الجهاز «متصل» إن ظهر خلال آخر 15 ثانية (مثل SENSOR_OFFLINE_S / ACTUATOR_OFFLINE_S الافتراضية).
    const limit = 15;
    if (age <= limit) ok(`${d.id}: online (seen ${ago(d.last_seen_at)}, ${d.last_ip || '?'}, RSSI ${d.rssi ?? '?'} dBm, fw ${d.firmware || '?'})`);
    else if (!d.last_seen_at) bad(`${d.id}: has never connected`, 'check Serial Monitor: Wi-Fi name/password, BACKEND_URL, DEVICE_API_KEY, Windows firewall (port 3000)');
    else if (d.kind === 'actuator') bad(`${d.id}: offline — pump is stopped by its own fail-safe`, 'power, Wi-Fi range, or the laptop IP changed (update secrets.h)');
    else bad(`${d.id}: offline (last seen ${ago(d.last_seen_at)})`, 'power, Wi-Fi range, or the laptop IP changed (update secrets.h)');
    // إشارة Wi-Fi أضعف من -80 dBm قد تسبب انقطاعات.
    if (d.rssi && d.rssi < -80) warn(`${d.id}: weak Wi-Fi (${d.rssi} dBm) — move it closer to the hotspot`);
  }

  console.log('\nData');
  const w = (await db.query('SELECT * FROM weather_readings ORDER BY recorded_at DESC LIMIT 1')).rows[0];
  if (!w) bad('no weather readings yet', 'the sensor node streams every 2 s (one row stored per minute)');
  else {
    ok(`last weather ${ago(w.recorded_at)}: ${w.temperature}°C ${w.humidity}% ${w.pressure} hPa rain=${w.rain_detected}`);
    // ضغط المحطة في الرياض عادة ~930–955 hPa؛ قيمة بعيدة تعني غالبًا خطأ في الوحدة أو الحساس.
    if (w.pressure < 900 || w.pressure > 1000) warn(`pressure ${w.pressure} hPa is unusual for Riyadh (~930–955 station pressure)`);
  }
  // كم دقيقة من سجل الطقس متوفرة خلال آخر 4 ساعات؛ الذكاء الاصطناعي يحتاج ~3 ساعات (165 دقيقة مع هامش).
  const first = (await db.query(`SELECT MIN(recorded_at) t FROM weather_readings WHERE recorded_at > now() - interval '4 hours'`)).rows[0].t;
  const mins = first && w ? Math.round((new Date(w.recorded_at) - new Date(first)) / 60000) : 0;
  mins >= 165 ? ok(`station history ${mins} min — enough for the AI`) : warn(`station history ${mins}/180 min — AI predictions start after ~3 h of readings (irrigation works on soil alone until then)`);
  // آخر قراءة تربة لكل منطقة.
  const soil = (await db.query('SELECT DISTINCT ON (zone_id) * FROM soil_readings ORDER BY zone_id, recorded_at DESC')).rows;
  if (!soil.length) bad('no soil readings yet', 'soil sensors are on the sensor node (ESP32 #1), GPIO 32/33/34');
  for (const s of soil) {
    const line = `zone ${s.zone_id}: ${s.valid ? `${s.soil_moisture}%` : 'INVALID'} (raw ADC ${s.raw_adc ?? '?'}, ${ago(s.recorded_at)})`;
    s.valid ? ok(line) : bad(line, 'sensor disconnected or not calibrated (docs/calibration.md)');
  }
  // آخر محاولة تنبؤ (OK تُعرض كنجاح، وأي حالة أخرى كتحذير).
  const p = (await db.query('SELECT * FROM rain_predictions ORDER BY created_at DESC LIMIT 1')).rows[0];
  if (p) (p.status === 'OK' ? ok : warn)(`last prediction ${ago(p.created_at)}: ${p.status}${p.rain_probability != null ? ` p=${p.rain_probability}` : ''}`);

  console.log('\nSafety state');
  // وضع النظام الحالي؛ ERROR مشكلة تحتاج إلى إصلاح السبب ثم مسح العطل.
  const st = (await db.query('SELECT * FROM system_state WHERE id = 1')).rows[0];
  (st.mode === 'ERROR' ? bad : ok)(`mode ${st.mode} since ${ago(st.since)}${st.error_reason ? ` (${st.error_reason})` : ''}`,
    st.mode === 'ERROR' ? 'fix the cause, then POST /api/admin/reset-error (or the dashboard maintenance panel)' : undefined);
  // تشغيل نشط الآن (إن وُجد)، ثم آخر قرار لكل منطقة.
  const run = (await db.query(`SELECT run_id, zone_id, planned_seconds, started_at FROM irrigation_runs WHERE status = 'ACTIVE'`)).rows[0];
  if (run) console.log(`    watering zone ${run.zone_id} now (${run.planned_seconds} s, started ${ago(run.started_at)})`);
  const d = (await db.query('SELECT DISTINCT ON (zone_id) zone_id, action, reason_code, created_at FROM irrigation_decisions ORDER BY zone_id, created_at DESC')).rows;
  if (!d.length) warn('no decisions from the actuator node yet');
  d.forEach((x) => console.log(`    zone ${x.zone_id}: ${x.action} ${x.reason_code} (${ago(x.created_at)})`));

  await db.end();
  console.log(`\n${problems ? `${problems} problem(s) found.` : 'Everything looks good.'}\n`);
  process.exit(problems ? 1 : 0);
})();
