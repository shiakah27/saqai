# =====================================================================================================
# explain.py — تفسير كل تنبؤ على حدة: "ما الذي حرّك التوقع؟" (what moved the forecast)
# =====================================================================================================
# مكان الملف في المسار (pipeline):
#   تستدعيه خدمة FastAPI (service/main.py) بعد كل تنبؤ في /predict، وتُرسل النتيجة في الحقل "drivers"
#   لتعرضها لوحة التحكم، مثلاً: "الرطوبة رفعت الاحتمال، والضغط المنخفض رفعه أيضاً".
#
# الطريقة: local sensitivity (حساسية محلية):
#   - تُعاد feature واحدة (أو مجموعة لا معنى لها إلا معاً، مثل feature ساعة اليوم hour_sin و hour_cos)
#     إلى قيمتها "المعتادة" في بيانات التدريب (الوسيط median)، مع إبقاء باقي الـ features كما هي.
#   - يُعاد حساب الاحتمال ويُقاس كم تغيّر.
#   - مساهمة موجبة (contribution > 0) = هذه القراءة دفعت الاحتمال إلى الأعلى.
#     مساهمة سالبة = هذه القراءة خفضت الاحتمال.
#   هذه طريقة بسيطة وسريعة ومفهومة، لكنها تقريبية (لا تأخذ التفاعل بين الـ features بالكامل كما تفعل SHAP).
# (النص الإنجليزي التالي هو الـ docstring الأصلي ويحمل المعلومات نفسها.)
"""Per-prediction explanation used by the AI service ("what moved the forecast").

Local sensitivity: reset one feature (or a group that only makes sense together, like the two
hour-of-day features) to its typical training value and measure how much the probability changes.
Positive contribution = this reading pushed the probability UP.
"""
import pandas as pd

from features import FEATURES

# مجموعات تُعامل كوحدة واحدة: sin و cos معاً يمثلان وقتاً واحداً، وتغيير أحدهما فقط ينتج "وقتاً" غير حقيقي.
GROUPS = {"hour": ["hour_sin", "hour_cos"], "season": ["doy_sin", "doy_cos"]}


# explain: تُرجع أهم `top` عوامل (افتراضياً 4) أثّرت على هذا التنبؤ، مرتبة حسب حجم التأثير.
# المدخلات:
#   model   النموذج المعايَر (نفس المستخدم في التنبؤ)
#   medians وسيط كل feature في بيانات التدريب (2015–2022)، محفوظ داخل ملف النموذج = "الجو المعتاد"
#   x       الـ features الحالية (صف واحد)
#   p       الاحتمال الحالي المحسوب مسبقاً لـ x
# المخرجات: قائمة من {feature: الاسم، value: القيمة الحالية (للمجموعات None)، contribution: p − p2}.
def explain(model, medians: pd.Series, x: pd.Series, p: float, top: int = 4) -> list[dict]:
    # تجهيز المجموعات: hour و season كمجموعات، وكل feature أخرى مجموعة من عنصر واحد
    groups = dict(GROUPS)
    for f in FEATURES:
        if not any(f in g for g in GROUPS.values()):
            groups[f] = [f]
    rows = []
    for name, cols in groups.items():
        # نسخة من القراءة الحالية مع إعادة هذه الـ feature (أو المجموعة) فقط إلى قيمتها المعتادة
        x2 = x.copy()
        x2[cols] = medians[cols]
        # الاحتمال لو كانت هذه الـ feature "عادية" (نفس ترتيب الأعمدة الذي تدرّب عليه النموذج)
        p2 = float(model.predict_proba(x2.to_frame().T[FEATURES])[0, 1])
        # القيمة المعروضة: للـ feature المفردة قيمتها الحالية؛ لمجموعات sin/cos لا توجد قيمة واحدة مفهومة
        value = float(x[cols[0]]) if len(cols) == 1 else None
        # المساهمة = الاحتمال الحقيقي − الاحتمال لو كانت الـ feature عادية
        rows.append({"feature": name, "value": None if value is None else round(value, 2), "contribution": round(p - p2, 4)})
    # الترتيب حسب القيمة المطلقة: الأكثر تأثيراً أولاً، سواء رفع الاحتمال أو خفضه
    rows.sort(key=lambda r: -abs(r["contribution"]))
    return rows[:top]
