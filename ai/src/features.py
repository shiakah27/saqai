# =====================================================================================================
# features.py — بناء الـ features (الخصائص) المشتركة بين التدريب (offline) والتنبؤ اللحظي (real-time)
# =====================================================================================================
# مكان هذا الملف في المسار (pipeline):
#   - train.py يستدعي build_features على البيانات التاريخية لمدينة الرياض لتدريب النموذج.
#   - service/main.py (خدمة FastAPI) يستدعي features_at على قراءات المحطة الحقيقية لحظة الطلب.
#
# لماذا ملف واحد مشترك؟
#   هذا الملف هو الضمان ضد ما يسمى train/serve skew (اختلاف معنى الـ feature بين التدريب والتشغيل).
#   لأن سكربت التدريب وخدمة FastAPI يستدعيان نفس الدالة build_features، فإن كل feature تعني الشيء
#   نفسه تماماً في الحالتين. لو كُتبت الحسابات مرتين لأمكن أن تختلف (مثلاً وحدة أو منطقة زمنية مختلفة)
#   فيتنبأ النموذج بأرقام خاطئة دون أن يظهر أي خطأ.
#
# قاعدتان أساسيتان:
#   1) كل feature تستخدم فقط المعلومات المتاحة عند اللحظة t (لا قيم من المستقبل) — وإلا "يغش" النموذج
#      أثناء التدريب ويفشل في التشغيل الحقيقي.
#   2) كل feature يمكن حسابها من محطة الطقس وحدها (حساس BME280: الحرارة، الرطوبة، الضغط + الساعة).
#
# الـ features الخمس عشرة:
#   temperature, humidity, pressure            القراءة الحالية (حرارة °C، رطوبة نسبية %، ضغط hPa)
#   dewpoint, dewpoint_depression              مشتقة من الحرارة والرطوبة (معادلة Magnus)
#   dt_1h, dt_3h, dh_1h, dh_3h, dp_1h, dp_3h   التغيّر مقارنة بالقراءة قبل ساعة / قبل 3 ساعات
#   hour_sin, hour_cos                         ساعة اليوم بتوقيت الرياض، بصيغة دائرية (cyclic)
#   doy_sin, doy_cos                           يوم السنة بصيغة دائرية (يمثل الموسم/الفصل)
#
# ملاحظة عن التوقيت: البيانات التاريخية كل ساعة، بينما المحطة ترسل قراءة كل 30 دقيقة. لا يتم أبداً
# "اختراع" تاريخ بدقة 30 دقيقة: الـ lag feature تعني دائماً "القراءة الحقيقية الأقرب إلى t − 1 ساعة
# (أو t − 3 ساعات)" بشرط أن تكون ضمن 16 دقيقة (نصف فترة الإرسال تقريباً)، وبذلك يبقى معنى الـ feature
# في التشغيل مطابقاً لمعناه في بيانات التدريب الساعية.
# (النص الإنجليزي التالي هو الـ docstring الأصلي ويحمل المعلومات نفسها.)
"""
Feature engineering shared by OFFLINE training and REAL-TIME inference.

This single module is the guarantee against train/serve skew: the training script and the
FastAPI service both call `build_features`, so a feature means exactly the same thing in both.

Every feature uses only information available at time t (no future values), and every one can be
produced from the weather station alone (BME280 temperature, humidity, pressure + clock):

    temperature, humidity, pressure          current reading
    dewpoint, dewpoint_depression            derived from T and RH (Magnus formula)
    dt_1h, dt_3h, dh_1h, dh_3h, dp_1h, dp_3h change versus the reading 1 h / 3 h earlier
    hour_sin, hour_cos                       Riyadh local hour, cyclic
    doy_sin, doy_cos                         day of year, cyclic (season)

The historical data is hourly and the station reports every 30 min. We never invent 30-min
history: a lag feature always means "the real reading closest to t − 1 h (or t − 3 h)", within 16 min
(half the reporting period), so the hourly training meaning is preserved at inference time.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

# القائمة الرسمية للـ features وترتيبها. النموذج تدرّب على هذه الأعمدة بهذا الترتيب بالضبط،
# لذلك تُستخدم هذه القائمة في التدريب وفي الخدمة لاختيار الأعمدة وترتيبها.
#
# الشرح الفيزيائي لكل مجموعة:
# - temperature / humidity / pressure: حالة الجو الآن.
#   * الضغط المطلق في الرياض يكون تقريباً 930–955 hPa (وليس ~1013) بسبب ارتفاع المدينة عن سطح البحر،
#     ولهذا فإن "تغيّر" الضغط أهم من قيمته المطلقة.
# - dewpoint (نقطة الندى): درجة الحرارة التي لو برد إليها الهواء لتشبّع بالماء وبدأ التكاثف (غيوم/ندى).
#   هي مقياس مباشر لكمية بخار الماء الفعلية في الهواء (بعكس الرطوبة النسبية التي تتغير مع الحرارة).
# - dewpoint_depression = temperature − dewpoint: كلما صغر الفرق اقترب الهواء من التشبّع → احتمال
#   تكوّن الغيوم والمطر أعلى. الرطوبة ونقطة الندى هما أقوى الـ features في النموذج.
# - dt/dh/dp_1h و _3h: الاتجاه (هل الجو يتغير؟) وليس فقط الحالة.
#   * ضغط ينخفض (dp_1h, dp_3h < 0) يدل على اقتراب منخفض جوي أو جبهة → صعود الهواء → تبرّده →
#     تكوّن غيوم → مطر. لكن انخفاض الضغط وحده لا يكفي: يحتاج إلى رطوبة (dewpoint/humidity) حتى
#     يعني مطراً؛ النموذج يتعلم هذا الدمج بين العاملين.
#   * فترة 3 ساعات هي الفترة القياسية لقياس "ميل الضغط" (pressure tendency) في علم الأرصاد،
#     وفترة الساعة الواحدة تلتقط التغيرات الأسرع.
# - hour_sin/hour_cos و doy_sin/doy_cos: الوقت بصيغة دائرية (انظر الشرح داخل build_features).
FEATURES = [
    "temperature", "humidity", "pressure",
    "dewpoint", "dewpoint_depression",
    "dt_1h", "dt_3h", "dh_1h", "dh_3h", "dp_1h", "dp_3h",
    "hour_sin", "hour_cos", "doy_sin", "doy_cos",
]

# المنطقة الزمنية المحلية: ساعة اليوم والموسم يُحسبان بتوقيت الرياض لأن نمط الطقس اليومي مرتبط بالشمس محلياً.
LOCAL_TZ = "Asia/Riyadh"
# أقصى فرق مسموح بين الوقت المطلوب (t − 1h أو t − 3h) وأقرب قراءة حقيقية.
# المحطة ترسل كل 30 دقيقة ← أقرب قراءة تكون دائماً على بُعد ≤ 15 دقيقة، و16 دقيقة تعطي هامشاً بسيطاً.
LAG_TOLERANCE = pd.Timedelta(minutes=16)   # station reports every 30 min → nearest reading is always ≤ 15 min away
# أقل تاريخ مطلوب: لحساب dt_3h/dh_3h/dp_3h يلزم وجود قراءة قبل 3 ساعات.
# لذلك في أول ~3 ساعات بعد تشغيل المحطة لا يوجد تنبؤ (الخدمة ترد بـ INSUFFICIENT_HISTORY).
REQUIRED_HISTORY = pd.Timedelta(hours=3)


# dewpoint: حساب نقطة الندى (°C) من الحرارة (°C) والرطوبة النسبية (%) بتقريب Magnus.
# - التقريب صالح للظروف السطحية العادية.
# - الثوابت a = 17.62 و b = 243.12 °C هي ثوابت Magnus المعتادة فوق الماء.
# - الخطوات: gamma = (a·T)/(b+T) + ln(RH/100)، ثم نقطة الندى = (b·gamma)/(a − gamma).
# - تُقصّ الرطوبة إلى المدى 1..100 لتفادي ln(0) (قيمة لا نهائية) وأي قراءة خاطئة فوق 100%.
# - تعمل على رقم واحد أو على عمود كامل (numpy) لأن التدريب يمرر أعمدة والخدمة تمرر عدة قراءات.
def dewpoint(temp_c, rh):
    """Magnus approximation, valid for normal surface conditions."""
    a, b = 17.62, 243.12
    rh = np.clip(np.asarray(rh, dtype=float), 1, 100)
    gamma = (a * np.asarray(temp_c, dtype=float)) / (b + np.asarray(temp_c, dtype=float)) + np.log(rh / 100.0)
    return (b * gamma) / (a - gamma)


# _lagged: لكل لحظة t تُرجع قيمة القراءة الحقيقية الأقرب إلى (t − hours)،
# أو NaN إذا لم توجد قراءة ضمن LAG_TOLERANCE (16 دقيقة).
# لماذا "الأقرب ضمن حد"؟ لأن المحطة لا ترسل بالضبط على رأس الساعة؛ ولا يتم تقدير (interpolation)
# أي قيمة غير موجودة — إن لم توجد قراءة حقيقية قريبة تبقى القيمة NaN ولا يُعطى تنبؤ.
def _lagged(series: pd.Series, hours: int) -> np.ndarray:
    """Value of the reading closest to (t - hours), or NaN if none within tolerance."""
    target = series.index - pd.Timedelta(hours=hours)
    # reindex بطريقة nearest مع tolerance: يأخذ أقرب وقت موجود فعلاً، وإلا يضع NaN
    return series.reindex(target, method="nearest", tolerance=LAG_TOLERANCE).to_numpy()


# build_features: الدالة المركزية التي تحوّل قراءات خام إلى جدول الـ features الخمس عشرة.
# المدخلات: df بفهرس زمني يحمل المنطقة الزمنية (tz-aware، أي منطقة) وأعمدة temperature, humidity, pressure.
# المخرجات: صف features واحد لكل صف مدخلات، بالترتيب المحدد في FEATURES، مع NaN حيث لا يكفي التاريخ
# (مثلاً أول 3 ساعات). صفوف NaN تُستبعد في التدريب، وفي الخدمة تؤدي إلى رفض الطلب بدل التخمين.
def build_features(df: pd.DataFrame) -> pd.DataFrame:
    """
    df: index = tz-aware DatetimeIndex (any timezone), columns temperature, humidity, pressure.
    Returns one feature row per input row (NaN where history is insufficient).
    """
    df = df.sort_index()   # الترتيب الزمني ضروري لحساب التغيّرات بشكل صحيح
    local = df.index.tz_convert(LOCAL_TZ)   # الوقت بتوقيت الرياض لحساب ساعة اليوم ويوم السنة
    f = pd.DataFrame(index=df.index)
    # 1) القراءات الحالية كما هي
    f["temperature"] = df["temperature"]
    f["humidity"] = df["humidity"]
    f["pressure"] = df["pressure"]
    # 2) نقطة الندى والفرق بينها وبين الحرارة (مدى قرب الهواء من التشبّع)
    f["dewpoint"] = dewpoint(df["temperature"], df["humidity"])
    f["dewpoint_depression"] = f["temperature"] - f["dewpoint"]
    # 3) التغيّرات: القيمة الآن ناقص القيمة قبل ساعة وقبل 3 ساعات، لكل من الحرارة (t) والرطوبة (h) والضغط (p).
    #    ينتج عنها: dt_1h, dt_3h, dh_1h, dh_3h, dp_1h, dp_3h. قيمة dp سالبة = الضغط ينخفض (إشارة اقتراب منخفض).
    for col, short in (("temperature", "t"), ("humidity", "h"), ("pressure", "p")):
        for h in (1, 3):
            f[f"d{short}_{h}h"] = df[col] - _lagged(df[col], h)
    # 4) الوقت بصيغة دائرية (sin/cos):
    #    لو أُعطيت الساعة كرقم عادي (0..23) لظن النموذج أن 23:00 و 00:00 بعيدتان جداً (فرق 23)، مع أنهما
    #    متجاورتان. تحويل الساعة إلى زاوية على دائرة ثم أخذ sin و cos يجعل النقاط المتجاورة زمنياً متجاورة
    #    عددياً. نحتاج الاثنين معاً لأن sin وحده يعطي القيمة نفسها لساعتين مختلفتين.
    #    الشيء نفسه ليوم السنة (365.25 يوم لاحتساب السنة الكبيسة): 31 ديسمبر قريب من 1 يناير، وهذا يمثل الموسم
    #    (المطر في الرياض موسمي، يتركز في الشتاء والربيع).
    hour = local.hour + local.minute / 60.0   # ساعة كسرية: 11:30 → 11.5 (لأن المحطة ترسل كل نصف ساعة)
    doy = local.dayofyear
    f["hour_sin"] = np.sin(2 * np.pi * hour / 24)
    f["hour_cos"] = np.cos(2 * np.pi * hour / 24)
    f["doy_sin"] = np.sin(2 * np.pi * doy / 365.25)
    f["doy_cos"] = np.cos(2 * np.pi * doy / 365.25)
    return f[FEATURES]   # إرجاع الأعمدة بالترتيب الرسمي الذي تدرّب عليه النموذج


# features_at: تستخدمها الخدمة اللحظية. تُرجع features آخر قراءة عند اللحظة `at` أو قبلها،
# أو None إذا لم يكن التاريخ كافياً.
# الشرطان لإرجاع None:
#   - لا توجد قراءات، أو المدة بين أول وآخر قراءة أقل من 3 ساعات (مع سماح LAG_TOLERANCE).
#   - أي feature في الصف الأخير قيمتها NaN (مثلاً فجوة في القراءات قبل ساعة أو 3 ساعات).
# المبدأ: إذا لم تتوفر بيانات حقيقية كافية لا يتم التخمين أبداً.
def features_at(readings: pd.DataFrame, at: pd.Timestamp) -> pd.Series | None:
    """Features for the latest reading at or before `at`; None if history is insufficient."""
    readings = readings[readings.index <= at]   # تجاهل أي قراءة بعد `at` (لا معلومات من المستقبل)
    if readings.empty or readings.index[-1] - readings.index[0] < REQUIRED_HISTORY - LAG_TOLERANCE:
        return None
    row = build_features(readings).iloc[-1]   # تُحسب الـ features لكل القراءات ويُؤخذ الصف الأخير (الآن)
    return None if row.isna().any() else row
