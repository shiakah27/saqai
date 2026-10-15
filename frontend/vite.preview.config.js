// ملف إعداد Vite لنسخة المعاينة فقط (لا يُستخدم للوحة الحقيقية).
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';

// بناء المعاينة: ملف HTML واحد مكتفٍ بذاته (الخطوط والكود مدمجة داخله) يعيد تشغيل بيانات مسجّلة.
//   npm run build:preview   →  dist-preview/index.html
// - viteSingleFile يدمج كل الملفات في index.html واحد.
// - define يضبط المتغير VITE_PREVIEW على '1' فتعمل اللوحة بوضع المعاينة (src/preview/).
// - assetsInlineLimit كبير جدًا حتى تُدمج كل الخطوط والصور بدل أن تبقى ملفات منفصلة.
export default defineConfig({
  plugins: [react(), viteSingleFile()],
  base: './',
  define: { 'import.meta.env.VITE_PREVIEW': JSON.stringify('1') },
  build: { outDir: 'dist-preview', assetsInlineLimit: 100000000, chunkSizeWarningLimit: 5000 },
});
