// ملف إعداد Vite لبناء لوحة التحكم الحقيقية (npm run build → مجلد dist).
// تُفعَّل إضافة React لتحويل ملفات JSX.
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// القيمة base: './' تجعل مسارات الملفات المبنية نسبية، فتعمل اللوحة من أي مجلد يقدّمها منه الخادم.
// أثناء التطوير (npm run dev) تُمرَّر طلبات /api إلى خادم Node (المنفذ 3000)،
// فلا يصطدم المتصفح بقيود CORS لأن الطلبات تبدو صادرة من نفس العنوان.
export default defineConfig({
  plugins: [react()],
  base: './',
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:3000' },
  },
});
