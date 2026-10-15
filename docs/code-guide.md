# دليل الكود: وين كل شي، وكيف يمشي

هذا الملف خريطة للمشروع. كل ملف كود فيه في أوله شرح بالعربي عن وظيفته، وفوق كل دالة تعليق يقول وش تسوي وليش.
ابدأ من هنا، وبعدين افتح الملف اللي تبيه.

## الصورة الكاملة

```
 ESP32 #1 (الحساسات)                اللابتوب                              ESP32 #2 (التشغيل)
 BME280 + لوحة مطر + 3 تربة──►  Backend (Node.js)  ◄──── كل ثانية ────  تسأل: وش الوضع؟
 كل ثانيتين: POST /readings         │  يخزن في PostgreSQL                    تقرر بنفسها لكل منطقة
 مطر فوري: POST /rain-event          │  كل 30 دقيقة ► AI (Python) ► احتمال مطر   تفتح صمام واحد
                                     │  يبث للوحة (SSE)                        ترسل القرار والتشغيل
                                     ▼
                              لوحة التحكم (React)
```

قاعدة مهمة: **القرار يتخذ داخل ESP32 #2 فقط**. الـBackend يجمع ويخزن ويوصل، والـAI يعطي رقم احتمال فقط، واللوحة تعرض.

## رحلة قراءة واحدة: من الحساس إلى الصمام

1. **ESP32 #1** (`esp32/sensor_node/sensor_node.ino`) تقرأ الحساسات كل ثانيتين، وتحوّل قراءة التربة الخام (ADC) إلى نسبة مئوية بالمعايرة، وترسلها إلى `POST /api/readings`.
2. **الـBackend** (`backend/src/controllers/deviceController.js` ثم `services/readingsService.js`) يتحقق من صحتها (`models/schemas.js`)، ويبثها فورًا للوحة (`services/liveService.js`)، ويخزن صف طقس كل دقيقة وصف تربة كل 10 ثوانٍ.
3. **كل 30 دقيقة** (`services/scheduler.js` و`services/predictionService.js`) يرسل الـBackend آخر 4 ساعات من قراءات المحطة إلى خدمة الـAI (`services/aiClient.js` → `ai/service/main.py`).
4. **الـAI** (`ai/src/features.py`) يحسب 15 خاصية، والنموذج يعطي احتمال مطر خلال 3 ساعات.
5. **ESP32 #2** (`esp32/actuator_node/actuator_node.ino`) تسأل `GET /api/actuator/inputs` كل ثانية، وتستلم: التربة، الطقس، التنبؤ، حالة المطر، وإعدادات القرار.
6. **محرك القرار** (`esp32/actuator_node/saqai_decision.h`) يمشي على السلم لكل منطقة:
   الأمان ← الحساس ← الحاجة ← التشرب ← حد النبضات ← الحد اليومي ← الجفاف الحرج ← تنبؤ المطر ← ري.
   ثم `chooseZone` تختار المنطقة الأشد حاجة.
7. **ESP32 #2** تبلغ الـBackend أنها بدأت (`POST /api/actuator/run`)، ثم تفتح الصمام، ثم المضخة. وعند النهاية تطفئ المضخة أولًا، ثم الصمام، وتبلغ بالنتيجة.
8. **اللوحة** تشوف كل هذا لحظيًا عبر `GET /api/stream`.

ولو حساس المطر لمس ماء في أي لحظة: ESP32 #1 ترسل `rain-event` فورًا، والـBackend يفعّل قفل المطر (`services/rainLockout.js` و`services/safetyService.js`)، وESP32 #2 توقف الري خلال ثوانٍ.

## خريطة الملفات

### `esp32/`: الكود اللي يشتغل على اللوحتين
| الملف | وظيفته |
|---|---|
| `sensor_node/sensor_node.ino` | ESP32 #1: قراءة الحساسات وإرسالها، ومعايرة التربة (`SOIL_DRY_RAW` و`SOIL_WET_RAW`) |
| `actuator_node/actuator_node.ino` | ESP32 #2: الاتصال بالـBackend، وتشغيل المرحلات، وطبقة الأمان المحلية (حد 60 ثانية، وإيقاف عند انقطاع الاتصال) |
| `actuator_node/saqai_decision.h` | محرك القرار نفسه، بدون أي شي خاص بالأردوينو، عشان نختبره على اللابتوب |
| `*/secrets.example.h` | قالب اسم الواي فاي وعنوان الـBackend والمفتاح؛ تنسخه باسم `secrets.h` |
| `tests/test_decision.cpp` | 35 اختبار لمحرك القرار (`npm run test:firmware`) |

