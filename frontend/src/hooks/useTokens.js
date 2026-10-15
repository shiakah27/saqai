/**
 * useTokens.js — hook تقرأ ألوان التصميم (متغيرات CSS) لاستخدامها في الرسوم البيانية.
 * تُستخدم في App (ألوان المناطق) وفي مكوّنات الرسوم. لا تستخدم بيانات الخادم.
 */
import { useEffect, useState } from 'react';

// أسماء متغيرات CSS المطلوبة (معرّفة في :root داخل styles.css).
const NAMES = ['--z1', '--z2', '--z3', '--accent-line', '--rain', '--rain-soft', '--ink-2', '--ink-3', '--line', '--surface', '--warn-ink'];

// قراءة القيم الفعلية الحالية؛ المفتاح بدون "--" (مثلًا z1 أو accent-line).
function read() {
  const cs = getComputedStyle(document.documentElement);
  return Object.fromEntries(NAMES.map((n) => [n.slice(2), cs.getPropertyValue(n).trim()]));
}

/** مكتبات الرسوم تحتاج نصوص ألوان حقيقية (لا تفهم var(--x))، لذلك تُقرأ متغيرات CSS ويُعاد قراءتها عند تغيّر المظهر:
 *  إما تغيّر مظهر النظام (فاتح/داكن) أو تغيّر السمة data-theme على عنصر html عند ضغط زر المظهر. */
export function useTokens() {
  const [tokens, setTokens] = useState(read);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const update = () => setTokens(read());
    mq.addEventListener('change', update);
    const obs = new MutationObserver(update);
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => { mq.removeEventListener('change', update); obs.disconnect(); };
  }, []);
  return tokens;
}
