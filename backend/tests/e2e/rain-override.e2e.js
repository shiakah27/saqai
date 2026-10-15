/**
 * اختبار END-TO-END على الـ backend العامل + خدمة الذكاء الاصطناعي + PostgreSQL.
 * يمثّل دور ESP32 #1 (إطارات حساسات لحظية) ودور ESP32 #2 (تقرر بمحرك C++ الحقيقي، صمام واحد).
 *
 *   A  التحقق من صحة الـ API والأمان
 *   B  إطارات لحظية ← تنبؤ الذكاء الاصطناعي ← ESP32 #2 تختار المنطقة الأحوج (واحدة فقط) ← يبدأ الري
 *   C  مطر أثناء الري: قفل، المضخة تتوقف في الاستطلاع التالي، التشغيل يُلغى، ولا يجوز بدء أي شيء
 *   D  توقف المطر ← cooldown ← قراءات تربة جديدة ← الجهاز يقرر من جديد ← تشغيل جديد
 *   E  دورة حياة التشغيل اليدوي التجريبي · حساسات قديمة ← توقف (HOLD)
 *
 * يُشغَّل على قاعدة بيانات اختبار منفصلة (لأنه يفرغ جداول القراءات أولًا). انظر docs/test-plan.md:
 *   شغّل الـ backend بـ NODE_ENV=test ALLOW_DEVICE_TIMESTAMPS=true RAIN_COOLDOWN_MINUTES=0.25 SOAK_SECONDS=5
 *   SENSOR_STALE_SECONDS=4، ثم:  npm run e2e
 */
const path = require('path');
const { api, buildCli, decide, backfill, ROOT } = require('./devices');
const { Client } = require(path.join(ROOT, 'backend/node_modules/pg'));

