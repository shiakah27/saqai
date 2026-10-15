# SAQAI Dashboard (React + Vite)

Live control room, in Arabic (RTL), light and dark themes, in the Expo 2030 Riyadh identity (deep green #003D2B + mint #2BB892, pill buttons) with the team logo (`src/components/Logo.jsx`, pixel sprout drawn cell by cell). Sensor frames arrive every 2 s over Server-Sent Events
(`/api/stream`) with a 5 s poll as fallback. It never decides anything: the irrigation decision is made on ESP32 #2
and shown here. Fonts are bundled (`@fontsource`), so it looks the same with no internet on the expo hotspot.

| Command | Result |
|---|---|
| `npm run build` | builds `dist/`; the backend serves it at `http://<laptop-ip>:3000` (normal use) |
| `npm run dev` | http://localhost:5173 with hot reload; `/api` is proxied to the backend on :3000 |

## Pages (top navigation on desktop, bottom dock on phones; hash links such as `#/zones/2`, so refresh and bookmarks work)

| Page | What it shows |
|---|---|
| الفكرة `#/story` | عرض بالتمرير لزوار المعرض: المجسّم ثابت والكاميرا تتحرك عليه (التربة، محطة الطقس، التنبؤ بالمطر، القرار على اللوحة، المطر يوقف كل شيء). الأرقام حية من النظام، ومشهد المطر توضيحي فقط (`src/pages/Story.jsx`) |
| الرئيسية `#/overview` | system readiness (until complete), a live exhibition-model view: three landscaped zones on a platform (soil colour follows moisture, label card per zone) with a cut-away of the irrigation system in front (tank, pump, three valves, riser to each zone, ESP32 control box; water flows only to the open valve), status, weather, pump card, three zone tiles, latest events |
| المناطق `#/zones/:id` | one card per zone: moisture dial (critical zone, target tick), distance to target, what ESP32 #2 is doing now, 24 h curve, target / last watering / water today. Below: the selected zone in detail with its runs |
| القرار `#/decision/:id` | irrigation queue (who is watered first and why), the rule ladder ESP32 #2 checked for the zone, decision timeline |
| الطقس والتنبؤ `#/weather` | BME280 + rain sensor tiles, AI rain probability with what moved it and the model card, 24 h weather chart |
| عمليات الري `#/runs` | today's totals, every run in the last 24 h (zone, reason, seconds, estimated litres, how it ended), soil chart |
| سجل الأحداث `#/events` | audit log with filters: rain & safety, irrigation, devices & system |
| الصيانة `#/maintenance` (مخفية من الشريط؛ تُفتح من الرابط مباشرة) | admin key → valve test runs, pump-flow calculator, seconds-per-1% calibration, raw ADC, predict now, clear error |

Code: `src/App.jsx` (top navigation, mobile dock), `src/pages/*` (one file per page), `src/components/FieldMap.jsx` (axonometric farm model with leader-line callouts),
`MoistureBand.jsx` (the 24 h moisture chart), `src/lib/zones.js` (zone state words, queue order, water today).

If the backend stops answering, the last data stays on screen and a red bar shows how old it is.
