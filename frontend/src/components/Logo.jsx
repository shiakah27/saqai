/**
 * Logo.jsx — شعار سَقاي (SAQAI) في الشريط العلوي وشاشة التحميل.
 * الرمز: برعم بكسلي ينمو من قطرة مقسّمة إلى مناطق ري، مع نقطة حساس في كل منطقة.
 * مرسوم من تصميم شعار الفريق، خلية بخلية. لا يستخدم بيانات.
 */
// شبكة الشعار: كل حرف لون، والنقطة "." خلية فارغة.
const GRID = [
  '.......aa..',
  '..bb..aaa..',
  '...bbca....',
  '.....c.....',
  '.....c.....',
  '.....d.....',
  '....edd....',
  '...fffff...',
  '..fffffff..',
  '.bbbb.cccc.',
  '.bgbb.ccgc.',
  '...........',
  'hhhhh.iigii',
  '.hghh.iiii.',
  '...hh.ii...',
];
// لون كل حرف في الشبكة (درجات الأخضر والفيروزي).
const COLORS = {
  a: '#86efac', b: '#4ade80', c: '#22c55e', d: '#5eead4', e: '#ccfbf1',
  f: '#2dd4bf', g: '#ecfdf5', h: '#16a34a', i: '#15803d',
};
// تحويل الشبكة إلى قائمة مربعات { x, y, fill } مرة واحدة فقط.
const CELLS = GRID.flatMap((row, y) => [...row].map((k, x) => (k === '.' ? null : { x, y, fill: COLORS[k] }))).filter(Boolean);

// الرمز وحده: مربع SVG لكل خلية. crispEdges يُبقي حواف البكسلات حادة.
export function LogoMark({ size = 32 }) {
  return (
    <svg viewBox="0 0 11 15" width={(size * 11) / 15} height={size} aria-hidden="true" className="logo-mark" shapeRendering="crispEdges">
      {CELLS.map((c) => <rect key={`${c.x}-${c.y}`} x={c.x} y={c.y} width="1.02" height="1.02" fill={c.fill} />)}
    </svg>
  );
}

/** الرمز + الاسم مكتوبًا، بنفس ترتيب التصميم الأصلي (من اليسار لليمين دائمًا مهما كان اتجاه الصفحة). */
export default function Logo({ size = 34, wordmark = true }) {
  return (
    <span className="lockup" dir="ltr">
      <LogoMark size={size} />
      {wordmark && (
        <span className="lockup-words">
          <b className="lockup-en">SAQAI</b>
          <b className="lockup-ar" lang="ar">سَقاي</b>
        </span>
      )}
    </span>
  );
}
