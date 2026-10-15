/**
 * فحص المرحلة 1: هل يستطيع الـ backend الوصول إلى PostgreSQL؟
 * التشغيل:  npm run check:db
 * يتصل مباشرة (دون الـ pool الخاص بالتطبيق) ويطبع إصدار PostgreSQL ووقت الخادم ومنطقته الزمنية،
 * مع نصائح الإصلاح عند الفشل.
 */
require('dotenv').config();
const { Client } = require('pg');

(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('✘ DATABASE_URL is not set. Copy .env.example to backend/.env');
    process.exit(1);
  }

  const client = new Client({ connectionString: url, connectionTimeoutMillis: 5000 });
  try {
    await client.connect();
    const { rows } = await client.query(
      "SELECT version() AS version, now() AS server_time, current_setting('TimeZone') AS tz"
    );
    console.log('✔ Connected to PostgreSQL');
    console.log('  version    :', rows[0].version.split(',')[0]);
    console.log('  server time:', rows[0].server_time.toISOString());
    // المنطقة الزمنية المتوقعة UTC (كل الأوقات تُحفظ بتوقيت UTC).
    console.log('  timezone   :', rows[0].tz, rows[0].tz === 'UTC' ? '(good)' : '(expected UTC)');
  } catch (err) {
    console.error('✘ Could not connect to PostgreSQL:', err.message);
    console.error('  Is the container running?  docker compose ps');
    console.error('  Do user/password/port in DATABASE_URL match .env?');
    process.exitCode = 1;
  } finally {
    await client.end().catch(() => {});
  }
})();
