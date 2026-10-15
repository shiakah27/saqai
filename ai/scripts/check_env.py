# =====================================================================================================
# check_env.py — فحص المرحلة الأولى: مكتبات Python + نظرة أولية للتأكد من سلامة البيانات التاريخية
# =====================================================================================================
# التشغيل من جذر المستودع (مع تفعيل الـ venv):
#     python ai/scripts/check_env.py
#
# هذا ليس تدريباً. يتحقق فقط من البيئة (إصدار Python والمكتبات)، ويؤكد أن ملف البيانات قابل للقراءة
# وبالشكل الذي تفترضه المراحل اللاحقة (train.py): الأعمدة، الخطوة الساعية دون فجوات، لا قيم مفقودة.
# يُرجع رمز خروج 1 إذا فشل أي فحص، و 0 إذا نجحت كلها.
# (النص الإنجليزي التالي هو الـ docstring الأصلي ويحمل المعلومات نفسها.)
"""Phase 1 check: Python packages + a first sanity look at the historical dataset.

Run from the repo root (with the venv active):
    python ai/scripts/check_env.py

This is NOT training. It only verifies the environment and confirms the
dataset is readable and shaped the way later phases assume.
"""
import importlib
import sys
from pathlib import Path

# مسار ملف البيانات والأعمدة المتوقعة فيه بالترتيب
ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "data" / "raw" / "riyadh_hourly_2015_2026.csv"
EXPECTED_COLS = ["time", "temperature", "humidity", "pressure", "precip_mm"]

failed = False   # يصبح True عند فشل أي فحص


# ok: طباعة فحص ناجح بعلامة ✔
def ok(msg):
    print(f"  ✔ {msg}")


# bad: طباعة فحص فاشل بعلامة ✘ وتسجيل الفشل
def bad(msg):
    global failed
    failed = True
    print(f"  ✘ {msg}")


print("SAQAI AI environment check\n")

# إصدار Python: مطلوب 3.10 على الأقل (الكود يستخدم صيغاً حديثة مثل datetime | None في service/main.py)
if sys.version_info >= (3, 10):
    ok(f"Python {sys.version.split()[0]}")
else:
    bad(f"Python {sys.version.split()[0]} (need >= 3.10)")

# محاولة استيراد كل مكتبة يحتاجها التدريب والخدمة، وطباعة إصدارها
for pkg in ["pandas", "numpy", "sklearn", "lightgbm", "xgboost", "joblib", "fastapi", "uvicorn"]:
    try:
        mod = importlib.import_module(pkg)
        ok(f"{pkg} {getattr(mod, '__version__', '')}")
    except Exception as e:  # noqa: BLE001
        bad(f"{pkg} not importable ({e.__class__.__name__}) — pip install -r ai/requirements.txt")

print("\nDataset check")
if not DATA.exists():
    bad(f"dataset not found at {DATA.relative_to(ROOT)}")
    sys.exit(1)

import pandas as pd  # noqa: E402

# utf-8-sig يزيل علامة BOM التي يضيفها Excel قبل اسم أول عمود
df = pd.read_csv(DATA, encoding="utf-8-sig")
cols = [c.strip() for c in df.columns]
df.columns = cols
if cols == EXPECTED_COLS:
    ok(f"columns {cols}")
else:
    bad(f"unexpected columns {cols}")

# الخطوة الزمنية: يجب أن يكون الفرق بين كل صفين متتاليين ساعة واحدة بالضبط (لا فجوات ولا تكرار)،
# لأن الـ lag features (قبل 1 و 3 ساعات) والهدف (الساعات الثلاث القادمة) تعتمد على ذلك
df["time"] = pd.to_datetime(df["time"])
gaps = df["time"].diff().dropna().value_counts()
ok(f"{len(df):,} rows, {df['time'].min()} → {df['time'].max()}")
if len(gaps) == 1 and gaps.index[0] == pd.Timedelta(hours=1):
    ok("strictly hourly, no gaps")
else:
    bad(f"irregular time steps found: {gaps.head().to_dict()}")

# القيم المفقودة
nulls = int(df.isna().sum().sum())
ok("no missing values") if nulls == 0 else bad(f"{nulls} missing values")

# نسبة ساعات المطر: صغيرة جداً، ولهذا الـ accuracy وحدها مضللة (نموذج "جاف دائماً" يبدو ممتازاً)
rain_hours = (df["precip_mm"] > 0).mean()
print(f"\n  rain hours (precip_mm > 0): {rain_hours:.2%}  ← this is why accuracy alone is misleading")
# مدى الضغط: ضغط المحطة الفعلي (station-level) وليس المعدّل إلى مستوى سطح البحر؛ في الرياض ≈ 930–955 hPa بسبب الارتفاع
print(f"  pressure range: {df['pressure'].min()}–{df['pressure'].max()} hPa (station-level, not sea-level)")

print("\nAll AI checks passed." if not failed else "\nSome checks failed.")
sys.exit(1 if failed else 0)
