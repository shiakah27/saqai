# =====================================================================================================
# train.py — التدريب offline لنموذج المطر rain_model_v1
# =====================================================================================================
# التشغيل:   python ai/src/train.py
#
# السؤال الذي يجيب عنه النموذج:
#   ما احتمال هطول مطر ≥ 0.1 mm خلال الساعات الثلاث القادمة، علماً أن الجو جاف الآن؟
#   P(rain ≥ 0.1 mm in the next 3 hours | dry now)
#
# المسار (pipeline) خطوة بخطوة:
#   1) ملف CSV التاريخي للرياض (102,864 صفاً ساعياً، 2015 → 2026) ← تنظيف (load)
#   2) بناء الهدف rain_next_3h: هل ستمطر في أي من الساعات الثلاث القادمة؟ (make_target)
#   3) بناء الـ features المشتركة من features.py (نفس الكود الذي تستخدمه الخدمة → لا train/serve skew)
#   4) تقسيم زمني مرتب (time-ordered split) وليس عشوائياً أبداً:
#        train  2015–2022      تدريب النماذج المرشحة
#        calib  2023           اختيار النموذج + معايرة الاحتمالات
#        thresh 2024 النصف الأول  اختيار النموذج + اختيار الـ threshold
#        test   2024-07 → النهاية  الاختبار النهائي، يُلمس مرة واحدة فقط
#   5) تدريب 5 نماذج مرشحة (baselines) واختيار الأفضل حسب PR-AUC على بيانات التحقق (validation)
#      → فاز Random Forest
#   6) معايرة isotonic على 2023 (بحد أقصى 0.95)
#   7) اختيار الـ threshold (عتبة القرار) على 2024 H1 بتعظيم F1 → النتيجة 0.1067
#      (العتبة المعتمدة الآن 0.08، اختيرت حسب تكلفة الخطأ بالسكربت ai/scripts/set_threshold.py)
#   8) الاختبار النهائي على 2024 H2 → 2026 + onset recall + محاكاة الري (irrigation backtest)
#   9) الحفظ: ai/models/rain_model_v1.joblib + ملف بيانات وصفية .json + تقرير ai/reports/rain_model_v1.md
#
# البيانات التاريخية تُستخدم هنا فقط. أثناء التشغيل لا ترى الخدمة إلا قراءات المحطة الحقيقية.
#
# لماذا أفق 3 ساعات (HORIZON_H = 3)؟
#   - ميل الضغط (pressure tendency) يُقاس في علم الأرصاد على فترة 3 ساعات.
#   - النبات يستطيع الانتظار حتى 3 ساعات دون ضرر، فتأجيل الري لا يتجاوز ذلك.
#   - التجارب مقارنة بأفق 1 و 2 و 6 ساعات أظهرت أن 3 ساعات الأفضل: نسبة بدايات المطر التي سبقها
#     تحذير 43% مقابل 13% / 35% / 35%.
#
# تذكير بدور النموذج: الذكاء الاصطناعي يعطي احتمالاً فقط. القرار عند ESP32 رقم 2: يؤجل الري إذا كان
# الاحتمال ≥ الـ threshold (مع hysteresis، ولمدة أقصاها 3 ساعات)، والجفاف الحرج وحساس المطر الفعلي
# يتغلبان على قرار النموذج دائماً.
# (النص الإنجليزي التالي هو الـ docstring الأصلي ويحمل المعلومات نفسها.)
"""
OFFLINE training of rain_model_v1.

    python ai/src/train.py

Pipeline:
  historical Riyadh CSV → cleaning → target rain_next_3h → shared features (features.py)
  → time-ordered split (never random) → 5 baselines → pick best by validation PR-AUC
  → isotonic calibration (2023) → decision threshold (2024 H1) → final test (2024 H2 → 2026)
  → ai/models/rain_model_v1.joblib + .json metadata + ai/reports/rain_model_v1.md

The historical data is used ONLY here. At run time the service sees real station readings only.
"""
from __future__ import annotations

