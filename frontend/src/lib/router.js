/**
 * router.js — موجّه الصفحات (router) البسيط للوحة.
 * يحدد قائمة الصفحات (تظهر في الشريط العلوي وفي الشريط السفلي على الجوال) ويقرأ الصفحة الحالية من الرابط.
 * لا يستخدم بيانات الخادم.
 */
import { useEffect, useState } from 'react';

/**
 * التوجيه عبر الـhash (مثل ‎#/zones/2): يعمل مهما كان المسار الذي يقدّم منه الخادم الملفات المبنية،
 * ويبقى بعد تحديث الصفحة، ولا يحتاج أي إعداد في الخادم ولا أي مكتبة إضافية.
 */
// كل صفحة: id في الرابط، icon أيقونتها، label اسمها في القائمة، title عنوانها، sub وصف قصير.
export const PAGES = [
  // story: عرض الفكرة بالتمرير لزوار المعرض (بدون الشريط العلوي)
  { id: 'story', icon: 'play', label: 'الفكرة', title: 'سَقاي', sub: 'كيف يقرر سَقاي متى يسقي.' },
  { id: 'overview', icon: 'grid', label: 'الرئيسية', title: 'المزرعة الآن', sub: 'كل ما يحدث في هذه اللحظة.' },
  { id: 'zones', icon: 'leaf', label: 'المناطق', title: 'المناطق', sub: 'رطوبة كل منطقة وقرار الري لها.' },
  { id: 'decision', icon: 'target', label: 'القرار', title: 'قرار الري', sub: 'أي منطقة تُسقى أولًا، ولماذا.' },
  { id: 'weather', icon: 'rain', label: 'الطقس', title: 'الطقس والتنبؤ', sub: 'قراءات المحطة واحتمال المطر خلال 3 ساعات.' },
  { id: 'runs', icon: 'drop', label: 'الري', title: 'عمليات الري', sub: 'كل مرة اشتغلت فيها المضخة.' },
  { id: 'events', icon: 'list', label: 'الأحداث', title: 'سجل الأحداث', sub: 'المطر والإيقاف والأجهزة، الأحدث أولًا.' },
  // hidden: لا تظهر في الشريط العلوي ولا في شريط الجوال؛ تُفتح فقط من الرابط المباشر #/maintenance (للفريق).
  { id: 'maintenance', hidden: true, icon: 'valve', label: 'الصيانة', title: 'الصيانة', sub: 'اختبار الصمامات والمعايرة. يتطلب مفتاح الإدارة.' },
];

// قراءة الرابط: "#/zones/2" → { page: 'zones', arg: 2 }.
// صفحة غير معروفة تعود إلى الرئيسية، والمعامل arg يتحول إلى رقم إن أمكن.
function parse() {
  const [, page = 'overview', arg] = (window.location.hash || '').replace(/^#/, '').split('/');
  return { page: PAGES.some((p) => p.id === page) ? page : 'overview', arg: arg ? Number(arg) || arg : null };
}

// hook تعيد الصفحة الحالية وتتحدث عند تغيّر الـhash، مع الرجوع لأعلى الصفحة عند كل انتقال.
export function useRoute() {
  const [route, setRoute] = useState(parse);
  useEffect(() => {
    const on = () => { setRoute(parse()); window.scrollTo({ top: 0 }); };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

// بناء رابط صفحة: href('zones', 2) → "#/zones/2".
export const href = (page, arg) => `#/${page}${arg != null ? `/${arg}` : ''}`;
