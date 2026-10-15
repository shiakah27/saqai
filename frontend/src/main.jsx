/**
 * main.jsx — نقطة الدخول للوحة التحكم.
 * يُحمّل الخطوط وملف التنسيق styles.css، ثم يرسم المكوّن الرئيسي App داخل العنصر #root في index.html.
 * لا يستخدم أي بيانات بنفسه؛ جلب البيانات يتم داخل App عبر الـhook المسمّى useDashboard.
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
// الخطوط مضمّنة مع التطبيق، فيظهر التصميم نفسه حتى بدون إنترنت (مثل شبكة الهاتف في المعرض).
// Alexandria للعناوين، IBM Plex Sans Arabic للنصوص، IBM Plex Mono للأرقام والرموز التقنية.
import '@fontsource/alexandria/arabic-500.css';
import '@fontsource/alexandria/arabic-600.css';
import '@fontsource/alexandria/arabic-700.css';
import '@fontsource/alexandria/latin-500.css';
import '@fontsource/alexandria/latin-600.css';
import '@fontsource/alexandria/latin-700.css';
import '@fontsource/ibm-plex-sans-arabic/arabic-400.css';
import '@fontsource/ibm-plex-sans-arabic/arabic-500.css';
import '@fontsource/ibm-plex-sans-arabic/arabic-600.css';
import '@fontsource/ibm-plex-sans-arabic/latin-400.css';
import '@fontsource/ibm-plex-sans-arabic/latin-500.css';
import '@fontsource/ibm-plex-sans-arabic/latin-600.css';
import '@fontsource/ibm-plex-mono/latin-500.css';
import './styles.css';
import './refined.css';   // طبقة التصميم المصقول (إكسبو مطوّر) فوق styles.css

// إنشاء جذر React ورسم التطبيق. StrictMode يكشف أخطاء شائعة أثناء التطوير فقط.
createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