import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import joblib
import lightgbm as lgb
import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import (average_precision_score, confusion_matrix, f1_score, precision_score,
                             recall_score, roc_auc_score, precision_recall_curve)
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler
from sklearn.tree import DecisionTreeClassifier
from xgboost import XGBClassifier

# إضافة مجلد src إلى مسار الاستيراد حتى يمكن استيراد features و calibration من نفس المجلد
sys.path.insert(0, str(Path(__file__).parent))
from features import FEATURES, LOCAL_TZ, build_features  # noqa: E402
from calibration import IsotonicCalibrated  # noqa: E402

# المسارات: جذر المشروع، ملف البيانات التاريخية، ومجلدا حفظ النموذج والتقرير
ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "data" / "raw" / "riyadh_hourly_2015_2026.csv"
MODELS = ROOT / "ai" / "models"
REPORTS = ROOT / "ai" / "reports"
VERSION = "rain_model_v1"
HORIZON_H = 3           # أفق التنبؤ بالساعات (انظر أسباب اختيار 3 ساعات في رأس الملف)
RAIN_MM = 0.1           # أصغر كمية مسجلة في البيانات؛ أي كمية قابلة للقياس تُعد مطراً

# التقسيم الزمني. لا خلط عشوائي (shuffle) أبداً: الساعات المتتالية متشابهة جداً، فلو خُلطت عشوائياً
# لرأى النموذج في التدريب ساعة ملاصقة لساعة الاختبار، ولظهرت نتائج متفائلة كاذبة. التقسيم الزمني يحاكي
# الواقع: التعلم من الماضي والتنبؤ بمستقبل لم يُرَ.
SPLITS = {
    "train": ("2015-01-01", "2022-12-31 23:00"),
    "calib": ("2023-01-01", "2023-12-31 23:00"),
    "thresh": ("2024-01-01", "2024-06-30 23:00"),
    "test": ("2024-07-01", "2026-12-31 23:00"),
}


# load: قراءة ملف CSV التاريخي وتنظيفه.
# - utf-8-sig يزيل علامة BOM التي يضيفها Excel قبل اسم أول عمود، و strip يزيل المسافات من أسماء الأعمدة.
# - الوقت في الملف بتوقيت الرياض المحلي، فيُربط بالمنطقة الزمنية حتى تعمل build_features بشكل صحيح.
# - ترتيب زمني وحذف أي وقت مكرر.
def load() -> pd.DataFrame:
    df = pd.read_csv(DATA, encoding="utf-8-sig")
    df.columns = [c.strip() for c in df.columns]
    df["time"] = pd.to_datetime(df["time"]).dt.tz_localize(LOCAL_TZ)   # البيانات بتوقيت الرياض المحلي
    df = df.set_index("time").sort_index()
    df = df[~df.index.duplicated()]
    # حدود فيزيائية منطقية (لا يفشل فيها أي صف حالياً، لكن الفحص يوثّق النية ويحمي من بيانات مستقبلية خاطئة)
    ok =df["temperature"].between(-10, 55) & df["humidity"].between(0, 100) & df["pressure"].between(850, 1100)
    return df[ok]


# make_target: بناء الهدف (label) الذي يتعلمه النموذج.
# الهدف = 1 إذا كان المطر ≥ RAIN_MM في أي ساعة من الساعات HORIZON_H القادمة (t+1 … t+3)، وإلا 0.
# الهدف من المستقبل فقط عن قصد (يبدأ من t+1 وليس t): المطر الحالي ليس "تنبؤاً".
def make_target(df: pd.DataFrame) -> pd.Series:
    """1 if rain >= RAIN_MM in ANY of the next HORIZON_H hours (t+1 … t+H). Future-only by design."""
    rain = (df["precip_mm"] >= RAIN_MM).astype(float)
    # shift(-k) يجلب قيمة الساعة t+k إلى الصف t؛ عمود لكل ساعة من الساعات الثلاث القادمة
    future = pd.concat([rain.shift(-k) for k in range(1, HORIZON_H + 1)], axis=1)
    y = future.max(axis=1)   # max = 1 إذا أمطرت في أي ساعة منها
    y[future.isna().any(axis=1)] = np.nan   # آخر الساعات في الملف ليس لها مستقبل كامل → تُحذف
    return y


