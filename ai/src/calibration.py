# =====================================================================================================
# calibration.py — معايرة الاحتمالات (probability calibration) بطريقة isotonic فوق مصنّف مدرَّب
# =====================================================================================================
# مكان الملف في المسار (pipeline):
#   train.py يدرّب النموذج الفائز (Random Forest) على بيانات 2015–2022، ثم يغلّفه بهذا الصنف ويعايره
#   على بيانات 2023. الكائن الناتج (النموذج + المعايرة) يُحفظ داخل ملف النموذج rain_model_v1.joblib.
#
# لماذا المعايرة؟
#   مخرجات Random Forest (خصوصاً مع class_weight="balanced_subsample") هي "درجة" وليست احتمالاً حقيقياً:
#   قد يقول 0.6 بينما تمطر فعلياً في 10% فقط من هذه الحالات. المعايرة تتعلم دالة تحوّل الدرجة إلى احتمال
#   واقعي، بحيث أن "30%" تعني فعلاً أنها تمطر في نحو 30% من الحالات المشابهة.
#   isotonic regression = دالة متزايدة على شكل درجات (لا تفترض شكلاً معيناً مثل المنحنى S)، فتحافظ على
#   ترتيب الحالات وتصحح القيم فقط.
#
# لماذا كُتبت يدوياً بدلاً من CalibratedClassifierCV؟
#   حتى تتصرف بالشكل نفسه على أي إصدار من scikit-learn قد يكون مثبتاً عند أعضاء الفريق.
#   ولأنها محفوظة داخل ملف النموذج، يجب أن تستورد الخدمة (service/main.py) هذا الملف حتى يمكن فك
#   الحفظ (unpickle).
# (النص الإنجليزي التالي هو الـ docstring الأصلي ويحمل المعلومات نفسها.)
"""Isotonic probability calibration on top of a fitted classifier.

Written by hand (instead of CalibratedClassifierCV) so it behaves the same on every scikit-learn
version the team might have installed. Saved inside the model file, so the AI service imports it.
"""
import numpy as np
from sklearn.isotonic import IsotonicRegression


# IsotonicCalibrated: غلاف (wrapper) حول نموذج مدرَّب مسبقاً (base).
# يوفر الواجهة نفسها لنماذج scikit-learn (fit / predict_proba) حتى يمكن استخدامه في كل مكان بدل النموذج الأصلي.
class IsotonicCalibrated:
    # __init__: يحفظ النموذج الأساسي (لا يُعاد تدريبه هنا) ويُنشئ دالة isotonic فارغة.
    # out_of_bounds="clip": أي درجة خارج المدى الذي شوهد أثناء المعايرة تُقصّ إلى أقرب حد بدل الخطأ.
    def __init__(self, base):
        self.base = base
        # الحد الأقصى 0.95: المطر ليس مؤكداً أبداً، ولا يجب أن تدّعي لوحة التحكم (dashboard) أنه مؤكد
        self.iso = IsotonicRegression(out_of_bounds="clip", y_min=0.0, y_max=0.95)

    # fit: يتعلم دالة المعايرة على بيانات منفصلة (2023) لم يتدرب عليها النموذج الأساسي.
    # المدخل: درجة النموذج لفئة "مطر" (العمود 1)، والهدف: هل أمطرت فعلاً (0/1).
    # استخدام بيانات منفصلة ضروري: على بيانات التدريب نفسها يبدو النموذج أكثر ثقة مما هو عليه في الواقع.
    def fit(self, X, y):
        self.iso.fit(self.base.predict_proba(X)[:, 1], np.asarray(y))
        return self

    # predict_proba: درجة النموذج الأساسي ← دالة isotonic ← احتمال معايَر p.
    # يُرجع عمودين [احتمال عدم المطر، احتمال المطر] = [1 − p, p] بنفس صيغة scikit-learn.
    def predict_proba(self, X):
        p = self.iso.predict(self.base.predict_proba(X)[:, 1])
        return np.column_stack([1 - p, p])
