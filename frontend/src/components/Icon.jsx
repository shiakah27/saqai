/**
 * Icon.jsx — مجموعة أيقونات خطية صغيرة (شبكة 24×24، بلون currentColor) حتى تتبع الأيقونات ألوان المظهر.
 * تُستخدم في كل مكان: القوائم، البطاقات، الأحداث. لا تستخدم بيانات.
 */
// مسار SVG لكل اسم أيقونة.
const PATHS = {
  drop: 'M12 3.5c3.2 4 5.5 7.1 5.5 10a5.5 5.5 0 0 1-11 0c0-2.9 2.3-6 5.5-10Z',
  rain: 'M7 15.5a4 4 0 0 1-.4-8A5.5 5.5 0 0 1 17 8a3.8 3.8 0 0 1 .2 7.5M8 18.5l-1 2M12 18l-1 2.5M16 18.5l-1 2',
  sun: 'M12 7.5a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9ZM12 2.5v2M12 19.5v2M4.6 4.6 6 6M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4',
  thermo: 'M10 13.6V5a2 2 0 1 1 4 0v8.6a4 4 0 1 1-4 0ZM12 10v6',
  gauge: 'M4 15a8 8 0 1 1 16 0M12 15l3.5-4.5M7 15h0.01M17 15h0.01',
  humidity: 'M12 3.5c3.2 4 5.5 7.1 5.5 10a5.5 5.5 0 0 1-11 0c0-2.9 2.3-6 5.5-10ZM9.5 14.5h5',
  pump: 'M4 17h16M6 17V9h8v8M14 11h3a2 2 0 0 1 2 2v4M8 9V6h4v3',
  valve: 'M3 12h5M16 12h5M8 8v8l8-8v8M12 12V6M9.5 6h5',
  leaf: 'M5 19c0-8 5-13 14-14-1 9-6 14-14 14ZM5 19l7-7',
  clock: 'M12 4a8 8 0 1 1 0 16 8 8 0 0 1 0-16ZM12 8v4.5l3 1.8',
  chip: 'M7 7h10v10H7zM10 3.5v3.5M14 3.5v3.5M10 17v3.5M14 17v3.5M3.5 10H7M3.5 14H7M17 10h3.5M17 14h3.5',
  list: 'M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01',
  grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  chart: 'M4 19h16M7 16v-5M11.5 16V7M16 16v-8',
  play: 'M8 5.5v13l10.5-6.5L8 5.5Z',
  pause: 'M8 5.5v13M16 5.5v13',
  restart: 'M5 12a7 7 0 1 0 2.1-5M5 4.5v3.5h3.5',
  wifi: 'M5 10a10 10 0 0 1 14 0M8 13.2a5.5 5.5 0 0 1 8 0M12 17h.01',
  wifiOff: 'M5 10a10 10 0 0 1 14 0M8 13.2a5.5 5.5 0 0 1 8 0M12 17h.01M4 4l16 16',
  shield: 'M12 3.5 19 6v5.5c0 4.4-3 7.9-7 9-4-1.1-7-4.6-7-9V6l7-2.5ZM9 12l2 2 4-4',
  info: 'M12 4a8 8 0 1 1 0 16 8 8 0 0 1 0-16ZM12 11v5M12 8h.01',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  target: 'M12 5a7 7 0 1 1 0 14 7 7 0 0 1 0-14ZM12 9.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5Z',
  terminal: 'M4 5h16v14H4zM7.5 9.5l3 2.5-3 2.5M12.5 15h4',
  moon: 'M19.5 14.6A7.5 7.5 0 0 1 9.4 4.5a7.5 7.5 0 1 0 10.1 10.1Z',
  contrast: 'M12 4a8 8 0 1 1 0 16 8 8 0 0 1 0-16ZM12 4v16M12 8h4M12 12h6M12 16h4',
  timeline: 'M4 7h9M4 12h16M4 17h6M15 5v4M18 10v4M12 15v4',
};

// المكوّن: يرسم الأيقونة بالاسم name. أيقونة play فقط مملوءة.
// بدون title تكون زخرفية (aria-hidden)؛ مع title تصبح صورة لها وصف لقارئ الشاشة.
export default function Icon({ name, size = 18, className = '', title }) {
  const filled = name === 'play';
  return (
    <svg
      className={`icon ${className}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title ? undefined : 'true'}
      role={title ? 'img' : undefined}
    >
      {title && <title>{title}</title>}
      <path d={PATHS[name]} />
    </svg>
  );
}