# candidates: النماذج الخمسة المرشحة التي تتم مقارنتها (من الأبسط إلى الأقوى):
#   Logistic Regression  نموذج خطي بسيط (مع StandardScaler لتوحيد مقياس الـ features) — خط أساس
#   Decision Tree        شجرة قرار واحدة محدودة العمق (6) — سهلة الفهم
#   Random Forest        300 شجرة تصوّت معاً — الفائز
#   LightGBM / XGBoost   نماذج gradient boosting قوية
# المطر نادر (~1.7% من الساعات)، لذلك كل نموذج يعطي وزناً أكبر لحالات المطر:
#   class_weight="balanced" / "balanced_subsample" أو scale_pos_weight = (عدد الحالات الجافة / عدد حالات المطر).
#   بدون ذلك يتعلم النموذج أن يقول "جاف" دائماً.
# min_samples_leaf / min_child_samples: حد أدنى للعينات في كل ورقة لتقليل الحفظ (overfitting).
# random_state=0: نتائج قابلة للتكرار في كل تشغيل.
def candidates(pos_weight: float):
    return {
        "Logistic Regression": make_pipeline(StandardScaler(), LogisticRegression(max_iter=2000, class_weight="balanced")),
        "Decision Tree": DecisionTreeClassifier(max_depth=6, min_samples_leaf=50, class_weight="balanced", random_state=0),
        "Random Forest": RandomForestClassifier(n_estimators=300, min_samples_leaf=20, class_weight="balanced_subsample",
                                                n_jobs=-1, random_state=0),
        "LightGBM": lgb.LGBMClassifier(n_estimators=400, learning_rate=0.03, num_leaves=31, min_child_samples=50,
                                       subsample=0.8, subsample_freq=1, colsample_bytree=0.8,
                                       scale_pos_weight=pos_weight, random_state=0, verbose=-1),
        "XGBoost": XGBClassifier(n_estimators=400, learning_rate=0.03, max_depth=5, subsample=0.8, colsample_bytree=0.8,
                                 min_child_weight=5, scale_pos_weight=pos_weight, eval_metric="aucpr",
                                 random_state=0, n_jobs=-1),
    }


# metrics: حساب مقاييس الأداء لاحتمالات p مقابل الحقيقة y، مع تحويل الاحتمال إلى قرار عند العتبة thr.
#   pr_auc    المقياس الرئيسي: مساحة منحنى Precision-Recall. التخمين العشوائي يساوي تقريباً نسبة المطر (base rate).
#   roc_auc   مقياس ترتيب عام، لكنه متفائل عندما تكون الفئة الإيجابية نادرة.
#   precision من التنبيهات بالمطر، كم منها صحيح؟   recall: من حالات المطر الفعلية، كم منها تم التنبيه له؟
#   f1        الوسط التوافقي بين precision و recall.
#   accuracy  محسوبة للمقارنة فقط وهي مضللة: نسبة المطر ≈ 1.7%، فنموذج "جاف دائماً" يحصل على ~98%.
#   confusion مصفوفة الالتباس: tn صحيح جاف، fp إنذار كاذب، fn مطر فائت، tp مطر متوقع بشكل صحيح.
def metrics(y, p, thr):
    pred = (p >= thr).astype(int)
    tn, fp, fn, tp = confusion_matrix(y, pred, labels=[0, 1]).ravel()
    return {
        "pr_auc": round(float(average_precision_score(y, p)), 4),
        "roc_auc": round(float(roc_auc_score(y, p)), 4),
        "precision": round(float(precision_score(y, pred, zero_division=0)), 4),
        "recall": round(float(recall_score(y, pred, zero_division=0)), 4),
        "f1": round(float(f1_score(y, pred, zero_division=0)), 4),
        "accuracy": round(float((pred == y).mean()), 4),
        "confusion": {"tn": int(tn), "fp": int(fp), "fn": int(fn), "tp": int(tp)},
        "base_rate": round(float(y.mean()), 4),
    }


