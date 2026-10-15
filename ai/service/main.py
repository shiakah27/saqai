# =====================================================================================================
# service/main.py — خدمة الذكاء الاصطناعي لسَقاي (SAQAI): تنبؤ لحظي (real-time inference) فقط
# =====================================================================================================
# التشغيل:
#     uvicorn main:app --app-dir ai/service --port 8000
#
# مكان الخدمة في النظام:
#   - الـ backend (Node) يرسل قراءات المحطة الحقيقية الأخيرة (آخر ~4 ساعات).
#   - الخدمة تبني الـ features بنفس الملف المستخدم في التدريب (ai/src/features.py) → لا train/serve skew،
#     ثم تشغّل النموذج المحفوظ وتُرجع احتمالاً.
#   - الخدمة لا ترى ملف CSV التاريخي أبداً، ولا تتحكم في أي عتاد (hardware). القرار عند ESP32 رقم 2:
#     يؤجل الري إذا كان الاحتمال ≥ الـ threshold (مع hysteresis، لمدة أقصاها 3 ساعات)، والجفاف الحرج
#     وحساس المطر الفعلي يتغلبان على التنبؤ.
#
# الـ endpoints:
#   GET  /health   → هل النموذج محمّل؟
#   GET  /model    → بطاقة النموذج (المقاييس، الـ threshold، الأفق) للوحة التحكم
#   POST /predict  → {rain_probability, threshold, horizon_hours, model_version, features, drivers}
#                    أو خطأ 422 INSUFFICIENT_HISTORY إذا كان التاريخ أقل من 3 ساعات
# (النص الإنجليزي التالي هو الـ docstring الأصلي ويحمل المعلومات نفسها.)
"""
SAQAI AI service — REAL-TIME inference only.

    uvicorn main:app --app-dir ai/service --port 8000

The Node backend sends the station's own recent readings (last ~4 h). This service builds the
features with the SAME module used in training (ai/src/features.py), runs the saved model and returns
a probability. It never sees the historical CSV and it never controls hardware.

Endpoints
  GET  /health   → is the model loaded?
  GET  /model    → model card (metrics, threshold, horizon) for the dashboard
  POST /predict  → {rain_probability, threshold, horizon_hours, model_version, features, drivers}
"""
from __future__ import annotations

import json
import os
import sys
from datetime import datetime
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

# جذر المشروع، وإضافة ai/src إلى مسار الاستيراد لاستخدام نفس ملفات التدريب
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "ai" / "src"))
from features import FEATURES, features_at  # noqa: E402
import calibration  # noqa: E402,F401  (needed to unpickle the calibrated model)
# ↑ استيراد calibration ضروري رغم عدم استخدامه مباشرة: النموذج المحفوظ هو كائن IsotonicCalibrated،
#   ولا يمكن فك حفظه (unpickle) إلا إذا كان الصنف معروفاً.
from explain import explain  # noqa: E402

# إصدار النموذج ومجلده قابلان للتغيير عبر متغيرات البيئة (لتجربة إصدار جديد دون تعديل الكود)
MODEL_VERSION = os.getenv("MODEL_VERSION", "rain_model_v1")
MODEL_DIR = Path(os.getenv("MODEL_DIR", ROOT / "ai" / "models"))

# تحميل النموذج مرة واحدة عند بدء الخدمة (وليس مع كل طلب) لأن التحميل بطيء نسبياً
bundle = joblib.load(MODEL_DIR / f"{MODEL_VERSION}.joblib")   # النموذج المعايَر + الوسيطات
meta = json.loads((MODEL_DIR / f"{MODEL_VERSION}.json").read_text())   # البيانات الوصفية: threshold، الأفق، النتائج
model = bundle["model"]
medians = pd.Series(bundle["medians"])   # "الجو المعتاد" من بيانات التدريب، يستخدمه explain
LOADED_AT = datetime.now().astimezone().isoformat(timespec="seconds")

app = FastAPI(title="SAQAI AI service", version=MODEL_VERSION)


# Reading: قراءة واحدة من المحطة. pydantic يرفض تلقائياً أي قيمة خارج الحدود الفيزيائية المعقولة
# (حرارة −20..60 °C، رطوبة 0..100 %، ضغط 850..1100 hPa) قبل أن تصل إلى النموذج.
# الوقت t يجب أن يحمل المنطقة الزمنية (مثل Z أو +03:00).
class Reading(BaseModel):
    t: datetime = Field(description="ISO timestamp with offset, e.g. 2026-10-10T11:30:00Z")
    temperature: float = Field(ge=-20, le=60)
    humidity: float = Field(ge=0, le=100)
    pressure: float = Field(ge=850, le=1100)


# PredictRequest: جسم طلب /predict = قائمة قراءات (واحدة على الأقل)، و at اختياري:
# اللحظة المطلوب التنبؤ عندها؛ إذا لم يُرسل تُستخدم آخر قراءة.
class PredictRequest(BaseModel):
    readings: list[Reading] = Field(min_length=1)
    at: datetime | None = None


# /health: فحص سريع أن الخدمة تعمل والنموذج محمّل (ومتى حُمّل وأي إصدار).
@app.get("/health")
def health():
    return {"status": "ok", "model_version": MODEL_VERSION, "loaded_at": LOADED_AT}


# /model: بطاقة النموذج للوحة التحكم — جزء مختار فقط من البيانات الوصفية (الخوارزمية، الأفق، الـ threshold،
# نتائج الاختبار، onset recall، محاكاة الري، ومعلومات البيانات).
@app.get("/model")
def model_card():
    keep = ["model_version", "algorithm", "horizon_hours", "threshold", "trained_at", "test",
            "onset_recall_test", "irrigation_backtest_test", "data"]
    return {k: meta[k] for k in keep}


# /predict: التنبؤ باحتمال المطر خلال الساعات الثلاث القادمة.
# الخطوات: قراءات JSON → جدول pandas بتوقيت UTC → features (نفس دالة التدريب) → احتمال معايَر → تفسير.
@app.post("/predict")
def predict(req: PredictRequest):
    df = pd.DataFrame([r.model_dump() for r in req.readings])
    df["t"] = pd.to_datetime(df["t"], utc=True)   # توحيد كل الأوقات إلى UTC
    df = df.drop_duplicates("t").set_index("t").sort_index()   # حذف المكرر وترتيب زمني
    at = pd.Timestamp(req.at).tz_convert("UTC") if req.at else df.index[-1]

    x = features_at(df, at)
    if x is None:
        # لا يوجد تاريخ حقيقي كافٍ بعد (أول ~3 ساعات بعد التشغيل، أو فجوة في القراءات). يُقال ذلك صراحة؛ لا تخمين أبداً.
        raise HTTPException(status_code=422, detail="INSUFFICIENT_HISTORY")

    # [0, 1] = احتمال فئة "مطر" للصف الوحيد؛ الأعمدة بنفس ترتيب FEATURES الذي تدرّب عليه النموذج
    p = float(model.predict_proba(x.to_frame().T[FEATURES])[0, 1])
    return {
        "rain_probability": round(p, 4),
        "threshold": meta["threshold"],   # يُرسل مع الاحتمال حتى يقارن ESP32 به (القرار ليس هنا)
        "horizon_hours": meta["horizon_hours"],
        "model_version": MODEL_VERSION,
        "features": {k: round(float(v), 3) for k, v in x.items()},   # القيم المحسوبة للعرض والتتبع
        "drivers": explain(model, medians, x, p),   # أهم العوامل التي حرّكت التوقع
    }
