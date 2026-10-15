# API

Every request and response is JSON. Device timestamps are ignored: the server stamps everything with its own clock.

## ESP32 #1 — sensor node (header `x-api-key`)

| Method | Path | When | Body | Response |
|---|---|---|---|---|
| POST | `/api/readings` | every 2 s | `device_id, temperature, humidity, pressure (hPa), rain_detected, rain_level?, soil: [{zone_id, soil_moisture \| null, raw_adc?}], rssi?, uptime_s?, firmware?` | 201 `{system_mode}` |
| POST | `/api/rain-event` | immediately on a debounced change | `device_id, event: RAIN_STARTED\|RAIN_STOPPED, rain_detected, rain_level?` | 201 `{accepted, system_mode, changed}` |

Pressure outside 850–1100 is rejected with "must be in hPa". A soil value outside 0–100 is stored as invalid and never used.
`rain_detected` in any frame also triggers the lockout, so a lost rain event cannot hide rain.

## ESP32 #2 — actuator node (header `x-api-key`)

### GET `/api/actuator/inputs?device_id=actuator_node_01` — every 1 s

Everything the on-board decision engine needs:

```json
{
  "server_time": "2026-10-08T09:42:49.303Z",
  "system_mode": "NORMAL | IRRIGATING | RAIN_LOCKOUT | COOLDOWN | ERROR",
  "rain_lockout": false, "cooldown": false, "error": false,
  "sensors_fresh": true, "sensor_age_s": 1.2, "rain_detected": false,
  "weather": { "temperature": 33.6, "humidity": 13, "pressure": 940.6 },
  "prediction": { "rain_probability": 0.0456, "threshold": 0.08, "horizon_hours": 3, "age_s": 828 },
  "zones": [{ "id": 1, "enabled": true, "has_reading": true, "valid": true, "soil": 23.2,
              "target": 40, "critical": 22, "seconds_per_percent": 2 }],
  "engine": { "max_defer_s": 10800, "defer_hysteresis": 0.03, "soak_s": 120, "max_pulses": 3,
              "pulse_lock_s": 1800, "followup_max_s": 10, "daily_max_s": 300, "max_s": 60,
              "pump_flow_lpm": 2.0, "forecast_trim_max": 0 },
  "active_run_id": null,
  "manual": null
}
```

`prediction` is `null` when there is none or it is older than 2.5 × the prediction interval → the engine uses soil only (`NO_FORECAST`).
`manual` is `{command_id, zone, seconds, expires_at}` when a test run from the dashboard is waiting (never during lockout or while a run is active).
`max_s` is capped again on the board at 60 s. `pump_flow_lpm` lets the board turn seconds into litres with the same measured flow as the backend. `forecast_trim_max` (0 = off) would water up to that fraction less when rain is likely but below the threshold; it is off because it was never validated on data.

### POST `/api/actuator/decisions` — on change, or every 30 s

```json
{ "device_id": "actuator_node_01", "chosen_zone": 1,
  "zones": [{ "zone_id": 1, "action": "IRRIGATE", "seconds": 37, "planned_seconds": 37,
              "liters": 1.23, "planned_liters": 1.23, "reason": "CRITICAL_DRY", "urgency": 1.46,
              "trace": [{ "step": "SAFETY", "pass": true, "note": "NORMAL" }] }] }
```
`liters` = seconds × pump flow ÷ 60 (estimate, no flow sensor); `planned_liters` is what a DEFER postponed.
→ 201 `{stored}`. Stored in `irrigation_decisions` when it changed (or every 10 min).

### POST `/api/actuator/run`

Started — sent **before** the valve opens:
```json
{ "event": "started", "device_id": "actuator_node_01", "run_id": "run_…", "zone": 1,
  "planned_seconds": 37, "reason": "CRITICAL_DRY", "command_id": "only for manual runs" }
```
→ 201 `{ok, abort}`. `abort: true` (lockout, cooldown, error, manual command no longer pending) means: do not open the valve.

Finished — sent after the pump is OFF and the valve CLOSED (validation refuses anything else); retried until accepted, idempotent:
```json
{ "event": "finished", "device_id": "actuator_node_01", "run_id": "run_…", "zone": 1,
  "status": "completed | cancelled | failed", "actual_seconds": 9.2,
  "stop_reason": "TARGET_REACHED | RAIN_OVERRIDE | BACKEND_UNREACHABLE | SENSORS_STALE | SAFETY_STATE | COMMAND_REVOKED | LOCAL_MAX_ON_TIME",
  "pump": "OFF", "valve": "CLOSED" }
```

## Dashboard (read-only)

| Path | |
|---|---|
| `GET /api/status` | everything on screen: `system, weather, prediction, model, zones[] (soil, valve, decision with chosen/urgency/trace), pump, active_run, pending_manual, runs, devices, readiness, savings, events, config` |
| `GET /api/history?hours=24` | `points` (weather, soil per zone, p, threshold, mode), `decisions`, `runs` |
| `GET /api/stream` | Server-Sent Events: `live` (every sensor frame) and `changed` (refetch `/api/status`) |
| `GET /api/prediction/latest` · `/api/system/state` · `/api/zones` · `/api/health` | |

## Admin (header `x-admin-key`, used by the maintenance panel)

| Method | Path | |
|---|---|---|
| GET | `/api/admin/check` | verify the key |
| PATCH | `/api/admin/zones/:id` | `target_moisture, critical_moisture, seconds_per_percent, enabled` |
| POST | `/api/admin/manual-run` | `{zone_id, seconds}` → a test run the actuator node picks up within 1 s (expires after 60 s, refused during rain) |
| POST | `/api/admin/predict` | run a rain prediction now |
| POST | `/api/admin/reset-error` | leave ERROR mode after fixing the cause |

## Errors

400 validation (with the field and message) · 401 wrong key · 403 unknown device · 409 conflict (e.g. manual run while raining) · 422 AI `INSUFFICIENT_HISTORY` · 5xx → the actuator node treats it as "backend unreachable".