# onset_recall: من بين "بدايات المطر" (مطر يبدأ بعد ≥ 6 ساعات جافة)، كم منها سبقه تنبيه في الساعات الثلاث قبله؟
# لماذا هذا المقياس؟ recall العادي يحسب كل ساعة ممطرة، بينما المهم للري هو التنبيه قبل أن يبدأ المطر
# (لحظة اتخاذ قرار تأجيل الري). هذا هو المقياس الذي أظهر تفوق أفق 3 ساعات (43%).
def onset_recall(df, prob, thr, start, end):
    """Of rain onsets (after >= 6 dry hours), how many were flagged in the 3 hours before?"""
    rain = df["precip_mm"] >= RAIN_MM
    sub = rain[start:end]
    # بداية مطر = ساعة ممطرة سبقتها ساعة جافة، ولا مطر في الساعات من t−6 إلى t−1
    onsets = [t for t in sub.index[sub & ~sub.shift(1, fill_value=False)]
              if not rain[t - pd.Timedelta(hours=6): t - pd.Timedelta(hours=1)].any()]
    hit = 0
    for t in onsets:
        # نافذة التنبيه: من t−3 إلى t−1؛ يُحسب "تنبيه" إذا تجاوز الاحتمال العتبة في أي ساعة منها
        w = prob[t - pd.Timedelta(hours=HORIZON_H): t - pd.Timedelta(hours=1)]
        hit += int((w >= thr).any())
    return {"onsets": len(onsets), "warned": hit, "rate": round(hit / max(len(onsets), 1), 3)}


# irrigation_backtest: محاكاة الري على فترة الاختبار لقياس الفائدة العملية (وليس فقط المقاييس الإحصائية).
# - موعدان ثابتان للري يومياً (06:00 و 18:00 بتوقيت الرياض). نظام المؤقّت (timer) العادي يروي في كل موعد.
# - سَقاي يؤجل الموعد عندما p ≥ thr. التأجيل "مؤكَّد" إذا هطل المطر فعلاً خلال 3 ساعات.
# - المطر الذي يهطل أثناء الري يتعامل معه حساس المطر في النظامين، لذلك الفرق الوحيد بينهما هو التنبؤ.
# المخرجات: عدد المواعيد، المؤجلة، المؤكدة، التأجيلات الكاذبة (كلفتها تأخير ≤ 3 ساعات فقط)،
#           والمواعيد التي تلاها مطر ولم تؤجَّل (حساس المطر ما زال يحمي فيها).
def irrigation_backtest(df, prob, thr, start, end):
    """
    Two fixed irrigation slots per day (06:00, 18:00 Riyadh). A timer system waters at every slot.
    SAQAI defers a slot when p >= thr. A deferral is 'confirmed' if rain actually fell within 3 h.
    Rain that falls while watering is handled by the sensor in both systems, so only forecasting differs.
    """
    idx = prob[start:end].index
    slots = idx[(idx.hour.isin([6, 18])) & (idx.minute == 0)]   # مواعيد الري ضمن فترة الاختبار
    rain_next = make_target(df)   # الحقيقة: هل أمطرت خلال 3 ساعات بعد كل موعد؟
    deferred = [t for t in slots if prob.get(t, 0) >= thr]
    confirmed = [t for t in deferred if rain_next.get(t, 0) == 1]
    missed = [t for t in slots if prob.get(t, 0) < thr and rain_next.get(t, 0) == 1]
    return {"slots": len(slots), "deferred": len(deferred), "confirmed": len(confirmed),
            "false_deferrals": len(deferred) - len(confirmed), "rain_slots_not_deferred": len(missed)}


