/**
 * ar.js — كل النصوص العربية التي تعرضها اللوحة.
 * الخادم يرسل رموزًا (codes) مثل IRRIGATE أو RAIN_LIKELY، والواجهة تحوّلها هنا إلى كلمات.
 * يُستخدم في كل الصفحات: شارة الوضع في الشريط العلوي، حالات المناطق، سلم القرار، الأحداث، عمليات الري.
 */

// أوضاع النظام كله (status.system.mode): label اسم قصير للشارة، desc شرح يظهر عند مرور الفأرة.
export const MODES = {
  NORMAL: { label: 'يعمل طبيعيًا', desc: 'يقرأ الحساسات، ويحدّث قرار كل منطقة مع كل تنبؤ جديد.' },
  IRRIGATING: { label: 'جارٍ الري', desc: 'منطقة واحدة في كل مرة، لأن مضخة واحدة تغذي كل الصمامات.' },
  RAIN_LOCKOUT: { label: 'قفل المطر', desc: 'حساس المطر رصد مطرًا. المضخة متوقفة، وكل الصمامات مغلقة، ولن يبدأ أي ري جديد.' },
  COOLDOWN: { label: 'انتظار بعد المطر', desc: 'توقف المطر. ينتظر النظام حتى يتسرب الماء في التربة، ثم يقرأها من جديد قبل أي قرار.' },
  ERROR: { label: 'متوقف بسبب عطل', desc: 'جهاز الري أبلغ عن عطل. الري متوقف حتى يُفحص العطل ويُلغى من لوحة الإدارة.' },
};

// نوع قرار الري لكل منطقة في كلمة واحدة.
export const ACTIONS = { IRRIGATE: 'ري', DEFER: 'تأجيل', SKIP: 'لا حاجة', HOLD: 'متوقف' };

// قرار SKIP بسبب بيانات مفقودة أو خاطئة لا يعني "التربة رطبة بما يكفي".
const NO_DATA = new Set(['NO_SOIL_DATA', 'SENSOR_INVALID', 'SOIL_STALE', 'INPUTS_STALE']);
// مضخة واحدة: المنطقة التي تحتاج ماء ولم تُختر تنتظر دورها.
// actionLabel: كلمة القرار للعرض. actionTone: اسم اللون المناسب له في CSS.
export const actionLabel = (d) => (!d ? '—' : NO_DATA.has(d.reason_code) ? 'لا بيانات'
  : d.action === 'IRRIGATE' && d.chosen === false ? 'ينتظر دوره' : ACTIONS[d.action]);
export const actionTone = (d) => (!d || NO_DATA.has(d.reason_code) ? 'hold' : { IRRIGATE: 'water', DEFER: 'warn', SKIP: 'good', HOLD: 'hold' }[d.action]);

// سبب القرار (reason_code) في جملة كاملة مفهومة.
export const REASONS = {
  BELOW_TARGET: 'الرطوبة أقل من الهدف، واحتمال المطر منخفض.',
  CRITICAL_DRY: 'جفاف حرج: تُروى حتى لو كان هناك تنبؤ بالمطر.',
  RAIN_LIKELY: 'تنبؤ بمطر خلال الساعات القادمة، فالري مؤجل لتوفير الماء.',
  DEFER_LIMIT_REACHED: 'انتهت مدة التأجيل القصوى دون مطر، فتُروى بنصف الكمية.',
  NO_FORECAST: 'لا يوجد تنبؤ متاح، فالقرار مبني على التربة وحدها.',
  CLOSED_LOOP_PULSE: 'نبضة تكميلية: القراءة بعد الري ما زالت تحت الهدف.',
  MANUAL_TEST: 'تشغيل اختباري من لوحة الصيانة.',
  AT_TARGET: 'الرطوبة عند الهدف أو أعلى.',
  SOAKING: 'رُويت قبل قليل. ينتظر حتى يتوزع الماء قبل القراءة.',
  MAX_PULSES: 'وصلت لأقصى عدد نبضات في هذه الدورة.',
  DAILY_LIMIT: 'وصلت للحد اليومي للري (حماية من الإغراق).',
  SENSOR_INVALID: 'قراءة الحساس غير منطقية (مفصول أو غير معاير). لا ري حتى يُفحص.',
  NO_SOIL_DATA: 'لم تصل قراءة من حساس التربة بعد.',
  INPUTS_STALE: 'عقدة الحساسات لا ترسل. عقدة التشغيل أوقفت الري احتياطًا.',
  SOIL_STALE: 'آخر قراءة للتربة قديمة. لا ري على بيانات قديمة.',
  RAIN_LOCKOUT: 'قفل المطر فعّال.',
  COOLDOWN: 'انتظار ما بعد المطر.',
  SYSTEM_ERROR: 'النظام في حالة عطل.',
  ZONE_DISABLED: 'المنطقة معطلة.',
};

