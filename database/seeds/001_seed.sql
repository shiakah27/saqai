-- البيانات الأولية (seed). تُنفَّذ مع كل تشغيل لـ migrate.js، وهي آمنة للتكرار بفضل ON CONFLICT DO NOTHING
-- (لا تمس القيم التي عُدّلت لاحقًا). تُعايَر المناطق من لوحة الصيانة في لوحة التحكم (docs/calibration.md).

-- الجهازان: عقدة الحساسات وعقدة المشغّلات (يجب أن يطابق المعرّف ما في secrets.h على كل لوحة).
INSERT INTO devices (id, kind) VALUES
  ('sensor_node_01', 'sensor'),
  ('actuator_node_01', 'actuator')
ON CONFLICT (id) DO NOTHING;

-- المناطق الثلاث بقيم مبدئية: الرطوبة المستهدفة والحرجة % وثوانٍ لكل 1% (تُضبط بعد المعايرة).
INSERT INTO zones (id, name, plant_type, area_m2, target_moisture, critical_moisture, seconds_per_percent) VALUES
  (1, 'المنطقة 1', 'خضروات ورقية', 0.25, 40, 22, 2.0),
  (2, 'المنطقة 2', 'طماطم',        0.25, 35, 18, 2.4),
  (3, 'المنطقة 3', 'شتلات',        0.25, 30, 18, 1.6)
ON CONFLICT (id) DO NOTHING;

-- صف حالة النظام الوحيد، يبدأ بالوضع NORMAL.
INSERT INTO system_state (id, mode) VALUES (1, 'NORMAL') ON CONFLICT (id) DO NOTHING;