# main: تنفيذ المسار الكامل من البيانات الخام إلى النموذج المحفوظ والتقرير.
def main():
    t0 = time.time()
    # الخطوة 1–3: البيانات، الـ features (نفس دالة الخدمة)، والهدف
    df = load()
    X_all = build_features(df)
    y_all = make_target(df)
    raining_now = df["precip_mm"] >= RAIN_MM
    # مهمة النموذج: "هل ستمطر قريباً، علماً أن الجو جاف الآن؟". أثناء المطر يتولى قفل حساس المطر (sensor lockout)
    # التحكم، لذلك تُستبعد هذه الصفوف (كانت ستعلّم النموذج "الاستمرارية": إذا كانت تمطر فستستمر — وليس التنبؤ).
    # تُستبعد أيضاً الصفوف التي فيها NaN (أول 3 ساعات بلا تاريخ كافٍ، وآخر الساعات بلا مستقبل كامل).
    usable = X_all.notna().all(axis=1) & y_all.notna() & ~raining_now
    X, y = X_all[usable], y_all[usable].astype(int)

    # الخطوة 4: التقسيم الزمني حسب التواريخ في SPLITS، وطباعة حجم كل جزء ونسبة المطر فيه
    part = {k: (X[a:b], y[a:b]) for k, (a, b) in SPLITS.items()}
    for k, (xx, yy) in part.items():
        print(f"{k:7s} {len(xx):6d} rows  positives {yy.mean():.3%}")

    Xtr, ytr = part["train"]
    # وزن حالات المطر = عدد الحالات الجافة / عدد حالات المطر (لـ LightGBM و XGBoost)؛ max(...,1) يمنع القسمة على صفر
    pos_weight = float((ytr == 0).sum() / max((ytr == 1).sum(), 1))
    # بيانات التحقق (validation) لاختيار النموذج = 2023 + 2024 H1 معاً (فترة أطول = عدد أكبر من حالات المطر النادرة)
    Xva = pd.concat([part["calib"][0], part["thresh"][0]])
    yva = pd.concat([part["calib"][1], part["thresh"][1]])

    # الخطوة 5: تدريب المرشحين الخمسة على 2015–2022 وتقييمهم على بيانات التحقق
    results = {}
    fitted = {}
    for name, model in candidates(pos_weight).items():
        s = time.time()
        model.fit(Xtr, ytr)
        p = model.predict_proba(Xva)[:, 1]
        results[name] = {"val_pr_auc": round(float(average_precision_score(yva, p)), 4),
                         "val_roc_auc": round(float(roc_auc_score(yva, p)), 4),
                         "seconds": round(time.time() - s, 1)}
        fitted[name] = model
        print(f"{name:20s} val PR-AUC {results[name]['val_pr_auc']:.4f}  ROC-AUC {results[name]['val_roc_auc']:.4f}")

    # اختيار الأفضل حسب PR-AUC وليس accuracy: المطر نادر (~1.7%) فالـ accuracy مضللة،
    # بينما PR-AUC يقيس مدى جودة اكتشاف حالات المطر النادرة نفسها. النتيجة: Random Forest
    best = max(results, key=lambda n: results[n]["val_pr_auc"])
    print("best:", best)

    # الخطوة 6: المعايرة على 2023 حتى يتصرف الرقم المعروض كـ "احتمال" كاحتمال حقيقي فعلاً.
    # النموذج الأساسي لا يُعاد تدريبه؛ تُتعلَّم فقط دالة isotonic فوق مخرجاته (بحد أقصى 0.95).
    base = fitted[best]
    calibrated = IsotonicCalibrated(base).fit(*part["calib"])

    # الخطوة 7: اختيار الـ threshold على 2024 H1 بتعظيم F1 لفئة المطر.
    # تُستخدم فترة منفصلة عن المعايرة وعن الاختبار حتى لا يُضبط الـ threshold على نفس البيانات التي يُقاس عليها.
    # precision_recall_curve يجرب كل العتبات الممكنة، ويُحسب F1 لكل منها ثم يُختار الأعلى → 0.1067.
    # (عتبة منخفضة لأن المطر نادر: احتمال ~10% أعلى بكثير من المعتاد 1.7% ويستحق تأجيل الري.)
    Xth, yth = part["thresh"]
    pth = calibrated.predict_proba(Xth)[:, 1]
    prec, rec, thr = precision_recall_curve(yth, pth)
    f1 = 2 * prec * rec / np.clip(prec + rec, 1e-9, None)   # clip يمنع القسمة على صفر
    k = int(np.nanargmax(f1[:-1]))   # [:-1] لأن آخر نقطة في المنحنى ليس لها threshold مقابل
    threshold = float(round(thr[k], 4))
    print(f"threshold {threshold}  (val F1 {f1[k]:.3f})")

    # الخطوة 8: فترة الاختبار النهائية التي لم تُلمس (2024-07 → النهاية)؛ أرقامها هي الأرقام الصادقة للنموذج.
    Xte, yte = part["test"]
    pte = calibrated.predict_proba(Xte)[:, 1]
    test = metrics(yte.to_numpy(), pte, threshold)
    # خط أساس "جاف دائماً" (احتمال صفر دائماً): يوضح لماذا الـ accuracy مضللة (يحصل على accuracy عالية جداً)
    always_dry = metrics(yte.to_numpy(), np.zeros(len(yte)), 0.5)

    # احتمالات لكل الساعات (بما فيها ساعات المطر) لاستخدامها في onset recall ومحاكاة الري، لأنهما يحتاجان
    # سلسلة زمنية متصلة؛ الساعات التي ينقصها تاريخ تبقى NaN.
    prob_all = pd.Series(np.nan, index=X_all.index)
    ok = X_all.notna().all(axis=1)
    prob_all[ok] = calibrated.predict_proba(X_all[ok])[:, 1]
    onset = onset_recall(df, prob_all, threshold, *SPLITS["test"])
    backtest = irrigation_backtest(df, prob_all, threshold, *SPLITS["test"])
    print("test", json.dumps(test))
    print("onsets", onset, "backtest", backtest)

    # أهمية الـ features (للتقرير): أي القراءات اعتمد عليها النموذج أكثر؟
    # - النماذج الشجرية (Random Forest وغيرها) لها feature_importances_ وتُحوَّل إلى نسب مجموعها 1.
    # - النموذج الخطي له coef_ وتُؤخذ القيمة المطلقة للمعاملات.
    # - إذا كان النموذج pipeline (مثل Logistic Regression مع StandardScaler) يُؤخذ آخر خطوة فيه.
    importance = None
    est = base[-1] if hasattr(base, "steps") else base
    if hasattr(est, "feature_importances_"):
        imp = est.feature_importances_
        importance = sorted(zip(FEATURES, (imp / imp.sum()).round(4).tolist()), key=lambda x: -x[1])
    elif hasattr(est, "coef_"):
        importance = sorted(zip(FEATURES, np.abs(est.coef_[0]).round(4).tolist()), key=lambda x: -x[1])

    # الخطوة 9: الحفظ
    MODELS.mkdir(parents=True, exist_ok=True)
    REPORTS.mkdir(parents=True, exist_ok=True)
    medians = Xtr.median().to_dict()   # نقطة مرجعية ("الجو المعتاد") لتفسير كل طلب في explain.py: "ما الذي حرّك التوقع"
    # ملف joblib يحتوي النموذج المعايَر + قائمة الـ features + الوسيطات؛ هذا ما تحمّله الخدمة عند التشغيل
    joblib.dump({"model": calibrated, "features": FEATURES, "medians": medians}, MODELS / f"{VERSION}.joblib")
    # البيانات الوصفية (metadata) بصيغة JSON: الخوارزمية، الأفق، الـ threshold، النتائج... تعرضها الخدمة في /model
    meta = {
        "model_version": VERSION,
        "algorithm": best,
        "horizon_hours": HORIZON_H,
        "rain_threshold_mm": RAIN_MM,
        "threshold": threshold,
        "features": FEATURES,
        "trained_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "data": {"source": DATA.name, "rows": int(len(df)), "from": str(df.index.min()), "to": str(df.index.max())},
        "splits": SPLITS,
        "selection": results,
        "test": test,
        "test_always_dry_baseline": always_dry,
        "onset_recall_test": onset,
        "irrigation_backtest_test": backtest,
        "feature_importance": importance,
        "notes": "Trained only on rows where it is not raining at t. Probabilities isotonic-calibrated on 2023.",
    }
    (MODELS / f"{VERSION}.json").write_text(json.dumps(meta, indent=2, ensure_ascii=False))
    write_report(meta)
    print(f"done in {time.time() - t0:.0f}s")


