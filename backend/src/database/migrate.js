/**
 * أداة ترحيل قاعدة البيانات (migrations).
 * تطبّق ملفات database/migrations/*.sql بالترتيب (كل ملف مرة واحدة فقط)، ثم ملفات database/seeds/*.sql.
 *   npm run db:migrate
 * يستدعيها server.js تلقائيًا عند بدء التشغيل، ويمكن تشغيلها يدويًا من سطر الأوامر.
 */
const fs = require('fs');
const path = require('path');
const { pool } = require('./pool');

// مجلد database في جذر المشروع (خارج مجلد backend).
const ROOT = path.resolve(__dirname, '../../../database');

/**
 * تنفيذ الترحيلات غير المطبقة ثم ملفات البيانات الأولية (seeds).
 * جدول schema_migrations يحفظ أسماء الملفات المطبقة حتى لا يُعاد تطبيق أي ملف.
 */
async function migrate({ log = console.log } = {}) {
  const client = await pool.connect();
  try {
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
    const done = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    // قاعدة بيانات أُنشئت بالإصدار الأول (محطة طقس + عقدة ري) طُبّق فيها 001_init.sql لكن دون جداول v2.
    // يُوضَّح ذلك برسالة صريحة بدل الفشل لاحقًا بخطأ "relation does not exist".
    if (done.has('001_init.sql') && !(await client.query("SELECT to_regclass('public.irrigation_runs') AS t")).rows[0].t) {
      throw new Error('This database has the OLD schema (v1). Reset it once: docker compose down -v && docker compose up -d  (deletes old readings), then start again.');
    }
    // كل ملف ترحيل يُطبَّق داخل معاملة مع تسجيل اسمه، فإما أن يُطبَّق كاملًا ويُسجَّل أو لا شيء.
    for (const file of fs.readdirSync(path.join(ROOT, 'migrations')).filter((f) => f.endsWith('.sql')).sort()) {
      if (done.has(file)) continue;
      await client.query('BEGIN');
      await client.query(fs.readFileSync(path.join(ROOT, 'migrations', file), 'utf8'));
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      log(`applied ${file}`);
    }
    // ملفات seeds تُنفَّذ في كل تشغيل؛ هي آمنة للتكرار لأنها تستخدم ON CONFLICT DO NOTHING.
    for (const file of fs.readdirSync(path.join(ROOT, 'seeds')).filter((f) => f.endsWith('.sql')).sort()) {
      await client.query(fs.readFileSync(path.join(ROOT, 'seeds', file), 'utf8'));
      log(`seeded ${file}`);
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// عند تشغيل الملف مباشرة (npm run db:migrate): نفّذ الترحيل ثم أغلق الاتصالات، أو اخرج برمز خطأ.
if (require.main === module) {
  migrate().then(() => pool.end()).catch((err) => { console.error(err.message); process.exit(1); });
}

module.exports = { migrate };
