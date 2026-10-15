/**
 * ملف السجلّ (logger) المشترك للـ backend كله.
 * يستخدم مكتبة pino لكتابة السجلات بصيغة JSON سريعة.
 * يستورده: server.js و app.js (عبر pino-http) و pool.js و الخدمات (services) التي تحتاج إلى التسجيل.
 */
const pino = require('pino');
const { config } = require('./index');

// مستوى السجل: يُؤخذ من LOG_LEVEL إن وُجد، وإلا يكون صامتًا أثناء الاختبارات و'info' في غيرها.
// في بيئة التطوير فقط يُستخدم pino-pretty لعرض سطور مقروءة بالوقت المحلي (HH:MM:ss)
// مع إخفاء رقم العملية واسم الجهاز لتقليل الضجيج.
const logger = pino({
  level: process.env.LOG_LEVEL || (config.env === 'test' ? 'silent' : 'info'),
  transport: config.env === 'development' ? { target: 'pino-pretty', options: { translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' } } : undefined,
});

module.exports = logger;
