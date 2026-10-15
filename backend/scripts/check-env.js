/**
 * فحص المرحلة 1: هل إصدار Node والحزم المطلوبة ومتغيرات البيئة سليمة؟
 * التشغيل:  npm run check:env
 * يطبع ✔ لكل فحص ناجح و ✘ لكل فحص فاشل، وينتهي برمز خروج 1 إن فشل أي فحص.
 */
require('dotenv').config();

const ok = (m) => console.log(`  ✔ ${m}`);
const bad = (m) => { console.log(`  ✘ ${m}`); process.exitCode = 1; };

console.log('SAQAI backend environment check\n');

// الـ backend يحتاج Node.js 20 أو أحدث (يستخدم fetch و AbortSignal.timeout المدمجين).
const major = Number(process.versions.node.split('.')[0]);
major >= 20 ? ok(`Node.js ${process.versions.node}`) : bad(`Node.js ${process.versions.node} (need >= 20)`);

// التأكد من تثبيت الحزم الأساسية (npm install).
for (const pkg of ['express', 'pg', 'zod', 'pino', 'helmet', 'cors', 'dotenv']) {
  try { require.resolve(pkg); ok(`package "${pkg}" installed`); }
  catch { bad(`package "${pkg}" missing — run: npm install`); }
}

// متغيرات البيئة الإلزامية.
for (const v of ['DATABASE_URL', 'PORT', 'DEVICE_API_KEY']) {
  process.env[v] ? ok(`env ${v} is set`) : bad(`env ${v} is NOT set — copy .env.example to backend/.env`);
}

// المفتاح ما زال بالقيمة المثال من .env.example: غير آمن.
if (process.env.DEVICE_API_KEY === 'replace_with_a_long_random_string') {
  bad('DEVICE_API_KEY still has the placeholder value — change it');
}

console.log(process.exitCode ? '\nSome checks failed.' : '\nAll backend checks passed.');
