/**
 * أدوات مساعدة لاختبار end-to-end الآلي فقط (ليست جزءًا من النظام العامل).
 *  - تتحدث مع الـ backend تمامًا كما تفعل لوحتا ESP32 (نقاط النهاية نفسها، JSON نفسه، x-api-key نفسه)
 *  - قرارات ESP32 #2 تأتي من محرك C++ الحقيقي (esp32/actuator_node/saqai_decision.h)، مُترجمًا
 *    للحاسوب باسم esp32/tests/decide_cli — وهو الكود نفسه الذي يعمل على اللوحة.
 * يستخدمها: rain-override.e2e.js.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// جذر المشروع، وتحميل backend/.env منه (للمنفذ ومفتاح الأجهزة).
const ROOT = path.resolve(__dirname, '../../..');
require(path.join(ROOT, 'backend/node_modules/dotenv')).config({ path: path.join(ROOT, 'backend/.env') });

// عنوان الـ backend المختبَر (SAQAI_URL أو localhost على المنفذ المضبوط).
const BASE = (process.env.SAQAI_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');
const KEY = process.env.DEVICE_API_KEY;
// مسار البرنامج التنفيذي لمحرك القرار بعد ترجمته.
const CLI = path.join(ROOT, 'esp32/tests/decide_cli');

/**
 * إرسال طلب HTTP إلى الـ backend مع x-api-key (ما لم يُمرَّر key: null لاختبار الرفض).
 * يعيد { status, body }؛ والجسم يُحلَّل كـ JSON إن أمكن وإلا يبقى نصًا.
 */
async function api(method, route, body, { key = KEY, headers = {} } = {}) {
  const res = await fetch(`${BASE}${route}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(key ? { 'x-api-key': key } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(8000),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* الرد ليس JSON */ }
  return { status: res.status, body: json ?? text };
}

// ترجمة محرك القرار C++ إلى برنامج يعمل على الحاسوب (يحتاج g++).
function buildCli() {
  execFileSync('g++', ['-std=c++17', '-O2', `-I${path.join(ROOT, 'esp32/actuator_node')}`, path.join(ROOT, 'esp32/tests/decide_cli.cpp'), '-o', CLI]);
}

/**
 * «عقل» ESP32 #2: المدخلات من GET /api/actuator/inputs + الذاكرة ← القرارات (محرك C++ الحقيقي).
 * تُحوَّل المدخلات إلى أسطر نصية بالترتيب الذي يتوقعه decide_cli (القيم المنطقية كـ 1/0)،
 * ثم يُقرأ ناتجه كـ JSON. mode = 'decide' لاتخاذ القرار، أو 'pulse' لتسجيل نبضة منتهية في الذاكرة.
 */
function decide(inputs, memory, nowS, mode = 'decide', pulse = null) {
  const e = inputs.engine;
  const p = inputs.prediction;
  const w = inputs.weather;
  const b = (x) => (x ? 1 : 0);
  const lines = [
    mode,
    // سطر الحالة العامة: الأقفال، المطر، قدم البيانات، التنبؤ، الطقس، والوقت الحالي بالثواني.
    [b(inputs.rain_lockout), b(inputs.cooldown), b(inputs.error), b(inputs.rain_detected), b(!inputs.sensors_fresh),
      b(p), p ? p.rain_probability : 0, p ? p.threshold : 0.1, b(w), w ? w.temperature : 0, w ? w.humidity : 0, nowS].join(' '),
    // سطر إعدادات المحرك (مدة النبضة محصورة بـ 60 ثانية كما في اللوحة).
    [e.max_defer_s, e.defer_hysteresis, e.soak_s, e.max_pulses, e.pulse_lock_s, e.followup_max_s, e.daily_max_s, Math.min(e.max_s, 60)].join(' '),
    inputs.zones.length,
    // سطر لكل منطقة (رطوبة -1 تعني عدم وجود قراءة).
    ...inputs.zones.map((z) => [z.id, b(z.enabled), b(z.has_reading), b(z.valid), z.soil ?? -1, z.target, z.critical, z.seconds_per_percent].join(' ')),
    // ذاكرة المحرك لكل منطقة (تحفظها اللوحة بين القرارات).
    ...memory.map((m) => m.join(' ')),
  ];
  if (pulse) lines.push(`${pulse.index} ${pulse.seconds}`);
  return JSON.parse(execFileSync(CLI, { input: `${lines.join('\n')}\n` }).toString());
}

/** قراءات ساعية حقيقية من الرياض: تُستخدم فقط لملء 4 ساعات من السجل حتى يعمل الذكاء الاصطناعي في الاختبار. */
function loadHistory() {
  // حذف علامة BOM في بداية الملف إن وُجدت، وتخطي سطر العناوين.
  return fs.readFileSync(path.join(ROOT, 'data/raw/riyadh_hourly_2015_2026.csv'), 'utf8')
    .replace(/^﻿/, '').trim().split('\n').slice(1).map((l) => {
      const [time, t, h, p] = l.split(',');
      return { time, temperature: +t, humidity: +h, pressure: +p };
    });
}

/**
 * إدخال 4 ساعات من القراءات السابقة (backfill) تنتهي عند الساعة anchor من الملف التاريخي.
 * تعمل فقط إن كان الخادم مشغلًا بـ NODE_ENV=test و ALLOW_DEVICE_TIMESTAMPS=true.
 */
async function backfill(anchor, soil, deviceId = 'sensor_node_01') {
  const rows = loadHistory();
  const i = rows.findIndex((r) => r.time === anchor);
  const now = Date.now();
  // 8 قراءات: 4 ساعات، كل 30 دقيقة (كل ساعة من الملف تُستخدم مرتين).
  for (let k = 8; k >= 1; k--) {
    const r = rows[i - Math.ceil(k / 2)];
    const out = await api('POST', '/api/readings', {
      device_id: deviceId, temperature: r.temperature, humidity: Math.round(r.humidity), pressure: r.pressure, rain_detected: false,
      soil, timestamp: new Date(now - (k / 2) * 3600_000).toISOString(),
    });
    if (out.status !== 201) throw new Error(`backfill failed: ${out.status} ${JSON.stringify(out.body)}`);
  }
  return rows[i];
}

module.exports = { api, buildCli, decide, backfill, BASE, ROOT };
