"""
تغيير عتبة القرار (threshold) لنموذج المطر بدون إعادة التدريب، وتحديث بطاقة النموذج وتقريره.

    python ai/scripts/set_threshold.py 0.08

لماذا يوجد هذا الملف:
  train.py يختار العتبة بتعظيم F1 على النصف الأول من 2024 (النتيجة 0.1067). لكن في سَقاي الخطآن
  ليسا بنفس التكلفة: التأجيل بلا مطر يؤخر الري 3 ساعات كحد أقصى (والجفاف الحرج لا يُؤجَّل أبدًا)،
  بينما المطر الذي لا يُتوقع يعني ماءً يُصب ثم يأتي المطر بعده. لذلك اختار الفريق عتبة أقل (0.08)
  تلتقط مطرًا أكثر مقابل تأجيلات خاطئة أكثر. النموذج نفسه لا يتغير، فقط الحد الذي يُقارن به الاحتمال.

ما يفعله:
  1. يحمّل النموذج المدرب ويحسب احتمالاته على كل البيانات التاريخية.
  2. يعيد حساب نتائج فترة الاختبار (يوليو 2024 → النهاية) بالعتبة الجديدة.
  3. يضيف فحص المعايرة (هل 30% تعني فعلًا 30%؟) ومقارنة بقواعد بسيطة (خط أساس).
  4. يكتب ai/models/rain_model_v1.json وai/reports/rain_model_v1.md من جديد.
خدمة الذكاء الاصطناعي تقرأ العتبة من ملف json عند التشغيل، فيكفي إعادة تشغيلها.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from sklearn.metrics import average_precision_score, precision_recall_curve

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "ai" / "src"))
import train  # noqa: E402  (نفس دوال التحميل والهدف والتقييم المستخدمة في التدريب)
from features import build_features  # noqa: E402
import calibration  # noqa: E402,F401  (مطلوب لفك تخزين النموذج المعاير)


def main(new_thr: float) -> None:
    meta_path = train.MODELS / f"{train.VERSION}.json"
    meta = json.loads(meta_path.read_text())
    model = joblib.load(train.MODELS / f"{train.VERSION}.joblib")["model"]

    # نفس تجهيز train.py: الخصائص، والهدف، واستبعاد الساعات الممطرة الآن
    df = train.load()
    X_all = build_features(df)
    y_all = train.make_target(df)
    raining_now = df["precip_mm"] >= train.RAIN_MM
    ok = X_all.notna().all(axis=1)
    prob_all = pd.Series(np.nan, index=X_all.index)
    prob_all[ok] = model.predict_proba(X_all[ok])[:, 1]
    usable = ok & y_all.notna() & ~raining_now

    a, b = train.SPLITS["test"]
    yt = y_all[usable][a:b].astype(int)
    pt = prob_all[usable][a:b]

    # 1) نتائج الاختبار بالعتبة الجديدة (نفس الدوال التي استُخدمت في التدريب)
    test = train.metrics(yt.to_numpy(), pt.to_numpy(), new_thr)
    onset = train.onset_recall(df, prob_all, new_thr, a, b)
    backtest = train.irrigation_backtest(df, prob_all, new_thr, a, b)

    # 2) فحص المعايرة على فترة الاختبار: متوسط الاحتمال المتوقع مقابل نسبة المطر الفعلية في كل شريحة
    bins = [0, 0.02, 0.05, new_thr, 0.2, 0.4, 1.01]
    cut = pd.cut(pt, bins, right=False)
    calib = [{"bin": f"{lo:g}–{hi:g}", "n": int(n), "predicted": round(float(p), 3), "actual": round(float(r), 3)}
             for (lo, hi), n, p, r in zip(zip(bins[:-1], bins[1:]), yt.groupby(cut, observed=False).size(),
                                          pt.groupby(cut, observed=False).mean(), yt.groupby(cut, observed=False).mean())
             if n > 0]

    # 3) خطوط أساس بسيطة: كل قاعدة تُضبط على 2024 H1 (بيانات اختيار العتبة) ثم تُختبر على نفس فترة الاختبار
    va, vb = train.SPLITS["thresh"]
    Xu = X_all[usable]
    Xv, Xt = Xu[va:vb], Xu[a:b]
    yv = y_all[usable][va:vb].astype(int)

    def f1_of(pred, yy):
        tp = int((pred & (yy == 1)).sum()); fp = int((pred & (yy == 0)).sum()); fn = int((~pred & (yy == 1)).sum())
        return 2 * tp / max(2 * tp + fp + fn, 1)

    def evaluate(name, score_t, thr):
        pred = score_t >= thr
        tp = int((pred & (yt == 1)).sum()); fp = int((pred & (yt == 0)).sum()); fn = int((~pred & (yt == 1)).sum())
        s = pd.Series(np.nan, index=X_all.index); s.loc[score_t.index] = score_t.values
        on = train.onset_recall(df, s, thr, a, b)
        bt = train.irrigation_backtest(df, s, thr, a, b)
        return {"name": name, "precision": round(tp / max(tp + fp, 1), 3), "recall": round(tp / max(tp + fn, 1), 3),
                "f1": round(2 * tp / max(2 * tp + fp + fn, 1), 3), "onsets_warned": on["warned"],
                "onsets": on["onsets"], "false_deferrals": bt["false_deferrals"]}

    # قاعدة الرطوبة وحدها: أفضل حد رطوبة على بيانات الاختيار
    h_best = max(range(20, 96, 5), key=lambda h: f1_of(Xv["humidity"] >= h, yv))
    # قاعدة الرطوبة + نزول الضغط خلال 3 ساعات
    grid = [(h, dp) for h in (30, 40, 50, 60, 70, 80) for dp in (0, -0.5, -1, -1.5, -2)]
    h2, dp2 = max(grid, key=lambda g: f1_of((Xv["humidity"] >= g[0]) & (Xv["dp_3h"] <= g[1]), yv))
    # المتوسط التاريخي: نسبة المطر لكل (شهر، ساعة) في سنوات التدريب
    ta, tb = train.SPLITS["train"]
    ytr = y_all[usable][ta:tb].astype(int)
    clim = ytr.groupby([ytr.index.month, ytr.index.hour]).mean()
    clim_of = lambda idx: pd.Series([clim.get((t.month, t.hour), 0.0) for t in idx], index=idx)
    pr, rc, th = precision_recall_curve(yv, clim_of(Xv.index))
    f = 2 * pr * rc / np.clip(pr + rc, 1e-9, None)
    clim_thr = float(th[int(np.nanargmax(f[:-1]))])

    baselines = [
        evaluate("Climatology (month × hour)", clim_of(Xt.index), clim_thr),
        evaluate(f"Humidity ≥ {h_best}%", (Xt["humidity"] >= h_best).astype(float), 0.5),
        evaluate(f"Humidity ≥ {h2}% and pressure change ≤ {dp2} hPa/3 h",
                 ((Xt["humidity"] >= h2) & (Xt["dp_3h"] <= dp2)).astype(float), 0.5),
        evaluate(f"Model (F1 threshold {meta.get('threshold_f1_val', meta['threshold'])})", pt,
                 meta.get("threshold_f1_val", meta["threshold"])),
        evaluate(f"Model (chosen threshold {new_thr})", pt, new_thr),
    ]

    # حفظ: العتبة القديمة (المختارة بـ F1) تبقى موثقة، والجديدة هي المعتمدة
    meta.setdefault("threshold_f1_val", meta["threshold"])
    meta["threshold"] = new_thr
    meta["threshold_reason"] = ("Chosen by error cost, not by F1: a false deferral delays watering ≤ 3 h (critical "
                                "dryness is never deferred), a missed rain wastes water. Same precision as the F1 "
                                "threshold, much higher recall.")
    meta["test"] = test
    meta["onset_recall_test"] = onset
    meta["irrigation_backtest_test"] = backtest
    meta["calibration_test"] = calib
    meta["baselines_test"] = baselines
    meta_path.write_text(json.dumps(meta, indent=2, ensure_ascii=False))

    train.write_report(meta)
    extra = ["", "## Threshold choice", "",
             f"Decision threshold **{new_thr}** (F1-optimal on 2024 H1 was {meta['threshold_f1_val']}). "
             + meta["threshold_reason"], "",
             "## Calibration check (test period)", "",
             "| Predicted range | Hours | Mean predicted | Actual rain rate |", "|---|---|---|---|"]
    extra += [f"| {c['bin']} | {c['n']} | {c['predicted']} | {c['actual']} |" for c in calib]
    extra += ["", "Close at low probabilities (where almost all hours are). Around the threshold the real rain rate "
              "is a little higher than shown; at the top (above 0.2) the model is over-confident and the real rate "
              "is lower than shown. The decision only compares against the threshold, so it is unaffected, but "
              "the percentage on the dashboard is approximate, not exact.", "",
              "## Simple baselines (tuned on 2024 H1, tested on the same test period)", "",
              "| Method | Precision | Recall | F1 | Rain onsets warned | Deferrals without rain |", "|---|---|---|---|---|---|"]
    extra += [f"| {r['name']} | {r['precision']} | {r['recall']} | {r['f1']} | {r['onsets_warned']}/{r['onsets']} "
              f"| {r['false_deferrals']} |" for r in baselines]
    report = train.REPORTS / f"{train.VERSION}.md"
    report.write_text(report.read_text() + "\n".join(extra) + "\n")
    print(json.dumps({"threshold": new_thr, "test": test, "onsets": onset, "backtest": backtest}, ensure_ascii=False))


if __name__ == "__main__":
    main(float(sys.argv[1]) if len(sys.argv) > 1 else 0.08)
