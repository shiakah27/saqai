/**
 * التشغيل اليدوي التجريبي لمنطقة واحدة (للمسؤول فقط)، يُستخدم لتجهيز العتاد الحقيقي ومعايرته:
 *   - التحقق من أن كل صمام يفتح المنطقة الصحيحة
 *   - قياس تدفق المضخة (تشغيل 30 ثانية في وعاء قياس ← PUMP_FLOW_LPM)
 *   - قياس seconds_per_percent لكل منطقة
 *
 * الطلب ينتظر ESP32 #2، التي تنفذه عبر قواعد الأمان المحلية نفسها المطبقة على الري التلقائي.
 * يُرفض أثناء RAIN_LOCKOUT / COOLDOWN / ERROR أو أثناء جريان الماء؛ وتنتهي صلاحيته بعد
 * MANUAL_TTL_SECONDS؛ ويُلغى إن بدأ المطر.
 * لماذا تنتهي صلاحيته؟ حتى لا تنفذه اللوحة متأخرًا (بعد عودة الاتصال مثلًا) في وقت لم يعد أحد يراقب فيه.
 * يستدعيه: dashboardController.manualZoneRun.
 */
const crypto = require('crypto');
const { tx } = require('../database/pool');
const m = require('../models');
const live = require('./liveService');
const { config } = require('../config');

// الأوضاع التي تمنع التشغيل اليدوي، مع رسالة عربية تظهر للمستخدم.
const BLOCKING = { RAIN_LOCKOUT: 'قفل المطر فعّال', COOLDOWN: 'النظام في فترة الانتظار بعد المطر', ERROR: 'النظام في حالة عطل' };

/**
 * إنشاء أمر تشغيل يدوي لمنطقة لمدة seconds ثانية.
 * داخل معاملة مع قفل صف الحالة حتى لا يتزامن مع بدء المطر. الأخطاء تحمل status (409/404)
 * فيعيدها errorHandler إلى لوحة التحكم برسالتها.
 */
async function manualRun(zoneId, seconds) {
  const out = await tx(async (db) => {
    const state = await m.getState(db, { forUpdate: true });
    if (BLOCKING[state.mode]) { const e = new Error(`لا يمكن التشغيل: ${BLOCKING[state.mode]}`); e.status = 409; throw e; }
    if (await m.activeRun(db)) { const e = new Error('يوجد ري يعمل الآن. انتظري حتى ينتهي.'); e.status = 409; throw e; }
    const zone = (await m.listZones(db)).find((z) => z.id === zoneId);
    if (!zone) { const e = new Error(`المنطقة ${zoneId} غير موجودة`); e.status = 404; throw e; }

    // أمر يدوي واحد فقط في كل مرة: أي أمر سابق منتظر يُلغى ويحل محله الجديد.
    await m.cancelManual(db, 'SUPERSEDED');
    // المدة تُقرَّب وتُحصر بين 1 ثانية و MAX_PUMP_ON_SECONDS.
    const s = Math.min(Math.max(Math.round(seconds), 1), config.maxPumpOnSeconds);
    // معرّف فريد للأمر: الوقت (بالأساس 36) + المنطقة + 4 خانات عشوائية.
    const cmd = await m.insertManualCommand(db, {
      command_id: `man_${Date.now().toString(36)}_${zoneId}_${crypto.randomBytes(2).toString('hex')}`,
      zone_id: zoneId, duration_seconds: s, ttl_seconds: config.manualTtlSeconds,
    });
    await m.addEvent(db, 'MANUAL_RUN_REQUESTED', { command_id: cmd.command_id, seconds: s }, zoneId);
    return { command_id: cmd.command_id, zone_id: zoneId, seconds: s, expires_at: cmd.expires_at };
  });
  live.broadcast('changed', { reason: 'manual' });
  return out;
}

module.exports = { manualRun };