# write_report: كتابة "بطاقة النموذج" (model card) بصيغة Markdown في ai/reports/rain_model_v1.md
# من البيانات الوصفية m: السؤال، الخوارزمية، التقسيم الزمني، مقارنة المرشحين، نتائج الاختبار،
# onset recall، محاكاة الري، أهم الـ features، وحدود النموذج.
# (القالب أدناه نص يُكتب في التقرير كما هو، وليس تعليقاً.)
def write_report(m):
    t = m["test"]
    c = t["confusion"]
    rows = "\n".join(f"| {n} | {r['val_pr_auc']:.3f} | {r['val_roc_auc']:.3f} |" for n, r in m["selection"].items())
    # أسطر الجداول تُبنى مسبقاً: صف لكل نموذج مرشح، وأهم 8 features
    imp = "\n".join(f"| {f} | {v:.3f} |" for f, v in (m["feature_importance"] or [])[:8])
    o, b = m["onset_recall_test"], m["irrigation_backtest_test"]
    md = f"""# {m['model_version']} — model card

**Question answered:** will it rain (≥ {m['rain_threshold_mm']} mm) in the next **{m['horizon_hours']} hours**, given it is dry now?
**Algorithm:** {m['algorithm']} (isotonic-calibrated) · **Decision threshold:** {m['threshold']}
**Data:** {m['data']['rows']:,} hourly rows, {m['data']['from'][:10]} → {m['data']['to'][:10]} (training only, never a runtime input)

## Time-ordered split (no random shuffling)

| Part | Period | Use |
|---|---|---|
| train | {m['splits']['train'][0]} → {m['splits']['train'][1][:10]} | fit the 5 candidates |
| calib | {m['splits']['calib'][0]} → {m['splits']['calib'][1][:10]} | model selection + probability calibration |
| thresh | {m['splits']['thresh'][0]} → {m['splits']['thresh'][1][:10]} | model selection + threshold |
| test | {m['splits']['test'][0]} → end | final numbers below, touched once |

## Candidates (validation 2023 → 2024 H1)

| Model | PR-AUC | ROC-AUC |
|---|---|---|
{rows}

## Test results (2024 H2 → 2026, never seen during training)

| Metric | Value |
|---|---|
| PR-AUC | {t['pr_auc']} (random guessing ≈ base rate {t['base_rate']}) |
| ROC-AUC | {t['roc_auc']} |
| Precision (rain class) | {t['precision']} |
| Recall (rain class) | {t['recall']} |
| F1 (rain class) | {t['f1']} |
| Accuracy | {t['accuracy']} — an "always dry" model scores {m['test_always_dry_baseline']['accuracy']}, which is why accuracy is not used |

Confusion matrix: TN {c['tn']} · FP {c['fp']} · FN {c['fn']} · TP {c['tp']}

**Rain onsets warned in the 3 h before they started:** {o['warned']} of {o['onsets']} ({o['rate']:.0%})

## Irrigation backtest (test period, two daily slots 06:00 / 18:00)

| | |
|---|---|
| Irrigation slots | {b['slots']} |
| Deferred by SAQAI | {b['deferred']} |
| Deferrals confirmed by rain within 3 h | {b['confirmed']} |
| Deferrals where rain did not come (cost: ≤ 3 h delay) | {b['false_deferrals']} |
| Slots followed by rain that were not deferred (sensor lockout still protects) | {b['rain_slots_not_deferred']} |

## Most influential features

| Feature | Weight |
|---|---|
{imp}

## Limits

- Labels come from historical gridded weather data, not from this station; v2 will be recalibrated on the station's own readings.
- Rain is rare (base rate {t['base_rate']:.1%}), so the model will miss some events. The rain sensor lockout is the safety layer, not the model.
"""
    (REPORTS / f"{m['model_version']}.md").write_text(md)


# التشغيل المباشر للملف يبدأ التدريب الكامل
if __name__ == "__main__":
    main()
