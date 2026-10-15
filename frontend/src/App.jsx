/**
 * App.jsx — المكوّن الرئيسي (هيكل اللوحة كلها).
 * يرسم الشريط العلوي (الشعار، روابط الصفحات، نقاط حالة الأجهزة، وضع النظام، زر المظهر)،
 * ثم الصفحة الحالية حسب الرابط، ثم الشريط السفلي (dock) الذي يظهر على الجوال.
 * البيانات: يستدعي useDashboard مرة واحدة (status + history)، ويحسب منها ما تحتاجه الصفحات
 * (ألوان المناطق، تقدّم الري، ري اليوم) ويمررها لها كـprops.
 */
import { useEffect, useState } from 'react';
import { useDashboard } from './hooks/useDashboard';
import { useTokens } from './hooks/useTokens';
import { useRunProgress } from './hooks/useRunProgress';
import Icon from './components/Icon';
import Logo, { LogoMark } from './components/Logo';
import Maintenance from './components/Maintenance';
import Overview from './pages/Overview';
import Zones from './pages/Zones';
import Decision from './pages/Decision';
import Weather from './pages/Weather';
import Runs from './pages/Runs';
import Events from './pages/Events';
import Story from './pages/Story';
import { MODES } from './i18n/ar';
import { PAGES, href, useRoute } from './lib/router';
import { todayByZone } from './lib/zones';

// أسماء الأجهزة كما تظهر للمستخدم: عقدة الحساسات وعقدة التشغيل (التي تقرر الري وتشغّل المضخة).
const DEVICE_NAMES = { sensor: 'عقدة الحساسات', actuator: 'عقدة التشغيل' };

// hook للمظهر: 'auto' (يتبع النظام) أو 'light' أو 'dark'.
// يحفظ الاختيار في localStorage، ويضع السمة data-theme على عنصر html فتطبّق CSS الألوان المناسبة.
// try/catch لأن التخزين قد يكون غير متاح (وضع التصفح الخاص مثلًا).
function useTheme() {
  const [theme, setTheme] = useState(() => { try { return localStorage.getItem('saqai-theme') || 'auto'; } catch { return 'auto'; } });
  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'auto') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', theme);
    try { localStorage.setItem('saqai-theme', theme); } catch { /* التخزين غير متاح */ }
  }, [theme]);
  return [theme, setTheme];
}

// قائمة روابط الصفحات؛ تُستخدم مرتين: في الشريط العلوي (toplinks) وفي الشريط السفلي للجوال (docklinks).
function Links({ page, className }) {
  return (
    <ul className={className}>
      {PAGES.filter((p) => !p.hidden).map((p) => (
        <li key={p.id}>
          <a href={href(p.id)} className={page === p.id ? 'is-active' : ''} aria-current={page === p.id ? 'page' : undefined}>
            <Icon name={p.icon} size={18} />
            <span>{p.label}</span>
          </a>
        </li>
      ))}
    </ul>
  );
}

// الشريط العلوي: الشعار، الروابط، نقاط الأجهزة (نقطة لكل جهاز + الخادم)، شارة وضع النظام، وزر المظهر.
// زر المظهر يدور: تلقائي ← فاتح ← داكن ← تلقائي.
function Topbar({ page, status, error, streaming, theme, setTheme }) {
  const mode = MODES[status.system.mode] || MODES.ERROR;
  const next = { auto: 'light', light: 'dark', dark: 'auto' }[theme];
  const themeLabel = { auto: 'المظهر: تلقائي', light: 'المظهر: فاتح', dark: 'المظهر: داكن' }[theme];
  const devices = [...(status.devices || []).map((d) => ({ name: DEVICE_NAMES[d.kind], ok: d.online })),
    { name: 'الخادم', ok: !error }];
  const offline = devices.filter((d) => !d.ok);
  return (
    <header className="topbar">
      <div className="topbar-in">
        <a className="brand" href={href('overview')} aria-label="سَقاي، الصفحة الرئيسية">
          <Logo size={34} />
        </a>
        <nav aria-label="الصفحات"><Links page={page} className="toplinks" /></nav>
        <div className="topbar-side">
          {/* الأجهزة: لا يظهر شيء ما دام كل شيء متصلًا؛ وإذا انقطع جهاز تظهر شارة حمراء باسمه */}
          {offline.length > 0 && <span className="dev-alert" role="status">انقطع الاتصال: {offline[0].name}</span>}
          <span className={`mode mode-${status.system.mode}`} title={mode.desc}><span className="mode-dot" aria-hidden="true" />{mode.label}</span>
          <button type="button" className="icon-btn" onClick={() => setTheme(next)} aria-label={themeLabel} title={themeLabel}>
            <Icon name={theme === 'dark' ? 'moon' : theme === 'light' ? 'sun' : 'contrast'} size={17} />
          </button>
        </div>
      </div>
    </header>
  );
}