// سلم القرار، بنفس الترتيب الذي يفحصه به محرك القرار (في عقدة التشغيل).
// key: رمز الخطوة، label: اسمها، q: السؤال الذي تجيب عنه. يُعرض في صفحة القرار (DecisionPath).
export const STEPS = [
  { key: 'MANUAL', label: 'تشغيل يدوي', q: 'هل هذا تشغيل اختباري من لوحة الصيانة؟' },
  { key: 'ZONE', label: 'المنطقة مفعّلة', q: 'هل هذه المنطقة مفعّلة؟' },
  { key: 'SAFETY', label: 'طبقة الأمان', q: 'هل يوجد مطر أو قفل مطر أو انتظار أو عطل، أو انقطعت الحساسات؟' },
  { key: 'SENSOR', label: 'صلاحية الحساس', q: 'هل قراءة التربة منطقية؟' },
  { key: 'NEED', label: 'الحاجة للماء', q: 'هل التربة تحت الهدف؟' },
  { key: 'SOAK', label: 'التسرب', q: 'هل انتهى انتظار ما بعد آخر نبضة؟' },
  { key: 'PULSES', label: 'حد النبضات', q: 'هل بقيت نبضات في هذه الدورة؟' },
  { key: 'DAILY', label: 'الحد اليومي', q: 'هل بقي من حد الري اليومي؟' },
  { key: 'CRITICAL', label: 'الجفاف الحرج', q: 'هل التربة فوق الحد الحرج؟' },
  { key: 'FORECAST', label: 'تنبؤ الذكاء الاصطناعي', q: 'هل لا يوجد تنبؤ بمطر؟' },
];

// أسماء مدخلات نموذج الذكاء الاصطناعي للتنبؤ بالمطر (تظهر في عوامل التنبؤ بصفحة الطقس).
export const FEATURES = {
  temperature: 'الحرارة', humidity: 'رطوبة الجو', pressure: 'الضغط الجوي',
  dewpoint: 'نقطة الندى', dewpoint_depression: 'الفرق عن نقطة الندى',
  dt_1h: 'تغير الحرارة (1س)', dt_3h: 'تغير الحرارة (3س)', dh_1h: 'تغير الرطوبة (1س)', dh_3h: 'تغير الرطوبة (3س)',
  dp_1h: 'تغير الضغط (1س)', dp_3h: 'تغير الضغط (3س)', hour: 'ساعة اليوم', season: 'الموسم',
};

// حالة عملية الري، وأسباب إيقافها قبل وقتها (stop_reason).
export const RUN_STATUS = { ACTIVE: 'يعمل الآن', COMPLETED: 'اكتمل', CANCELLED: 'أُوقف', FAILED: 'فشل' };
export const CANCEL_REASONS = {
  RAIN_OVERRIDE: 'بسبب المطر', NOT_STARTED_BEFORE_EXPIRY: 'لم يبدأ في وقته',
  NO_COMPLETION_REPORT: 'لم يصل تقرير', BACKEND_UNREACHABLE: 'انقطع الاتصال', LOCAL_MAX_ON_TIME: 'الحد المحلي للتشغيل',
  COMMAND_REVOKED: 'سحبه الخادم',
  SAFETY_STATE: 'حالة أمان', SENSORS_STALE: 'الحساسات توقفت', TARGET_REACHED: 'وصل للهدف مبكرًا', SUPERSEDED: 'أُغلق بعد إعادة تشغيل الجهاز',
};

// اسم المنطقة من رقمها، أو "المنطقة N" إن لم يكن لها اسم.
const zn = (zones, id) => zones[id]?.name || `المنطقة ${id}`;

// اسم الجهاز بالعربي بدل المعرّف التقني (sensor_node_01 → عقدة الحساسات).
const deviceName = (id = '') => (id.startsWith('sensor') ? 'عقدة الحساسات' : id.startsWith('actuator') ? 'عقدة التشغيل' : id);