// معرّفا الجهازين كما في seeds، وترويسة مفتاح الإدارة.
const S = 'sensor_node_01';
const A = 'actuator_node_01';
const ADMIN = { headers: { 'x-admin-key': process.env.ADMIN_API_KEY } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
// تسجيل نتيجة فحص واحد وطباعتها PASS/FAIL مع تفاصيل اختيارية.
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

// ---- نسخة مصغرة من ESP32 #2 ----
// ذاكرة محرك القرار لكل منطقة من المناطق الثلاث (كما تحفظها اللوحة بين القرارات).
const memory = [[0, 0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0, 0]];
// ساعة اللوحة بالثواني (تبدأ من 100000 لتشبه uptime حقيقيًا).
const t0 = Date.now();
const nowS = () => Math.floor((Date.now() - t0) / 1000) + 100000;
// استطلاع GET /api/actuator/inputs كما تفعل اللوحة.
const inputs = async () => (await api('GET', `/api/actuator/inputs?device_id=${A}`)).body;
// اتخاذ القرار بالمحرك الحقيقي، وتحديث الذاكرة، ثم إبلاغ الـ backend بالقرارات.
async function evaluate(inp) {
  const out = decide(inp, memory, nowS());
  out.memory.forEach((m, i) => { memory[i] = m; });
  await api('POST', '/api/actuator/decisions', { device_id: A, chosen_zone: out.chosen >= 0 ? out.zones[out.chosen].zone_id : null, zones: out.zones });
  return out;
}
// إنهاء نبضة: تسجيلها في ذاكرة المحرك (وضع 'pulse')، ثم إرسال تقرير finished مع المضخة OFF والصمام CLOSED.
async function finish(run, status, seconds, stopReason) {
  const out = decide(await inputs(), memory, nowS(), 'pulse', { index: run.zone - 1, seconds: Math.round(seconds) });
  out.memory.forEach((m, i) => { memory[i] = m; });
  return api('POST', '/api/actuator/run', {
    event: 'finished', device_id: A, run_id: run.run_id, zone: run.zone, status, actual_seconds: seconds,
    ...(stopReason ? { stop_reason: stopReason } : {}), pump: 'OFF', valve: 'CLOSED',
  });
}
let n = 0;
// بدء نبضة برقم run_id فريد؛ يعيد هل طلب الـ backend الإيقاف (abort).
async function start(zone, seconds, reason, commandId) {
  const run = { run_id: `run_e2e_${++n}_${Date.now().toString(36)}`, zone };
  const r = await api('POST', '/api/actuator/run', {
    event: 'started', device_id: A, run_id: run.run_id, zone, planned_seconds: seconds, reason, ...(commandId ? { command_id: commandId } : {}),
  });
  return { run, abort: r.body.abort, status: r.status };
}

// ---- ESP32 #1 ----
// رطوبة التربة الحالية لكل منطقة (يغيّرها الاختبار لمحاكاة أثر الري والمطر).
const soilNow = { 1: 20, 2: 45, 3: 26 };
let raining = false;
// إرسال إطار قراءات واحد بالقيم الحالية.
const frame = () => api('POST', '/api/readings', {
  device_id: S, temperature: 33.2, humidity: 14, pressure: 940.8, rain_detected: raining, rain_level: raining ? 2 : 0,
  soil: Object.entries(soilNow).map(([z, v]) => ({ zone_id: +z, soil_moisture: v, raw_adc: 2500 })), rssi: -58, uptime_s: 60,
});
let streaming = true;
// بث إطار كل ثانية حتى يُضبط streaming = false (لمحاكاة انقطاع عقدة الحساسات لاحقًا).
async function stream() { while (streaming) { await frame().catch(() => {}); await sleep(1000); } }

async function main() {
  // حماية: يرفض العمل إن لم يبدُ أن DATABASE_URL قاعدة اختبار، لأنه يمسح القراءات.
  if (!/test/i.test(process.env.DATABASE_URL || '') && process.env.E2E_I_UNDERSTAND !== 'yes') {
    console.error('Refusing to run: DATABASE_URL does not look like a test database (it would wipe readings).');
    process.exit(2);
  }
  buildCli();
  // اتصال مباشر بقاعدة البيانات لتفريغ الجداول وإعادة الحالة إلى NORMAL، وللتحقق من النتائج.
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  await db.query(`TRUNCATE irrigation_runs, manual_commands, irrigation_decisions, rain_predictions, soil_readings,
                  weather_readings, rain_events, system_events RESTART IDENTITY CASCADE`);
  await db.query(`UPDATE system_state SET mode = 'NORMAL', since = now(), cooldown_until = NULL, error_reason = NULL`);
  const cooldownMin = Number(process.env.RAIN_COOLDOWN_MINUTES || 5);

  console.log('\n[A] API validation & security');
  const good = { device_id: S, temperature: 30, humidity: 20, pressure: 940, rain_detected: false, soil: [{ zone_id: 1, soil_moisture: 30 }] };
  check('no x-api-key → 401', (await api('POST', '/api/readings', good, { key: null })).status === 401);
  const pa = await api('POST', '/api/readings', { ...good, pressure: 94000 });
  check('pressure in Pa instead of hPa → 400', pa.status === 400, pa.body?.details?.[0]?.message);
  check('missing field → 400', (await api('POST', '/api/readings', { device_id: S, temperature: 30 })).status === 400);
  check('wrong type → 400', (await api('POST', '/api/readings', { ...good, temperature: '30' })).status === 400);
  check('unknown device → 403', (await api('POST', '/api/readings', { ...good, device_id: 'sensor_node_99' })).status === 403);
  check('sensor node cannot pose as actuator → 403', (await api('GET', `/api/actuator/inputs?device_id=${S}`)).status === 403);
  check('unknown zone → 422', (await api('POST', '/api/readings', { ...good, soil: [{ zone_id: 9, soil_moisture: 30 }] })).status === 422);
  check('RAIN_STARTED with rain_detected=false → 400', (await api('POST', '/api/rain-event', { device_id: S, event: 'RAIN_STARTED', rain_detected: false })).status === 400);
  check('run reported finished with pump ON → 400', (await api('POST', '/api/actuator/run', { event: 'finished', device_id: A, run_id: 'x_bad', zone: 1, status: 'completed', actual_seconds: 1, pump: 'ON', valve: 'CLOSED' })).status === 400);
  const bad = await api('POST', '/api/readings', { ...good, soil: [{ zone_id: 1, soil_moisture: 140 }] });
  const inBad = await inputs();
  // قيمة رطوبة 140% تُقبل كإطار لكنها تُعلَّم غير صالحة ولا تصل إلى القرار أبدًا.
  check('impossible soil value → stored as invalid, never usable', bad.status === 201 && inBad.zones[0].valid === false && inBad.zones[0].soil === null);

  console.log('\n[B] Real-time sensors → AI → ESP32 #2 chooses ONE zone');
  // ملء 4 ساعات من سجل الطقس حتى يعمل التنبؤ، ثم بدء البث اللحظي.
  await backfill('2025-10-08T12:00', [{ zone_id: 1, soil_moisture: 30 }, { zone_id: 2, soil_moisture: 45 }, { zone_id: 3, soil_moisture: 30 }]);
  stream();
  await sleep(1500);
  const pred = (await api('POST', '/api/admin/predict', null, ADMIN)).body;
  check('AI prediction from the station\'s own history', pred.status === 'OK', `p=${pred.rain_probability}, model ${pred.model_version}`);
  let inp = await inputs();
  check('actuator inputs: live soil, fresh sensors, prediction, zone settings', inp.sensors_fresh && inp.zones[0].soil === 20 && inp.prediction && inp.zones[0].target === 40,
    `sensor age ${inp.sensor_age_s}s`);
  const d1 = await evaluate(inp);
  const byZone = Object.fromEntries(d1.zones.map((z) => [z.zone_id, z]));
  check('zone 1 (20%, critical 22%) → IRRIGATE CRITICAL_DRY', byZone[1].action === 'IRRIGATE' && byZone[1].reason === 'CRITICAL_DRY', `${byZone[1].seconds}s`);
  check('zone 3 (26%, target 30%) → IRRIGATE BELOW_TARGET (but waits its turn)', byZone[3].action === 'IRRIGATE');
  check('zone 2 (45%) → SKIP AT_TARGET', byZone[2].action === 'SKIP');
  check('ONE zone chosen: the neediest (zone 1)', d1.chosen === 0);
  const s1 = await start(1, byZone[1].seconds, byZone[1].reason);
  const st1 = (await api('GET', '/api/status')).body;
  check('run accepted; pump ON; valve 1 OPEN; valves 2 and 3 CLOSED', !s1.abort && st1.pump === 'ON'
    && st1.zones.map((z) => z.valve).join() === 'OPEN,CLOSED,CLOSED', st1.zones.map((z) => z.valve).join());
  const dec = (await db.query('SELECT count(*)::int n FROM irrigation_decisions WHERE chosen')).rows[0].n;
  check('decision stored with trace, chosen flag set', dec === 1);

  console.log('\n[C] Rain during irrigation');
  await sleep(1000);
  // قياس الزمن من حدث المطر حتى يعلم الجهاز بوجوب التوقف.
  const tRain = Date.now();
  raining = true;
  const ev = await api('POST', '/api/rain-event', { device_id: S, event: 'RAIN_STARTED', rain_detected: true, rain_level: 2 });
  check('rain event → RAIN_LOCKOUT', ev.body.system_mode === 'RAIN_LOCKOUT');
  inp = await inputs();
  const stopNow = inp.rain_lockout || inp.rain_detected || inp.active_run_id !== s1.run.run_id;
  check('next poll tells ESP32 #2 to stop', stopNow, `${Date.now() - tRain} ms after the event`);
  const f1 = await finish(s1.run, 'cancelled', 2.1, 'RAIN_OVERRIDE');
  const r1 = (await db.query('SELECT status, stop_reason FROM irrigation_runs WHERE run_id = $1', [s1.run.run_id])).rows[0];
  check('run CANCELLED / RAIN_OVERRIDE; pump OFF', f1.status === 201 && r1.status === 'CANCELLED' && r1.stop_reason === 'RAIN_OVERRIDE');
  const d2 = await evaluate(inp);
  check('device engine: every zone HOLD, no zone chosen', d2.chosen === -1 && d2.zones.every((z) => z.action === 'HOLD'));
  const s2 = await start(3, 10, 'BELOW_TARGET');
  check('a run reported during lockout is refused (abort)', s2.abort === true);
  check('manual test run refused during rain → 409', (await api('POST', '/api/admin/manual-run', { zone_id: 2, seconds: 5 }, ADMIN)).status === 409);
  const evs = (await db.query('SELECT type FROM system_events ORDER BY id')).rows.map((r) => r.type);
  check('events: RAIN_STARTED, IRRIGATION_STOPPED, IRRIGATION_STOP_CONFIRMED, RUN_REFUSED',
    ['RAIN_STARTED', 'IRRIGATION_STOPPED', 'IRRIGATION_STOP_CONFIRMED', 'RUN_REFUSED'].every((t) => evs.includes(t)));

  console.log('\n[D] Rain stops → cooldown → fresh soil → decide again');
  raining = false;
  const stop = await api('POST', '/api/rain-event', { device_id: S, event: 'RAIN_STOPPED', rain_detected: false });
  check('rain stopped → COOLDOWN', stop.body.system_mode === 'COOLDOWN');
  const d3 = await evaluate(await inputs());
  check('during cooldown: HOLD everywhere', d3.chosen === -1 && d3.zones[0].reason === 'COOLDOWN');
  // التربة تغيّرت بعد المطر، ثم انتظار انتهاء cooldown (مع هامش 15 ثانية).
  soilNow[1] = 24; soilNow[3] = 33;
  const normal = await (async () => {
    const end = Date.now() + cooldownMin * 60_000 + 15_000;
    while (Date.now() < end) { const s = (await api('GET', '/api/system/state')).body; if (s.mode === 'NORMAL') return true; await sleep(500); }
    return false;
  })();
  check(`cooldown ended after ~${cooldownMin} min → NORMAL`, normal);
  await sleep(1200);
  const d4 = await evaluate(await inputs());
  const z1 = d4.zones[0];
  check('decision uses the fresh soil (zone 1 at 24%) and still picks only zone 1', d4.chosen === 0 && z1.action === 'IRRIGATE', `${z1.reason} ${z1.seconds}s`);
  check('zone 3 now above target (33%) → SKIP', d4.zones[2].action === 'SKIP');
  const s4 = await start(1, z1.seconds, z1.reason);
  const f4 = await finish(s4.run, 'completed', z1.seconds);
  // تقرير انتهاء مكرر يجب أن يُقبل دون أثر (idempotent).
  const dup = await finish(s4.run, 'completed', z1.seconds);
  const r4 = (await db.query('SELECT status FROM irrigation_runs WHERE run_id = $1', [s4.run.run_id])).rows[0];
  check('new run with a new run_id completes; repeated report is harmless', !s4.abort && f4.status === 201 && r4.status === 'COMPLETED' && dup.body.duplicate === true);
  const d5 = await evaluate(await inputs());
  check('right after a pulse the zone soaks (HOLD SOAKING) — closed loop', d5.zones[0].reason === 'SOAKING');

  console.log('\n[E] Manual test run · stale sensors');
  const man = (await api('POST', '/api/admin/manual-run', { zone_id: 2, seconds: 5 }, ADMIN)).body;
  inp = await inputs();
  check('manual request reaches ESP32 #2 with command_id', inp.manual && inp.manual.command_id === man.command_id && inp.manual.zone === 2);
  const sm = await start(2, 5, 'MANUAL_TEST', man.command_id);
  const again = await start(2, 5, 'MANUAL_TEST', man.command_id);
  check('manual command runs once; a second start with the same command_id is refused', !sm.abort && again.abort === true);
  await finish(sm.run, 'completed', 5);
  check('system back to NORMAL', (await api('GET', '/api/system/state')).body.mode === 'NORMAL');
  // إيقاف البث وانتظار تجاوز SENSOR_STALE_SECONDS حتى تصبح البيانات قديمة.
  streaming = false;
  await sleep(Number(process.env.SENSOR_STALE_SECONDS || 10) * 1000 + 1500);
  const d6 = await evaluate(await inputs());
  check('sensor node silent → inputs stale → ESP32 #2 holds every zone', d6.chosen === -1 && d6.zones.every((z) => z.reason === 'INPUTS_STALE'));

  // الملخص النهائي: رمز الخروج 1 إن فشل أي فحص.
  await db.end();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
