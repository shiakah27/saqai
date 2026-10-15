/**
 * بناء تطبيق Express.
 * يركّب الـ middleware العامة (الأمان، CORS، قراءة JSON، السجلات)، ثم مسارات الـ API تحت /api،
 * ثم يقدّم لوحة التحكم (React) المبنية من frontend/dist على العنوان نفسه.
 * يستدعيه server.js (وقد تستدعيه الاختبارات لإنشاء تطبيق دون تشغيل الخادم).
 */
const fs = require('fs');
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const pinoHttp = require('pino-http');
const { config } = require('./config');
const logger = require('./config/logger');
const routes = require('./routes');
const { notFound, errorHandler } = require('./middleware');

// ينشئ التطبيق ويعيده دون أن يبدأ الاستماع.
function createApp() {
  const app = express();
  // لا يوجد proxy أمام الخادم، فيُؤخذ عنوان IP الجهاز من الاتصال مباشرة.
  app.set('trust proxy', false);
  app.disable('x-powered-by');
  // CSP معطّل: لوحة التحكم تحمّل خطوط Google Fonts.
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(cors({ origin: config.corsOrigin }));
  // حد 32kb لجسم الطلب: رسائل ESP32 صغيرة.
  app.use(express.json({ limit: '32kb' }));
  app.use(pinoHttp({
    logger,
    // طلبات الأجهزة ولوحة التحكم المتكررة جدًا لا تُسجَّل سطرًا بسطر (حتى لا يمتلئ السجل).
    autoLogging: { ignore: (req) => ['/api/readings', '/api/actuator/inputs', '/api/status', '/api/history', '/api/stream'].some((p) => req.url.startsWith(p)) },
    // مستوى السجل حسب نتيجة الطلب: 5xx خطأ، 4xx تحذير، وغير ذلك معلومات.
    customLogLevel: (req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
  }));

  app.use('/api', routes);
  // أي مسار /api غير معروف يعيد 404 بصيغة JSON (ولا يقع في صفحة لوحة التحكم).
  app.use('/api', notFound);

  // تقديم لوحة التحكم المبنية من العنوان نفسه (http://<laptop-ip>:3000).
  const dist = path.resolve(__dirname, '../../frontend/dist');
  if (fs.existsSync(dist)) {
    app.use(express.static(dist));
    // أي مسار لا يبدأ بـ /api يعيد index.html حتى يتولى React التوجيه داخل الصفحة.
    app.get(/^(?!\/api).*/, (req, res) => res.sendFile(path.join(dist, 'index.html')));
  }

  app.use(notFound);
  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