// شريط تحذير يظهر فقط عند انقطاع الخادم، ويعرض كم ثانية مضت منذ آخر تحديث ناجح (يتحدث كل ثانية).
function Offline({ error, lastOkAt }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, []);
  if (!error) return null;
  return (
    <p className="offline" role="status">
      <Icon name="wifiOff" size={16} /> انقطع الاتصال بالخادم. آخر تحديث قبل <span className="num">{Math.round((now - lastOkAt) / 1000)}</span> ث.
    </p>
  );
}

// المكوّن الرئيسي: يجمع البيانات والمظهر والمسار ثم يرسم الصفحة المناسبة.
export default function App() {
  const { snapshot, error, lastOkAt, refresh, streaming } = useDashboard();
  const c = useTokens();
  const { page, arg } = useRoute();
  const [theme, setTheme] = useTheme();
  const progress = useRunProgress(snapshot?.status);

  // قبل وصول أول لقطة: شاشة تحميل، أو رسالة إرشادية إن تعذّر الوصول للخادم.
  if (!snapshot) {
    return (
      <div className="loading" role="status">
        <LogoMark size={64} />
        {error ? (
          <>
            <p><b>لا يمكن الوصول إلى خادم سَقاي.</b></p>
            <p>شغّلوا الـBackend (<span dir="ltr">start.bat</span>)، وافتحوا العنوان الذي يطبعه عند التشغيل.</p>
            <p className="loading-err" dir="ltr">{error}</p>
          </>
        ) : <p>جارٍ الاتصال بالخادم…</p>}
      </div>
    );
  }

  // بيانات مشتركة لكل الصفحات: ألوان المناطق، معلومات الصفحة الحالية، وملخص ري اليوم لكل منطقة.
  const { status, history } = snapshot;
  const colors = { 1: c.z1, 2: c.z2, 3: c.z3 };
  const meta = PAGES.find((p) => p.id === page);
  const today = todayByZone(history.runs, status.config?.pump_flow_lpm);
  const props = { status, history, colors, progress, today, arg };

  // الصفحة تُختار حسب page؛ key={page} يعيد إنشاء الحاوية عند كل انتقال (لتشغيل حركة الدخول).
  // صفحة الصيانة تأخذ refresh لتحديث البيانات بعد أي أمر إداري.
  // صفحة "الفكرة": تملأ الشاشة بدون الشريط العلوي، مع شعار وزر صغير للعودة للوحة
  if (page === 'story') {
    return (
      <div className="app app-story">
        <header className="st-top">
          <a href={href('overview')} aria-label="سَقاي، لوحة التحكم"><Logo size={30} /></a>
          <a className="st-top-link" href={href('overview')}>لوحة التحكم</a>
        </header>
        <h1 className="sr-only">{meta.title}</h1>
        <Story status={status} colors={colors} />
      </div>
    );
  }

  return (
    <div className={`app mode-${status.system.mode}`}>
      <Topbar page={page} status={status} error={error} streaming={streaming} theme={theme} setTheme={setTheme} />
      <main className="main" id="main">
        <h1 className="sr-only">{meta.title}</h1>
        <Offline error={error} lastOkAt={lastOkAt} />
        <div className="page" key={page}>
          {page === 'overview' && <Overview {...props} />}
          {page === 'zones' && <Zones {...props} />}
          {page === 'decision' && <Decision {...props} />}
          {page === 'weather' && <Weather {...props} />}
          {page === 'runs' && <Runs {...props} />}
          {page === 'events' && <Events {...props} />}
          {page === 'maintenance' && <Maintenance status={status} onChange={refresh} />}
        </div>
      </main>
      <nav className="dock" aria-label="الصفحات"><Links page={page} className="docklinks" /></nav>
    </div>
  );
}
