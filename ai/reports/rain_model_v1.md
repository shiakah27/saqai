# rain_model_v1 — model card

**Question answered:** will it rain (≥ 0.1 mm) in the next **3 hours**, given it is dry now?
**Algorithm:** Random Forest (isotonic-calibrated) · **Decision threshold:** 0.08
**Data:** 102,864 hourly rows, 2015-01-01 → 2026-09-25 (training only, never a runtime input)

## Time-ordered split (no random shuffling)

| Part | Period | Use |
|---|---|---|
| train | 2015-01-01 → 2022-12-31 | fit the 5 candidates |
| calib | 2023-01-01 → 2023-12-31 | model selection + probability calibration |
| thresh | 2024-01-01 → 2024-06-30 | model selection + threshold |
| test | 2024-07-01 → end | final numbers below, touched once |

## Candidates (validation 2023 → 2024 H1)

| Model | PR-AUC | ROC-AUC |
|---|---|---|
| Logistic Regression | 0.148 | 0.873 |
| Decision Tree | 0.116 | 0.854 |
| Random Forest | 0.197 | 0.890 |
| LightGBM | 0.171 | 0.880 |
| XGBoost | 0.196 | 0.885 |

## Test results (2024 H2 → 2026, never seen during training)

| Metric | Value |
|---|---|
| PR-AUC | 0.1721 (random guessing ≈ base rate 0.017) |
| ROC-AUC | 0.929 |
| Precision (rain class) | 0.1962 |
| Recall (rain class) | 0.5879 |
| F1 (rain class) | 0.2942 |
| Accuracy | 0.9519 — an "always dry" model scores 0.983, which is why accuracy is not used |

Confusion matrix: TN 18236 · FP 795 · FN 136 · TP 194

**Rain onsets warned in the 3 h before they started:** 48 of 77 (62%)

## Irrigation backtest (test period, two daily slots 06:00 / 18:00)

| | |
|---|---|
| Irrigation slots | 1634 |
| Deferred by SAQAI | 80 |
| Deferrals confirmed by rain within 3 h | 18 |
| Deferrals where rain did not come (cost: ≤ 3 h delay) | 62 |
| Slots followed by rain that were not deferred (sensor lockout still protects) | 19 |

## Most influential features

| Feature | Weight |
|---|---|
| dewpoint | 0.178 |
| doy_sin | 0.145 |
| humidity | 0.122 |
| dewpoint_depression | 0.101 |
| doy_cos | 0.083 |
| temperature | 0.066 |
| pressure | 0.066 |
| dt_3h | 0.060 |

## Limits

- Labels come from historical gridded weather data, not from this station; v2 will be recalibrated on the station's own readings.
- Rain is rare (base rate 1.7%), so the model will miss some events. The rain sensor lockout is the safety layer, not the model.

## Threshold choice

Decision threshold **0.08** (F1-optimal on 2024 H1 was 0.1067). Chosen by error cost, not by F1: a false deferral delays watering ≤ 3 h (critical dryness is never deferred), a missed rain wastes water. Same precision as the F1 threshold, much higher recall.

## Calibration check (test period)

| Predicted range | Hours | Mean predicted | Actual rain rate |
|---|---|---|---|
| 0–0.02 | 15240 | 0.002 | 0.002 |
| 0.02–0.05 | 2022 | 0.04 | 0.028 |
| 0.05–0.08 | 1110 | 0.07 | 0.045 |
| 0.08–0.2 | 542 | 0.116 | 0.179 |
| 0.2–0.4 | 383 | 0.238 | 0.196 |
| 0.4–1.01 | 64 | 0.578 | 0.344 |

Close at low probabilities (where almost all hours are). Around the threshold the real rain rate is a little higher than shown; at the top (above 0.2) the model is over-confident and the real rate is lower than shown. The decision only compares against the threshold, so it is unaffected, but the percentage on the dashboard is approximate, not exact.

## Simple baselines (tuned on 2024 H1, tested on the same test period)

| Method | Precision | Recall | F1 | Rain onsets warned | Deferrals without rain |
|---|---|---|---|---|---|
| Climatology (month × hour) | 0.035 | 0.03 | 0.032 | 3/77 | 0 |
| Humidity ≥ 55% | 0.137 | 0.412 | 0.205 | 33/77 | 98 |
| Humidity ≥ 50% and pressure change ≤ 0 hPa/3 h | 0.137 | 0.242 | 0.175 | 24/77 | 19 |
| Model (F1 threshold 0.1067) | 0.201 | 0.33 | 0.25 | 33/77 | 34 |
| Model (chosen threshold 0.08) | 0.196 | 0.588 | 0.294 | 48/77 | 58 |