### `backend/`: الخادم (Node.js + Express + PostgreSQL)
| الملف | وظيفته |
|---|---|
| `src/server.js` و`src/app.js` | تشغيل الخادم، وربط المسارات، وتقديم ملفات اللوحة |
| `src/config/index.js` | كل الإعدادات من `backend/.env`، وكل قيمة مشروحة |
| `src/routes/index.js` | قائمة كل الـAPI: أجهزة، لوحة، إدارة |
| `src/models/schemas.js` | شكل كل رسالة مسموح بها؛ أي رسالة غلط ترفض برسالة واضحة |
| `src/models/index.js` | كل أوامر قاعدة البيانات (SQL) في مكان واحد |
| `src/services/readingsService.js` | استقبال القراءات وتخزينها |
| `src/services/actuatorService.js` | ما تحتاجه ESP32 #2 كل ثانية، وتسجيل قراراتها وتشغيلها |
| `src/services/rainLockout.js` و`safetyService.js` | قفل المطر وفترة الانتظار، ورفض أي تشغيل وقت القفل |
| `src/services/predictionService.js` و`aiClient.js` | طلب التنبؤ من الـAI وتخزينه |
| `src/services/scheduler.js` | مهام الخلفية كل 5 ثوانٍ: التنبؤ، وانتهاء الانتظار، وفحص الأجهزة |
| `src/services/statusService.js` | يجمع كل شي اللوحة تحتاجه في رد واحد |
| `src/services/liveService.js` | البث اللحظي للوحة (SSE) |
| `src/services/manualService.js` | أوامر الاختبار اليدوي من صفحة الصيانة |
| `database/migrations/001_init.sql` | الجداول؛ تُنشأ تلقائيًا عند أول تشغيل |
| `tools/doctor.js` | فحص شامل: `npm run doctor` |

### `ai/`: الذكاء الاصطناعي (Python)
| الملف | وظيفته |
|---|---|
| `src/features.py` | الخصائص الـ15 (نقطة الندى، تغير الضغط...)، ونفس الملف للتدريب والتشغيل |
| `src/train.py` | تدريب النموذج كاملًا: البيانات، والتقسيم الزمني، و5 نماذج، والمعايرة، والعتبة، والاختبار |
| `src/calibration.py` | تحويل مخرج النموذج إلى احتمال حقيقي (Isotonic) |
| `src/explain.py` | "وش اللي حرّك التنبؤ" في صفحة الطقس |
| `service/main.py` | خدمة FastAPI: `/predict` و`/health` و`/model` |
| `models/rain_model_v1.*` | النموذج المدرب وبطاقته |
| `reports/rain_model_v1.md` | نتائج الاختبار |

### `frontend/`: لوحة التحكم (React)
| الملف | وظيفته |
|---|---|
| `src/App.jsx` | الشريط العلوي والتنقل بين الصفحات |
| `src/hooks/useDashboard.js` | جلب البيانات والبث اللحظي |
| `src/pages/*.jsx` | صفحة لكل قسم: الرئيسية، المناطق، القرار، الطقس، الري، الأحداث |
| `src/components/FieldMap.jsx` | مجسّم المزرعة برسم محوري (axonometric): الأحواض بمقطع التربة، نظام الري، وبطاقات توضيحية بخطوط منقطة. يُستخدم في الرئيسية وصفحة الفكرة |
| `src/components/ZonePanel.jsx` و`MoistureRing.jsx` | بطاقة المنطقة ودائرة الرطوبة |
| `src/components/DecisionPath.jsx` | سلم القرار، مع ترجمة ملاحظات ESP32 #2 للعربي |
| `src/components/Maintenance.jsx` | أدوات الفريق: اختبار الصمامات، وحاسبة التدفق، والمعايرة. مخفية من الشريط، وتفتح من `#/maintenance` |
| `src/lib/zones.js` | حالة كل منطقة بالعربي (يُروى، ينتظر دوره، رطوبة كافية...) |
| `src/i18n/ar.js` | كل النصوص العربية ووصف الأحداث |
| `src/styles.css` | الألوان والتصميم، الفاتح والداكن، والجوال |
| `src/refined.css` | طبقة التصميم المصقول (إكسبو مطوّر) فوق styles.css: الشريط العلوي، والمسرح وشريط التعريف في الرئيسية، والبطاقات |
| `src/preview/` | نسخة المعاينة بقراءات مسجلة (للعرض بدون عتاد) |

## الإعدادات اللي غالبًا بتغيرها (`backend/.env`)

| الإعداد | معناه |
|---|---|
| `PUMP_FLOW_LPM` | تدفق مضختكم بعد القياس، باللتر في الدقيقة. يُرسل تلقائيًا لـESP32 #2 |
| `RAIN_COOLDOWN_MINUTES` | الانتظار بعد توقف المطر (2 في العرض، 120 في الحقل) |
| `MAX_DEFER_HOURS` | أقصى تأجيل بسبب التنبؤ (3 = نفس مدى النموذج) |
| `SOAK_SECONDS` | الانتظار بعد كل نبضة حتى يوصل الماء للحساس |
| `DAILY_MAX_SECONDS_PER_ZONE` | حد الري اليومي لكل منطقة |
| `FORECAST_TRIM_MAX` | تقليل الماء إذا المطر محتمل تحت العتبة. **0 = مطفأ** لأنه ما اختُبر على بيانات |

كل هذي القيم تُرسل لـESP32 #2 مع كل استعلام، فتغييرها ما يحتاج إعادة رفع الكود. يكفي تعيد تشغيل الـBackend.

- `ai/scripts/set_threshold.py`: يغيّر عتبة القرار ويحدث بطاقة النموذج وتقريره (فحص المعايرة + المقارنة بقواعد بسيطة). العتبة المعتمدة 0.08. إذا أعدتم التدريب بـ`train.py`، شغّلوه بعدها: `python ai/scripts/set_threshold.py 0.08`.
