/**
 * FieldMap.jsx — مجسّم المزرعة (رسم SVG واحد) بأسلوب المخططات المعمارية متساوية القياس (isometric).
 * ----------------------------------------------------------------------------
 * منصة لها سُمك ظاهر، عليها ثلاثة أحواض مرتفعة (مناطق الري) بمقطع جانبي يُظهر طبقات التربة،
 * وممر أمامي فيه الأنبوب الرئيسي والصمامات، وركن خدمات (الخزان، وحدة التحكم، المضخة)، ومحطة الطقس خلف الأحواض.
 * الأسلوب: ألوان هادئة، إضاءة ناعمة من أعلى اليسار، خطوط حواف رفيعة، وظلال ضبابية؛ واللون القوي فقط لما يتغير مع البيانات.
 * كل شيء حي:
 *   لون تربة الحوض (السطح والمقطع) ← رطوبة تربته (رمل فاتح جاف → تربة داكنة رطبة)
 *   حلقة الصمام المضيئة والماء المتحرك والرش ← الصمام الوحيد المفتوح
 *   خطوط المطر                               ← وضع RAIN_LOCKOUT
 *   البطاقات ذات الخطوط المنقطة (callouts)    ← عنوان قصير وسطر شرح لكل جزء، ويتغير مع الحالة
 * البيانات (props): mode، zones (من status.zones)، colors، states (من zoneState)، onPick (عند الضغط على منطقة)،
 *                    callouts (true لإظهار البطاقات التوضيحية).
 *
 * طريقة الرسم: كل نقطة في "العالم" لها إحداثيات بالمتر تقريبًا (X طولًا، Y عمقًا نحو المشاهد، Z ارتفاعًا)،
 * والدالة iso تحولها إلى نقطة على الشاشة بزاوية 30° (الإسقاط متساوي القياس). الألوان في styles.css.
 */
import { useEffect, useState } from 'react';

// أبعاد لوحة الرسم (viewBox)؛ الـSVG يتمدد ليناسب عرض الشاشة مع الحفاظ على النسبة.
export const W = 1200;
export const H = 640;

// الإسقاط متساوي القياس: X يتجه يمينًا ونازلًا، Y (نحو المشاهد) يسارًا ونازلًا، Z للأعلى. U = بكسل لكل متر.
const U = 35;
const OX = 471;
const OY = 146;
const C = 0.866;   // cos 30°
const iso = (X, Y, Z = 0) => [OX + U * C * (X - Y), OY + U * 0.5 * (X + Y) - U * Z];
const f1 = (n) => n.toFixed(1);
const pts = (list) => list.map((p) => iso(...p).map(f1).join(',')).join(' ');
const path = (list) => `M${list.map((p) => iso(...p).map(f1).join(' ')).join(' L')}`;
// box: الأوجه الثلاثة الظاهرة لصندوق: العلوي، والأيسر (الوجه الأمامي عند Y الأكبر)، والأيمن (عند X الأكبر).
const box = (x0, x1, y0, y1, z0, z1) => ({
  top: pts([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]]),
  left: pts([[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]]),
  right: pts([[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]]),
});

// المخطط: المنصة، ثم الأحواض الثلاثة (المنطقة 1 على اليمين حتى يُقرأ المجسّم من اليمين لليسار مثل الصفحة العربية).
const BASE = { x0: 0, x1: 17.2, y0: 0, y1: 8.6, t: 0.5 };
const BED = { y0: 0.7, y1: 5.3, h: 0.55 };
export const PLOTS = [
  { id: 3, x: [3.7, 7.6], kind: 'desert' },
  { id: 2, x: [8.4, 12.3], kind: 'garden' },
  { id: 1, x: [13.1, 17.0], kind: 'grove' },
];
const mid = (p) => (p.x[0] + p.x[1]) / 2;
const PIPE_Y = 6.15;          // الأنبوب الرئيسي على الممر الأمامي
const WIRE_Y = 6.85;          // سلك التحكم بمحاذاة الأنبوب
const STATION = [12.7, 0.3];  // محطة الطقس خلف الأحواض بين المنطقة 2 و 1
const TANK = [1.5, 1.7];      // ركن الخدمات على يسار المنصة
const CTRL = [0.9, 4.0];
const PUMP = [1.6, PIPE_Y];
const probeX = (p) => p.x[1] - 0.7;

