/**
 * useDashboard.js — الـhook الرئيسية لبيانات اللوحة كلها.
 * لا تظهر على الشاشة؛ يستدعيها App مرة واحدة ثم تُمرَّر البيانات لكل الصفحات.
 * البيانات: لقطة snapshot = { status, history } من /api/status و /api/history،
 * ثم تحديثات حية عبر SSE من /api/stream. في نسخة المعاينة تُعاد بيانات مسجّلة بدل الخادم.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { IS_PREVIEW, POLL_MS, fetchSnapshot } from '../api/client';

const API_URL = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');

/** دمج إطار حساسات حي (كل ~2 ث تقريبًا) في آخر حالة كاملة، دون انتظار التحديث الدوري القادم.
 *  يحدّث فقط قراءات الطقس ورطوبة التربة لكل منطقة ويضع علامة live؛ باقي الحالة (القرارات، الري...) يبقى كما هو.
 *  القراءة غير الصالحة (valid=false) تُعرض null حتى لا تظهر رطوبة خاطئة. */
function mergeFrame(snap, f) {
  if (!snap) return snap;
  const soil = Object.fromEntries((f.soil || []).map((s) => [s.zone_id, s]));
  const st = snap.status;
  return {
    ...snap,
    status: {
      ...st,
      weather: { ...(st.weather || {}), temperature: f.temperature, humidity: f.humidity, pressure: f.pressure,
        rain_detected: f.rain_detected, rain_level: f.rain_level, recorded_at: f.received_at, live: true },
      zones: st.zones.map((z) => (soil[z.id] ? {
        ...z, soil_moisture: soil[z.id].valid ? soil[z.id].soil_moisture : null, soil_valid: soil[z.id].valid,
        raw_adc: soil[z.id].raw_adc, soil_live: true,
      } : z)),
      readiness: { ...(st.readiness || {}), sensors_live: true },
    },
  };
}

/**
 * الوقت الحقيقي: الـSSE (Server-Sent Events) يدفع كل إطار حساسات (~2 ث) وكل تغيير (مطر، قرار، ري).
 * ومع ذلك يعمل تحديث كامل كل POLL_MS كشبكة أمان (إن انقطع البث أو فاتنا حدث)، وفورًا عند أي حدث 'changed'.
 * لماذا الاثنان؟ الـSSE سريع وخفيف لكنه قد ينقطع بصمت؛ الاستطلاع الدوري (poll) أبطأ لكنه مضمون.
 * إذا توقف الخادم عن الرد تبقى آخر بيانات على الشاشة مع عمرها (lastOkAt).
 * تُعيد: snapshot، error (رسالة الخطأ)، lastOkAt (وقت آخر نجاح)، refresh (تحديث يدوي)، streaming (هل البث متصل).
 */
export function useDashboard() {
  const [snapshot, setSnapshot] = useState(null);
  const [error, setError] = useState(null);
  const [lastOkAt, setLastOkAt] = useState(null);
  const [streaming, setStreaming] = useState(false);
  const alive = useRef(true);      // false بعد إزالة المكوّن، حتى لا نحدّث state بعد الإزالة
  const inFlight = useRef(false);  // يمنع طلبين متزامنين

  // جلب لقطة كاملة؛ يتجاهل الاستدعاء إن كان طلب سابق ما زال جاريًا.
  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const snap = await fetchSnapshot();
      if (!alive.current) return;
      setSnapshot(snap);
      setError(null);
      setLastOkAt(Date.now());
    } catch (e) {
      if (alive.current) setError(e.message);
    } finally {
      inFlight.current = false;
    }
  }, []);

  // عند التشغيل: جلب أول لقطة، ثم مؤقّت دوري (كل ثانية في المعاينة لتتحرك الحركة بسلاسة)،
  // ثم فتح اتصال SSE (ليس في المعاينة). عند الإزالة: إيقاف المؤقّت وإغلاق الاتصال.
  useEffect(() => {
    alive.current = true;
    refresh();
    const id = setInterval(refresh, IS_PREVIEW ? 1000 : POLL_MS);

    let es = null;
    if (!IS_PREVIEW && typeof EventSource !== 'undefined') {
      es = new EventSource(`${API_URL}/api/stream`);
      es.onopen = () => setStreaming(true);
      es.onerror = () => setStreaming(false);
      // حدث 'live': قراءات حساسات جديدة تُدمج مباشرة دون طلب كامل.
      es.addEventListener('live', (e) => {
        const frame = JSON.parse(e.data);
        setSnapshot((s) => mergeFrame(s, frame));
        setLastOkAt(Date.now());
      });
      // حدث 'changed': تغيّر شيء مهم (قرار، ري، مطر) فنجلب لقطة كاملة فورًا.
      es.addEventListener('changed', () => refresh());
    }
    return () => { alive.current = false; clearInterval(id); es?.close(); };
  }, [refresh]);

  return { snapshot, error, lastOkAt, refresh, streaming };
}
