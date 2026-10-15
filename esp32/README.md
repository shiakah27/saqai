# ESP32 firmware

| Sketch | Board | What it does |
|---|---|---|
| `sensor_node/` | ESP32 #1 | BME280 + MH-RD rain plate (AO on GPIO35, DO on GPIO16) + 3 capacitive soil sensors. One frame every **2 s** → `POST /api/readings`. Rain plate read every 1 s (AO → level 0..3, DO as a second opinion); on a debounced change → `POST /api/rain-event` immediately (retried every 1 s). |
| `actuator_node/` | ESP32 #2 | Pump + 3 valves via relays. Polls `GET /api/actuator/inputs` every **1 s**, runs the decision engine (`saqai_decision.h`) **on the board**, picks the single neediest zone, opens only its valve, reports decisions and runs. |

Both compile with **0 errors and 0 warnings** on `esp32:esp32:esp32` (ESP32 Dev Module), arduino-esp32 core **3.0.7**,
Adafruit BME280 2.2.4, Adafruit Unified Sensor 1.1.14, Adafruit BusIO 1.16.1, ArduinoJson 7.2.1
(sensor_node ≈82 % flash, actuator_node ≈81 %, 14 % RAM each).

## The decision engine on ESP32 #2

`actuator_node/saqai_decision.h` is header-only C++ with no Arduino dependency, so the exact same code is
unit-tested on the laptop:

```bash
cd backend && npm run test:firmware      # 35 passed, 0 failed
```

For every zone it walks a fixed ladder and records each step (trace):
SAFETY → SENSOR → NEED → SOAK → PULSES → DAILY → CRITICAL → FORECAST → BELOW_TARGET / CLOSED_LOOP_PULSE,
giving `IRRIGATE`, `DEFER`, `SKIP` or `HOLD`. Then `chooseZone()` keeps only the `IRRIGATE` zone with the highest
urgency (deficit below target; critical dryness ranks first). **One valve at a time** — the others show
"ينتظر دوره" on the dashboard and get their turn after the soak time.

## Local safety on ESP32 #2 (independent of the backend)

A run stops immediately on: rain now or RAIN_LOCKOUT · 3 failed polls (backend/Wi-Fi gone) · sensors stale ·
safety state · the backend revoking the run · soil reached target + 2 % · 60 s local hard limit (`LOCAL_MAX_ON_S`).
Pump always turns OFF before valves close; valve opens 300 ms before the pump. The run is reported as *started*
**before** the valve opens, so a backend refusal means no water at all. Watchdog on both boards.

## Setup

1. Arduino IDE 2 → Boards Manager → **esp32 by Espressif Systems** (3.x).
2. Library Manager → **Adafruit BME280 Library** (accept dependencies) and **ArduinoJson** (v7).
3. In each sketch folder: copy `secrets.example.h` → `secrets.h`, fill Wi-Fi, `BACKEND_URL` (the address the
   backend prints at start, never `localhost`) and `DEVICE_API_KEY` (same as `backend/.env`).
4. Tools → Board → **ESP32 Dev Module**, choose the port, Upload (hold **BOOT** if it stays on `Connecting....`).
5. Serial Monitor at **115200** — expected output and fixes: `docs/bring-up.md`.

Wiring, power and protection: `docs/hardware.md`. Sensor calibration: `docs/calibration.md`.