// نقاط مهمة كنسبة من عرض/ارتفاع الرسم، تستخدمها صفحة "الفكرة" لتوجيه الكاميرا والحلقات.
const frac = ([x, y]) => [+(x / W).toFixed(3), +(y / H).toFixed(3)];
export const ANCHORS = {
  zones: PLOTS.map((p) => frac(iso(mid(p), (BED.y0 + BED.y1) / 2, BED.h + 0.8))),
  station: frac(iso(STATION[0], STATION[1], 2.6)),
  control: frac(iso(CTRL[0] + 0.45, CTRL[1] + 0.3, 0.8)),
};

// على الشاشات الصغيرة تُخفى البطاقات التوضيحية، فنقص الهوامش الفارغة حول المجسّم ليظهر أكبر (CROP = حدود المجسّم نفسه).
export const CROP = [190, 56, 820, 574];
function useNarrow() {
  const q = '(max-width: 900px)';
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.matchMedia(q).matches);
  useEffect(() => {
    const m = window.matchMedia(q);
    const on = () => setNarrow(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return narrow;
}

// توزيع عشوائي ثابت (مولّد أرقام بذرة seed)، فلا تقفز النباتات من مكانها بين كل رسم وآخر.
function rand(seed) {
  let s = seed;
  return () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
}

// ---- الأشكال القائمة: كل شكل يُرسم عند نقطة قاعدته (x,y) على الشاشة. الظل ضبابي ومائل لليمين (الضوء من اليسار) ----
// شجرة: جذع رفيع وتاج من عدة كرات متداخلة بتدرج ضوئي (فاتح أعلى اليسار، داكن أسفل اليمين).
function Tree({ x, y, k = 1, seed = 1 }) {
  const r = 0.62 * U * k;
  const cy = y - 1.6 * U * k;
  const rr = rand(seed);
  const blobs = [[0, 0, 1], [-0.55, 0.25, 0.72], [0.55, 0.3, 0.7], [0.05, -0.5, 0.68]].map(([dx, dy, s]) => [dx + (rr() - 0.5) * 0.15, dy + (rr() - 0.5) * 0.15, s]);
  return (
    <g>
      <ellipse cx={x + r * 0.9} cy={y + 1} rx={r * 1.3} ry={r * 0.55} className="m-shadow" filter="url(#m-blur)" />
      <path d={`M${f1(x)} ${f1(y)} L${f1(x)} ${f1(cy + r * 0.3)} M${f1(x)} ${f1(cy + r * 0.9)} l${f1(r * 0.35)} ${f1(-r * 0.4)}`} className="m-trunk" />
      {blobs.sort((a, b) => a[1] - b[1]).map(([dx, dy, s]) => (
        <circle key={`${dx}${dy}`} cx={f1(x + dx * r)} cy={f1(cy + dy * r)} r={f1(r * s)} fill="url(#m-canopy)" className="m-canopy" />
      ))}
    </g>
  );
}
// شجيرة مستديرة بتدرج ضوئي، ويمكن أن تحمل أزهارًا صغيرة (flower = 1 أو 2).
function Shrub({ x, y, k = 1, flower }) {
  const r = 0.36 * U * k;
  const cy = y - r * 0.85;
  return (
    <g>
      <ellipse cx={x + r * 0.7} cy={y + 0.5} rx={r * 1.2} ry={r * 0.5} className="m-shadow" filter="url(#m-blur)" />
      <circle cx={f1(x - r * 0.45)} cy={f1(cy + r * 0.15)} r={f1(r * 0.7)} fill="url(#m-shrub)" />
      <circle cx={f1(x + r * 0.4)} cy={f1(cy + r * 0.2)} r={f1(r * 0.68)} fill="url(#m-shrub)" />
      <circle cx={f1(x)} cy={f1(cy - r * 0.15)} r={f1(r * 0.78)} fill="url(#m-shrub)" />
      {flower ? [[-0.5, -0.1], [0.25, -0.55], [0.05, 0.2], [0.55, 0.05], [-0.2, -0.45]].map(([a, b]) => (
        <circle key={`${a}${b}`} cx={f1(x + a * r)} cy={f1(cy + b * r)} r={f1(Math.max(1.4, r * 0.1))} className={`m-flower f${flower}`} />
      )) : null}
    </g>
  );
}
// نبتة الأغاف: أوراق مدببة رفيعة بتدرج.
function Agave({ x, y, k = 1 }) {
  const s = 0.042 * U * k;
  return (
    <g transform={`translate(${f1(x)} ${f1(y)}) scale(${s.toFixed(3)})`}>
      <ellipse cx="8" cy="1" rx="15" ry="5" className="m-shadow" filter="url(#m-blur)" />
      {[-70, -45, -22, 0, 22, 45, 70].map((a) => <path key={a} d="M0 0 C-3 -8 -2.4 -16 0 -23 C2.4 -16 3 -8 0 0Z" transform={`rotate(${a})`} fill="url(#m-agave)" />)}
    </g>
  );
}
// صبار عمودي بذراعين، بتدرج يوحي بالاستدارة.
function Cactus({ x, y, k = 1 }) {
  const s = 0.042 * U * k;
  return (
    <g transform={`translate(${f1(x)} ${f1(y)}) scale(${s.toFixed(3)})`}>
      <ellipse cx="9" cy="1" rx="12" ry="4" className="m-shadow" filter="url(#m-blur)" />
      <path d="M-4 -12 H-9 Q-11 -12 -11 -14 V-22 Q-11 -25 -8.5 -25 Q-6 -25 -6 -22 V-17 H-4Z" fill="url(#m-cactus)" />
      <path d="M4 -17 H8 Q10 -17 10 -19 V-26 Q10 -29 7.5 -29 Q5 -29 5 -26 V-21 H4Z" fill="url(#m-cactus)" />
      <rect x="-4.5" y="-34" width="9" height="35" rx="4.5" fill="url(#m-cactus)" />
    </g>
  );
}
// شخص (ظل إنساني رفيع) للدلالة على الحجم، كما في المخططات المعمارية.
function Person({ x, y, flip, pose = 0 }) {
  const s = (U * 1.7) / 34;   // طول الشخص ≈ 1.7 متر
  const legs = pose ? 'M-1.6 -12.5 L-3.2 0 H-1.6 L0 -9 L1.8 0 H3.4 L1.8 -12.5Z' : 'M-2.6 -12.5 L-2.4 0 H-0.7 L0 -10 L0.7 0 H2.4 L2.6 -12.5Z';
  return (
    <g transform={`translate(${f1(x)} ${f1(y)}) scale(${((flip ? -1 : 1) * s).toFixed(3)} ${s.toFixed(3)})`} className="m-person">
      <ellipse cx="6" cy="0.5" rx="8" ry="2" className="m-shadow" filter="url(#m-blur)" />
      <circle cx="0" cy="-30.8" r="3" />
      <path d="M-3.8 -26.5 Q0 -28.2 3.8 -26.5 L4.4 -12.5 H-4.4Z" />
      <path d={legs} />
    </g>
  );
}

// لون التربة حسب الرطوبة: من 12% (رمل فاتح) إلى 46% (تربة داكنة)، بمزج الألوان color-mix.
const soilTone = (soil) => {
  const t = Math.max(0, Math.min(1, ((soil ?? 15) - 12) / 34));
  return `color-mix(in oklab, #e6d5b2 ${Math.round((1 - t) * 100)}%, #7a5f45)`;
};

// النباتات داخل حوض واحد: مواقع عشوائية ثابتة على شبكة مهزوزة (توزيع متوازن بلا تكدس)، ونوعها حسب kind.
function plantsFor(plot) {
  const r = rand(plot.id * 7919);
  const [cols, rows] = plot.kind === 'grove' ? [3, 3] : plot.kind === 'garden' ? [4, 4] : [4, 4];
  const out = [];
  const w = plot.x[1] - plot.x[0];
  const d = BED.y1 - BED.y0;
  for (let i = 0; i < cols; i += 1) {
    for (let j = 0; j < rows; j += 1) {
      if (plot.kind !== 'grove' && r() < 0.18) { r(); continue; }   // فراغات طبيعية
      // البستان: حافة أعرض قليلًا (m)، والأشجار العالية بعيدة عن الطرف المجاور للمنطقة 2 (شجيرات منخفضة هناك) حتى لا تغطيها
      const m = plot.kind === 'grove' ? 0.45 : 0.25;
      const X = plot.x[0] + m + ((i + 0.5 + (r() - 0.5) * 0.5) / cols) * (w - 2 * m);
      const Y = BED.y0 + m + ((j + 0.5 + (r() - 0.5) * 0.5) / rows) * (d - 2 * m);
      if (X > probeX(plot) - 0.5 && Y > BED.y1 - 0.9) continue;     // اترك مكان الحساس ظاهرًا
      const [x, y] = iso(X, Y, BED.h);
      const t = r();
      const key = `p${plot.id}-${i}-${j}`;
      let el;
      if (plot.kind === 'grove') el = i === 0 || (i === 1 && j === 0) ? <Shrub x={x} y={y} k={1.05 + t * 0.25} /> : <Tree x={x} y={y} k={0.78 + t * 0.2} seed={plot.id * 100 + i * 10 + j} />;
      else if (plot.kind === 'garden') el = <Shrub x={x} y={y} k={0.85 + r() * 0.35} flower={t < 0.45 ? 1 : t < 0.8 ? 2 : 0} />;
      else el = t < 0.6 ? <Agave x={x} y={y} k={0.8 + r() * 0.35} /> : <Cactus x={x} y={y} k={0.8 + r() * 0.35} />;
      out.push({ y, el, key });
    }
  }
  return out;
}

// البطاقة التوضيحية: نقطة على الجزء، خط منقط بزاوية قائمة، ثم عنوان قصير وسطر شرح.
// side = 'left' أو 'right' (جهة النص)، والنص يُحاذى بعيدًا عن الخط.
function Callout({ at, to, side, title, text, live }) {
  const [ax, ay] = at.map((n) => +n.toFixed(1));
  const [lx, ly] = to;
  const end = side === 'right' ? lx - 8 : lx + 8;
  const anchor = side === 'right' ? 'end' : 'start';   // الاتجاه RTL: end = الحافة اليسرى، start = اليمنى
  return (
    <g className={`m-callout ${live ? 'is-live' : ''}`} pointerEvents="none">
      <polyline points={`${ax},${ay} ${ax},${ly} ${end},${ly}`} className="m-leader" />
      <circle cx={ax} cy={ay} r="4.5" className="m-pin-halo" />
      <circle cx={ax} cy={ay} r="2.6" className="m-pin" />
      <text x={lx} y={ly - 3} textAnchor={anchor} className="m-co-title">{title}</text>
      <text x={lx} y={ly + 15} textAnchor={anchor} className="m-co-text">{text}</text>
    </g>
  );
}

// ألوان التدرجات مكتوبة مباشرة في <defs> (خصائص SVG لا تقبل متغيرات CSS بشكل موثوق)؛ باقي الألوان في styles.css.
// المكوّن: raining عند قفل المطر، open = المنطقة التي صمامها مفتوح (واحدة فقط لأن المضخة واحدة).
// ترتيب الرسم من الخلف للأمام: المنصة ← الأحواض ← الأنابيب على الأرض ← الأشياء القائمة مرتبة حسب العمق ← البطاقات ← المطر.
export default function FieldMap({ mode, zones = [], colors = {}, states = {}, onPick, callouts = false }) {
  const raining = mode === 'RAIN_LOCKOUT';
  const narrow = useNarrow();
  const viewBox = callouts && narrow ? CROP.join(' ') : `0 0 ${W} ${H}`;   // القص فقط في الصفحة الرئيسية على الشاشات الصغيرة
  const byId = Object.fromEntries(zones.map((z) => [z.id, z]));
  const open = zones.find((z) => z.valve === 'OPEN');
  const openPlot = open && PLOTS.find((p) => p.id === open.id);
  const base = box(BASE.x0, BASE.x1, BASE.y0, BASE.y1, -BASE.t, 0);

  // الأشياء القائمة (نباتات، محطة، أجهزة، أشخاص) تُجمع ثم تُرتب حسب y لترسم الخلفية أولًا.
  const things = PLOTS.flatMap(plantsFor);
  const add = (pt, el, key) => things.push({ y: iso(...pt)[1], el, key });

  // محطة الطقس: صاري، واقي إشعاع بطبقات (فيه حساسات الحرارة والرطوبة والضغط)، لوح شمسي، وحساس المطر على ذراع.
  {
    const [sx, sy] = STATION;
    const b0 = iso(sx, sy, 0); const b1 = iso(sx, sy, 3.0);
    const plate = box(sx + 0.35, sx + 0.95, sy - 0.25, sy + 0.25, 2.05, 2.1);
    const arm = iso(sx + 0.65, sy, 2.1);
    add([sx, sy, 0], (
      <g className="m-station">
        <ellipse cx={b0[0] + 8} cy={b0[1] + 1} rx="16" ry="5" className="m-shadow" filter="url(#m-blur)" />
        <line x1={b0[0]} y1={b0[1]} x2={b1[0]} y2={b1[1] - 4} className="m-mast" />
        <line x1={b0[0]} y1={arm[1] - 4} x2={arm[0]} y2={arm[1]} className="m-mast thin" />
        <polygon points={plate.top} className="m-rainplate" />
        <polygon points={plate.left} className="m-rainplate-side" />
        {[0, 1, 2, 3, 4].map((i) => <ellipse key={i} cx={b1[0]} cy={b1[1] + 2 + i * 4.6} rx="9" ry="2.8" className="m-shield" />)}
        <polygon points={pts([[sx - 0.55, sy, 2.35], [sx - 0.15, sy, 2.35], [sx - 0.15, sy, 2.75], [sx - 0.55, sy, 2.75]])} className="m-solar" />
      </g>
    ), 'station');
  }

  // الخزان: أسطوانة بتدرج يوحي بالاستدارة، ومستوى الماء من نافذة شفافة.
  {
    const [cx, cy] = iso(TANK[0], TANK[1], 0);
    const r = 0.95 * U; const h = 1.6 * U; const ry = r * 0.5;
    add([TANK[0] + 0.9, TANK[1] + 0.9, 0], (
      <g className="m-tank">
        <ellipse cx={cx + r * 0.6} cy={cy + 3} rx={r * 1.3} ry={ry * 1.15} className="m-shadow" filter="url(#m-blur)" />
        <path d={`M${f1(cx - r)} ${f1(cy - h)} V${f1(cy)} A${f1(r)} ${f1(ry)} 0 0 0 ${f1(cx + r)} ${f1(cy)} V${f1(cy - h)}Z`} fill="url(#m-cyl)" className="m-tank-body" />
        <rect x={f1(cx - r * 0.5)} y={f1(cy - h * 0.72)} width={f1(r * 0.18)} height={f1(h * 0.72)} rx="3" className="m-tank-glass" />
        <rect x={f1(cx - r * 0.5)} y={f1(cy - h * 0.42)} width={f1(r * 0.18)} height={f1(h * 0.42)} rx="3" className="m-water" />
        <ellipse cx={cx} cy={cy - h} rx={r} ry={ry} className="m-tank-top" />
        <ellipse cx={cx} cy={cy - h} rx={r * 0.28} ry={ry * 0.28} className="m-tank-cap" />
      </g>
    ), 'tank');
  }

  // وحدة التحكم: خزانة صغيرة فيها لوحة إلكترونية ومؤشر يضيء أثناء الري.
  {
    const [x0, y0] = CTRL;
    const b = box(x0, x0 + 0.9, y0, y0 + 0.55, 0, 1.25);
    const led = iso(x0 + 0.72, y0 + 0.55, 1.06);
    const board = pts([[x0 + 0.14, y0 + 0.55, 0.3], [x0 + 0.58, y0 + 0.55, 0.3], [x0 + 0.58, y0 + 0.55, 0.95], [x0 + 0.14, y0 + 0.55, 0.95]]);
    const [sx, sy] = iso(x0 + 0.45, y0 + 0.3, 0);
    add([x0 + 0.45, y0 + 0.55, 0], (
      <g className={`m-box ${open ? 'is-on' : ''}`}>
        <ellipse cx={sx + 16} cy={sy + 2} rx="26" ry="9" className="m-shadow" filter="url(#m-blur)" />
        <polygon points={b.left} className="m-dev-left" />
        <polygon points={b.right} className="m-dev-right" />
        <polygon points={b.top} className="m-dev-top" />
        <polygon points={board} className="m-board" />
        <circle cx={led[0]} cy={led[1]} r="2.4" className="m-led" />
      </g>
    ), 'ctrl');
  }

  // المضخة: صندوق صغير رمادي مزرق بوجه دائري، والمروحة تدور فقط أثناء الري.
  {
    const [px, py] = PUMP;
    const b = box(px - 0.4, px + 0.4, py - 0.35, py + 0.35, 0, 0.6);
    const [fx, fy] = iso(px, py + 0.35, 0.3);
    add([px, py + 0.35, 0], (
      <g className={`m-pump ${open ? 'is-on' : ''}`}>
        <ellipse cx={fx + 14} cy={fy + 10} rx="20" ry="7" className="m-shadow" filter="url(#m-blur)" />
        <polygon points={b.left} className="m-pump-left" />
        <polygon points={b.right} className="m-pump-right" />
        <polygon points={b.top} className="m-pump-top" />
        <ellipse cx={fx} cy={fy} rx="6.5" ry="7.5" className="m-pump-face" transform={`rotate(-30 ${f1(fx)} ${f1(fy)})`} />
        <g transform={`translate(${f1(fx)} ${f1(fy)})`}>
          <g className={open ? 'spin' : ''}>
            {[0, 120, 240].map((a) => <path key={a} d="M0 -1.2 C2 -2.4 3.6 -4.8 1.2 -6 C-0.5 -5 -1.2 -3 0 -1.2Z" transform={`rotate(${a})`} className="m-blade" />)}
          </g>
        </g>
      </g>
    ), 'pump');
  }

  // حساس رطوبة التربة في مقدمة كل حوض (رأس أبيض بحلقة بلون المنطقة، وقضيبه ظاهر في المقطع)،
  // والصمام على الأنبوب أمام كل حوض (جسم رمادي وحلقة علوية بلون المنطقة تضيء بالأزرق عند الفتح).
  PLOTS.forEach((p) => {
    const X = probeX(p);
    const head = box(X - 0.13, X + 0.13, BED.y1 - 0.26, BED.y1, BED.h, BED.h + 0.42);
    const ring = iso(X, BED.y1 - 0.13, BED.h + 0.42);
    add([X, BED.y1, BED.h], (
      <g className="m-probe" style={{ '--zone': colors[p.id] }}>
        <line {...(([x1, y1], [x2, y2]) => ({ x1, y1, x2, y2 }))(iso(X, BED.y1, BED.h), iso(X, BED.y1, 0.1))} className="m-probe-rod" />
        <polygon points={head.left} className="m-dev-left" />
        <polygon points={head.right} className="m-dev-right" />
        <polygon points={head.top} className="m-dev-top" />
        <ellipse cx={ring[0]} cy={ring[1]} rx="3.4" ry="2" className="m-zone-dot" />
      </g>
    ), `probe${p.id}`);

    const vx = mid(p);
    const isOpen = open?.id === p.id;
    const v = box(vx - 0.3, vx + 0.3, PIPE_Y - 0.3, PIPE_Y + 0.3, 0, 0.42);
    const [wx, wy] = iso(vx, PIPE_Y, 0.42);
    add([vx, PIPE_Y + 0.3, 0], (
      <g className={`m-valve ${isOpen ? 'is-open' : ''}`} style={{ '--zone': colors[p.id] }}>
        <ellipse cx={wx + 12} cy={wy + 18} rx="17" ry="6" className="m-shadow" filter="url(#m-blur)" />
        <polygon points={v.left} className="m-valve-left" />
        <polygon points={v.right} className="m-valve-right" />
        <polygon points={v.top} className="m-valve-top" />
        {isOpen && <ellipse cx={wx} cy={wy} rx="14" ry="8" className="m-valve-glow" />}
        <ellipse cx={wx} cy={wy} rx="7.2" ry="4.1" className="m-valve-ring" />
      </g>
    ), `valve${p.id}`);
  });

  // أشخاص على الممر للدلالة على الحجم. (لا أشجار خارج الأحواض: كل النباتات داخل مناطقها)
  [[5.4, 7.9, false, 0], [5.95, 8.05, true, 1], [13.6, 7.95, true, 1]].forEach(([X, Y, flip, pose], i) => {
    const [x, y] = iso(X, Y, 0);
    add([X, Y, 0], <Person x={x} y={y} flip={flip} pose={pose} />, `person${i}`);
  });

  things.sort((a, b) => a.y - b.y);

  // البطاقات التوضيحية: النص يتغير مع الحالة (مثل: أي صمام مفتوح، أو هل تمطر).
  const notes = callouts ? [
    { key: 'station', at: iso(STATION[0], STATION[1], 3.0), to: [1010, 96], side: 'right', title: 'محطة الطقس', text: 'الحرارة ورطوبة الجو والضغط' },
    { key: 'rain', at: iso(STATION[0] + 0.65, STATION[1], 2.1), to: [1010, 176], side: 'right', title: 'حساس المطر',
      text: raining ? 'يمطر الآن: الري متوقف' : 'يوقف الري فور نزول المطر', live: raining },
    { key: 'probe', at: iso(probeX(PLOTS[2]), BED.y1 - 0.13, BED.h + 0.42), to: [1010, 300], side: 'right', title: 'حساس رطوبة التربة', text: 'واحد في كل منطقة' },
    { key: 'valve', at: iso(mid(PLOTS[1]), PIPE_Y, 0.42), to: [1010, 520], side: 'right', title: 'الصمامات',
      text: open ? `مفتوح الآن: صمام ${open.id}` : 'صمام واحد مفتوح في كل مرة', live: !!open },
    { key: 'tank', at: iso(TANK[0], TANK[1], 1.6), to: [176, 132], side: 'left', title: 'خزان الماء', text: 'مصدر ماء الري' },
    { key: 'ctrl', at: iso(CTRL[0] + 0.45, CTRL[1] + 0.27, 1.25), to: [176, 290], side: 'left', title: 'وحدة التحكم', text: 'تقرر متى تسقي وكم' },
    { key: 'pump', at: iso(PUMP[0], PUMP[1], 0.6), to: [176, 430], side: 'left', title: 'المضخة',
      text: open ? 'تعمل الآن' : 'تدفع الماء للصمامات', live: !!open },
  ] : [];

  return (
    <svg className={`fieldmap model mode-${mode}`} viewBox={viewBox} preserveAspectRatio="xMidYMid meet" role="img"
      aria-label={raining ? 'المزرعة تحت المطر والري متوقف' : open ? `المنطقة ${open.id} تُروى الآن` : 'مجسم المناطق الثلاث ونظام الري'}>
      <defs>
        <filter id="m-blur" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="2.2" /></filter>
        <filter id="m-blur-lg" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="14" /></filter>
        <radialGradient id="m-canopy" cx="0.36" cy="0.3" r="0.75">
          <stop offset="0" stopColor="#d3e3bd" /><stop offset="0.55" stopColor="#a9c48f" /><stop offset="1" stopColor="#7d9c6c" />
        </radialGradient>
        <radialGradient id="m-shrub" cx="0.36" cy="0.3" r="0.75">
          <stop offset="0" stopColor="#dbe8c6" /><stop offset="0.6" stopColor="#b2ca97" /><stop offset="1" stopColor="#88a575" />
        </radialGradient>
        <linearGradient id="m-agave" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#cfdac6" /><stop offset="1" stopColor="#91a991" />
        </linearGradient>
        <linearGradient id="m-cactus" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#bdd2ad" /><stop offset="1" stopColor="#83a27b" />
        </linearGradient>
        <linearGradient id="m-cyl" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#ffffff" /><stop offset="0.45" stopColor="#f2f3ef" /><stop offset="1" stopColor="#d6dbd5" />
        </linearGradient>
        <linearGradient id="m-base-top" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#fcfcf9" /><stop offset="1" stopColor="#eceee8" />
        </linearGradient>
        <pattern id="m-stipple" width="7" height="6" patternUnits="userSpaceOnUse">
          <circle cx="1.5" cy="1.5" r="0.7" className="m-stip" />
          <circle cx="5" cy="4.2" r="0.6" className="m-stip" />
        </pattern>
        <pattern id="m-gravel" width="8" height="6" patternUnits="userSpaceOnUse">
          <rect width="8" height="6" className="m-gravel-bg" />
          <circle cx="2" cy="2" r="1.1" className="m-gravel-dot" />
          <circle cx="6" cy="4.4" r="0.9" className="m-gravel-dot" />
        </pattern>
        <pattern id="rain" width="26" height="40" patternUnits="userSpaceOnUse" patternTransform="rotate(14)">
          <line x1="6" y1="0" x2="6" y2="16" className="rain-line" />
        </pattern>
      </defs>

      {/* ظل المنصة الضبابي على الأرض، ثم المنصة: الجانبان والسطح بخطوط حواف رفيعة */}
      <polygon points={pts([[BASE.x0 + 1, BASE.y1 + 0.2, -BASE.t], [BASE.x1 + 1.4, BASE.y1 + 0.2, -BASE.t], [BASE.x1 + 1.4, BASE.y0 + 1, -BASE.t]])} className="m-ground-shadow" filter="url(#m-blur-lg)" />
      <polygon points={base.left} className="m-base-left" />
      <polygon points={base.right} className="m-base-right" />
      <polygon points={base.top} fill="url(#m-base-top)" className="m-base-top" />
      {/* خطوط بلاط الممر الأمامي (في الاتجاهين) */}
      {Array.from({ length: 16 }, (_, i) => 0.6 + i * 1.07).map((X) => <path key={`j${X}`} d={path([[X, BED.y1 + 0.35], [X, BASE.y1]])} className="m-joint" />)}
      {[BED.y1 + 0.35, 7.5].map((Y) => <path key={`r${Y}`} d={path([[BASE.x0, Y], [BASE.x1, Y]])} className="m-joint" />)}

      {/* الأحواض الثلاثة: السطح بلون التربة مع نقش خفيف، والمقطع يُظهر طبقات (غطاء، تربة، حصى). كل حوض رابط بالضغط أو Enter */}
      {PLOTS.map((p) => {
        const z = byId[p.id];
        const b = box(p.x[0], p.x[1], BED.y0, BED.y1, 0, BED.h);
        const gravel = box(p.x[0], p.x[1], BED.y0, BED.y1, 0, 0.14);
        const cover = box(p.x[0], p.x[1], BED.y0, BED.y1, BED.h - 0.07, BED.h);
        return (
          <g key={p.id} className={`m-zone k-${p.kind} st-${states[p.id]}`} style={{ '--zone': colors[p.id], '--soil': soilTone(z?.soil_moisture) }} role="link" tabIndex="0"
            aria-label={`افتح ${z?.name || `المنطقة ${p.id}`}`} onClick={() => onPick?.(p.id)} onKeyDown={(e) => { if (e.key === 'Enter') onPick?.(p.id); }}>
            <polygon points={b.left} className="m-soil-left" />
            <polygon points={b.right} className="m-soil-right" />
            <polygon points={b.left} fill="url(#m-stipple)" />
            <polygon points={gravel.left} fill="url(#m-gravel)" />
            <polygon points={gravel.right} fill="url(#m-gravel)" className="m-dim" />
            <polygon points={cover.left} className="m-cover" />
            <polygon points={cover.right} className="m-cover m-dim" />
            <polygon points={b.top} className="m-soil-top" />
            <polygon points={b.top} fill="url(#m-stipple)" />
            <polygon points={b.top} className="m-zone-edge" />
          </g>
        );
      })}

      {/* الأنبوب الرئيسي على الممر (من الخزان إلى المضخة ثم أمام الأحواض) وفرع صاعد لكل حوض، وسلك التحكم المنقط.
          الماء المتحرك يظهر فقط في طريق الصمام المفتوح */}
      <path d={path([[TANK[0], TANK[1] + 0.9], [TANK[0], PIPE_Y], [mid(PLOTS[2]), PIPE_Y]])} className="m-pipe" />
      {PLOTS.map((p) => <path key={p.id} d={path([[mid(p), PIPE_Y], [mid(p), BED.y1], [mid(p), BED.y1, BED.h - 0.05]])} className="m-pipe branch" />)}
      {open && openPlot && (
        <path d={path([[TANK[0], TANK[1] + 0.9], [TANK[0], PIPE_Y], [mid(openPlot), PIPE_Y], [mid(openPlot), BED.y1], [mid(openPlot), BED.y1, BED.h - 0.05]])} className="m-flow" />
      )}
      <path d={path([[CTRL[0] + 0.9, CTRL[1] + 0.4], [CTRL[0] + 1.3, WIRE_Y], [mid(PLOTS[2]), WIRE_Y]])} className="m-wire" />
      {PLOTS.map((p) => <path key={p.id} d={path([[mid(p), WIRE_Y], [mid(p), PIPE_Y + 0.3]])} className="m-wire" />)}

      {/* الأشياء القائمة مرتبة حسب العمق */}
      {things.map((t) => <g key={t.key}>{t.el}</g>)}

      {/* الرش فوق الحوض الذي يُروى */}
      {openPlot && (() => {
        const [x, y] = iso(mid(openPlot), BED.y1 - 0.6, BED.h + 0.15);
        return (
          <g className="m-spray" transform={`translate(${f1(x)} ${f1(y)})`}>
            {[-28, -14, 0, 14, 28].map((dx, i) => <circle key={dx} cx={dx * 0.7} cy={-Math.abs(dx) * 0.12 - 6} r="2" style={{ animationDelay: `${i * 0.16}s` }} />)}
          </g>
        );
      })()}

      {/* رقم كل منطقة على زاوية حوضها الأمامية (يربط الرسم ببطاقات المناطق تحته) */}
      {callouts && PLOTS.map((p) => {
        const [x, y] = iso(p.x[0] + 0.3, BED.y1 - 0.25, BED.h);
        return (
          <g key={p.id} className="m-tag" style={{ '--zone': colors[p.id] }} pointerEvents="none">
            <circle cx={f1(x)} cy={f1(y - 13)} r="10.5" />
            <text x={f1(x)} y={f1(y - 8.6)} textAnchor="middle">{p.id}</text>
          </g>
        );
      })}

      {/* البطاقات التوضيحية ذات الخطوط المنقطة */}
      {notes.map(({ key, ...n }) => <Callout key={key} {...n} />)}

      {raining && <rect x={-200} y={-200} width={W + 400} height={H + 400} fill="url(#rain)" className="rain-sheet" />}
    </svg>
  );
}
