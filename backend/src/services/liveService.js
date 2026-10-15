/**
 * الطبقة اللحظية (في الذاكرة فقط).
 *  - تحتفظ بآخر إطار من عقدة الحساسات (كل ~2 ثانية)، فتحصل ESP32 #2 ولوحة التحكم دائمًا على أحدث
 *    القيم دون انتظار قاعدة البيانات
 *  - تدفع التحديثات إلى لوحات التحكم المفتوحة عبر Server-Sent Events (GET /api/stream)
 * قاعدة البيانات تحفظ التاريخ؛ وهذه الوحدة تحفظ «الآن».
 * يكتب فيها: readingsService. ويقرأ منها: actuatorService و statusService. ويبث عبرها كل من يغيّر الحالة.
 */
// آخر إطار: { received_at, temperature, humidity, pressure, rain_detected, rain_level, soil: [...] }
let latest = null;
// ردود HTTP المفتوحة لكل لوحة تحكم متصلة بالبث.
const clients = new Set();

// حفظ إطار جديد مختومًا بوقت استلامه على الخادم، ثم بثه فورًا.
function setFrame(frame) {
  latest = { ...frame, received_at: new Date().toISOString() };
  broadcast('live', latest);
  return latest;
}

const getFrame = () => latest;
// عمر آخر إطار بالثواني (Infinity إن لم يصل أي إطار منذ بدء الخادم).
const frameAgeSeconds = () => (latest ? (Date.now() - new Date(latest.received_at)) / 1000 : Infinity);

/**
 * إرسال حدث SSE لكل اللوحات المتصلة.
 * أسماء الأحداث: 'live' (إطار حساسات جديد)، و 'changed' (تغيرت الحالة أو قرار أو تشغيل ← أعد جلب /status).
 */
function broadcast(event, data = {}) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}

/**
 * فتح اتصال SSE لعميل جديد: ترويسات تمنع التخزين المؤقت والتجميع (buffering)،
 * وإعادة الاتصال بعد 2 ثانية عند الانقطاع، وإرسال آخر إطار فورًا حتى لا تبدأ اللوحة فارغة.
 */
function attach(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 2000\n\n');
  if (latest) res.write(`event: live\ndata: ${JSON.stringify(latest)}\n\n`);
  clients.add(res);
  // تعليق ping كل 15 ثانية يبقي الاتصال حيًا حتى لا تغلقه الشبكة أو المتصفح لعدم النشاط.
  const ping = setInterval(() => res.write(': ping\n\n'), 15000);
  // عند إغلاق الصفحة: إيقاف الـ ping وحذف العميل.
  req.on('close', () => { clearInterval(ping); clients.delete(res); });
}

module.exports = { setFrame, getFrame, frameAgeSeconds, broadcast, attach, clientCount: () => clients.size };