// تحويل حدث من سجل الأحداث إلى ما يُعرض: tone (اللون)، icon (الأيقونة)، title (العنوان)، detail (التفاصيل).
// يُستخدم في صفحة الأحداث وفي "آخر الأحداث" بالرئيسية. أي نوع غير معروف يُعرض باسمه التقني.
export function describeEvent(e, zones = {}) {
  switch (e.type) {
    case 'RAIN_STARTED': return { tone: 'rain', icon: 'rain', title: 'بدأ المطر', detail: 'قفل المطر: المضخة متوقفة والصمامات مغلقة.' };
    case 'IRRIGATION_STOPPED': return { tone: 'crit', icon: 'shield', title: 'أُوقف الري فورًا', detail: 'بسبب المطر، دون انتظار التنبؤ القادم.' };
    case 'COMMAND_CANCELLED': return { tone: 'crit', icon: 'shield', title: `إلغاء تشغيل اختباري لـ${zn(zones, e.zone_id)}`, detail: CANCEL_REASONS[e.reason] || e.reason };
    case 'IRRIGATION_STOP_CONFIRMED': return { tone: e.reason === 'TARGET_REACHED' ? 'water' : 'crit', icon: 'valve', title: e.reason === 'TARGET_REACHED' ? `${zn(zones, e.zone_id)} وصلت للهدف` : 'عقدة التشغيل أكّدت الإيقاف', detail: `${CANCEL_REASONS[e.reason] || e.reason || ''} · المضخة OFF والصمام CLOSED بعد ${e.seconds ?? 0} ث` };
    case 'RAIN_STOPPED': return { tone: 'muted', icon: 'sun', title: 'توقف المطر', detail: 'لن يبدأ الري مباشرة.' };
    case 'COOLDOWN_STARTED': return { tone: 'cool', icon: 'clock', title: 'بدأت فترة الانتظار', detail: 'حتى يتسرب ماء المطر في التربة.' };
    case 'DECISION_RECALCULATED': return { tone: 'good', icon: 'restart', title: 'أُعيد حساب القرار', detail: 'بقراءات تربة وطقس جديدة بعد المطر.' };
    case 'IRRIGATION_DEFERRED': return { tone: 'warn', icon: 'clock', title: `تأجيل ري ${zn(zones, e.zone_id)}`, detail: `احتمال المطر ${Math.round((e.rain_probability || 0) * 100)}%.` };
    case 'AI_DEFERRAL_CONFIRMED': return { tone: 'good', icon: 'leaf', title: 'المطر أكّد قرار التأجيل', detail: `${zn(zones, e.zone_id)} · وُفّر ≈ ${e.est_liters ?? 0} لتر (تقديري).` };
    case 'DEFERRAL_ENDED_NO_RAIN': return { tone: 'muted', icon: 'clock', title: `انتهى تأجيل ${zn(zones, e.zone_id)} دون مطر`, detail: 'رُويت المنطقة.' };
    case 'IRRIGATION_STARTED': return { tone: 'water', icon: 'drop', title: `بدأ ري ${zn(zones, e.zone_id)}`, detail: `${e.seconds} ث · ${e.manual ? 'اختبار يدوي' : 'قرار عقدة التشغيل'}` };
    case 'IRRIGATION_COMPLETED': return { tone: 'water', icon: 'drop', title: `اكتمل ري ${zn(zones, e.zone_id)}`, detail: `${e.seconds} ث` };
    case 'COMMAND_EXPIRED': return { tone: 'muted', icon: 'clock', title: 'انتهت صلاحية تشغيل اختباري', detail: 'لم تستلمه عقدة التشغيل في وقته، ولن يُنفذ أبدًا.' };
    case 'RUN_FAILED': return { tone: 'crit', icon: 'info', title: 'لم يصل تقرير نهاية الري', detail: `${zn(zones, e.zone_id)} · للجهاز حد تشغيل محلي` };
    case 'RUN_REFUSED': return { tone: 'crit', icon: 'shield', title: `رُفض تشغيل ${zn(zones, e.zone_id)}`, detail: e.mode === 'RAIN_LOCKOUT' ? 'قفل المطر فعّال' : (e.reason || e.mode || '') };
    case 'RUN_SUPERSEDED': return { tone: 'muted', icon: 'restart', title: 'أُغلقت عملية سابقة', detail: 'عقدة التشغيل أُعيد تشغيلها أثناء الري' };
    case 'SYSTEM_ERROR': return { tone: 'crit', icon: 'info', title: 'عطل في جهاز الري', detail: e.reason || '' };
    case 'ERROR_CLEARED': return { tone: 'good', icon: 'shield', title: 'أُلغي وضع العطل', detail: '' };
    case 'DEVICE_OFFLINE': return { tone: 'crit', icon: 'wifiOff', title: `انقطع اتصال ${deviceName(e.device_id)}` };
    case 'DEVICE_ONLINE': return { tone: 'good', icon: 'wifi', title: `عاد اتصال ${deviceName(e.device_id)}` };
    case 'MANUAL_RUN_REQUESTED': return { tone: 'water', icon: 'valve', title: `تشغيل اختباري: ${zn(zones, e.zone_id)}`, detail: `${e.seconds} ث من لوحة الصيانة` };
    case 'ZONE_UPDATED': return { tone: 'muted', icon: 'leaf', title: `تحديث إعداد ${zn(zones, e.zone_id)}`, detail: '' };
    default: return { tone: 'muted', icon: 'info', title: e.type, detail: '' };
  }
}
