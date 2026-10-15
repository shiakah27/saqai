/**
 * نقطة بدء تشغيل الـ backend (npm start).
 * الترتيب: التحقق من الإعدادات ← ترحيل قاعدة البيانات ← إنشاء تطبيق Express ← الاستماع على المنفذ
 * ← تشغيل الـ scheduler في الخلفية. ويتولى أيضًا الإيقاف النظيف عند Ctrl+C أو SIGTERM.
 */
const os = require('os');
const { config, assertConfig } = require('./config');
const logger = require('./config/logger');
const { createApp } = require('./app');
const { migrate } = require('./database/migrate');
const { pool } = require('./database/pool');
const scheduler = require('./services/scheduler');

// الدالة الرئيسية لتشغيل الخادم.
async function main() {
  assertConfig();
  await migrate({ log: (msg) => logger.info(msg) });
  const app = createApp();
  // الاستماع على 0.0.0.0 حتى تصل إليه لوحتا ESP32 على شبكة Wi-Fi نفسها (وليس localhost فقط).
  const server = app.listen(config.port, '0.0.0.0', () => {
    logger.info(`SAQAI backend listening on port ${config.port}`);
    // طباعة العنوان الذي يُوضع في BACKEND_URL داخل esp32/*/secrets.h (وليس "localhost" أبدًا).
    for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
      for (const a of addrs || []) {
        if (a.family === 'IPv4' && !a.internal) logger.info(`  dashboard + ESP32 BACKEND_URL → http://${a.address}:${config.port}   (${name})`);
      }
    }
  });
  scheduler.start();

  // الإيقاف النظيف: إيقاف الـ scheduler، ثم إغلاق الخادم، ثم إغلاق اتصالات قاعدة البيانات.
  const shutdown = async () => {
    scheduler.stop();
    server.close();
    await pool.end().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// أي خطأ عند البدء (إعدادات ناقصة، قاعدة بيانات لا تعمل...) يُسجَّل ويخرج البرنامج برمز 1.
main().catch((err) => {
  logger.error({ err: err.message }, 'failed to start');
  process.exit(1);
});
