/**
 * اختبارات وحدة (Jest) لآلة حالات قفل المطر src/services/rainLockout.js.
 * لا تحتاج إلى قاعدة بيانات ولا خادم، لأن step() دالة نقية.
 * التشغيل:  npx jest
 */
const { step } = require('../src/services/rainLockout');

// وقت ثابت حتى تكون النتائج متطابقة في كل تشغيل.
const now = '2026-10-10T12:00:00Z';

describe('Rain lockout state machine', () => {
  // مطر أثناء الري: قفل، وإيقاف الري، وإلغاء الأوامر.
  test('rain while irrigating → lockout, stop, cancel commands', () => {
    const r = step({ mode: 'IRRIGATING' }, { rainDetected: true, now, cooldownMinutes: 5 });
    expect(r.state.mode).toBe('RAIN_LOCKOUT');
    expect(r.cancelCommands).toBe(true);
    expect(r.events.map((e) => e.type)).toEqual(['RAIN_STARTED', 'IRRIGATION_STOPPED']);
  });

  // توقف المطر: COOLDOWN، ويبقى كذلك بعد 3 دقائق، ثم NORMAL بعد 6 دقائق (المدة 5 دقائق).
  test('rain stops → cooldown, then normal after the cooldown period', () => {
    const a = step({ mode: 'RAIN_LOCKOUT' }, { rainDetected: false, now, cooldownMinutes: 5 });
    expect(a.state.mode).toBe('COOLDOWN');
    const early = step(a.state, { rainDetected: false, now: '2026-10-10T12:03:00Z', cooldownMinutes: 5 });
    expect(early.state.mode).toBe('COOLDOWN');
    const later = step(a.state, { rainDetected: false, now: '2026-10-10T12:06:00Z', cooldownMinutes: 5 });
    expect(later.state.mode).toBe('NORMAL');
  });

  // مطر جديد أثناء فترة الانتظار: العودة إلى القفل.
  test('rain during cooldown → back to lockout', () => {
    const r = step({ mode: 'COOLDOWN', cooldownUntil: '2026-10-10T13:00:00Z' }, { rainDetected: true, now, cooldownMinutes: 5 });
    expect(r.state.mode).toBe('RAIN_LOCKOUT');
  });
});
