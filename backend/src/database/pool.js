/**
 * الاتصال بقاعدة PostgreSQL.
 * ينشئ مجمّع اتصالات (pool) واحدًا للتطبيق كله، ويوفر:
 *   - query: لتنفيذ استعلام منفرد.
 *   - tx: لتنفيذ عدة استعلامات داخل معاملة (transaction) واحدة تنجح كلها أو تفشل كلها.
 * يستخدمه: models و services و controllers و migrate.js و server.js (لإغلاق الاتصالات عند الإيقاف).
 */
const { Pool, types } = require('pg');
const { config } = require('../config');
const logger = require('../config/logger');

// أعمدة NUMERIC تصل افتراضيًا كنصوص؛ قيمنا أعداد عشرية صغيرة، لذا تُحوَّل إلى أرقام (1700 = نوع NUMERIC).
types.setTypeParser(1700, (v) => (v === null ? null : parseFloat(v)));
// معرّفات BIGINT تتسع بسهولة في رقم JavaScript في هذا المشروع، لذا تُحوَّل إلى رقم (20 = نوع BIGINT).
types.setTypeParser(20, (v) => (v === null ? null : parseInt(v, 10)));

// حتى 10 اتصالات متزامنة، ومهلة 5 ثوانٍ لفتح اتصال جديد.
const pool = new Pool({ connectionString: config.databaseUrl, max: 10, connectionTimeoutMillis: 5000 });
// خطأ في اتصال خامل داخل المجمّع: يُسجَّل فقط حتى لا يتوقف الخادم.
pool.on('error', (err) => logger.error({ err }, 'unexpected PostgreSQL client error'));

// تنفيذ استعلام واحد باستخدام أي اتصال متاح من المجمّع.
const query = (text, params) => pool.query(text, params);

/**
 * تشغيل `fn(client)` داخل BEGIN/COMMIT، مع ROLLBACK عند أي خطأ.
 * يُستخدم حين يجب أن تنجح عدة عمليات معًا أو لا تحدث إطلاقًا (مثل تغيير حالة الأمان وتسجيل أحداثها).
 */
async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    // التراجع عن كل ما حدث في المعاملة؛ ويُتجاهل خطأ التراجع نفسه حتى يظهر الخطأ الأصلي.
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    // إعادة الاتصال إلى المجمّع دائمًا، نجحت المعاملة أم فشلت.
    client.release();
  }
}

module.exports = { pool, query, tx };
