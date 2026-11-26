"use client";

// โหมดขับ (R4 — อ้างอิง HubOS v1.4 §6c) บนแผนที่ Google (ข้อกำหนด: เส้นทางจาก Google ต้องแสดงบนแผนที่ Google)
// ป้ายเลี้ยวไทยจาก Google · ตามตัว/หมุนตามทิศ · ถึงแล้ว 30 ม. ≥5 วิ · หลุดเส้น >50 ม. >15 วิ · Wake Lock
// ทางสำรอง: ไม่มี key เบราว์เซอร์/ไม่ให้ GPS/เส้นทางล้ม → รายการขั้นตอน + ปุ่มแอป Google Maps

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ARRIVAL_DWELL_MS,
  HEADING_MIN_SPEED,
  OFF_ROUTE_M,
  OFF_ROUTE_MS,
  arrivalRadiusM,
  decodePolyline,
  distanceToPolylineM,
  formatDistanceTh,
  haversineM,
  type LatLng,
} from "@/modules/online-orders/geo";
import type { DeliveryRoute } from "@/modules/online-orders/route-google";
import { getRiderRouteAction, type RiderJobVM } from "./actions";

interface Fix {
  lat: number;
  lng: number;
  accuracy: number | null;
  speed: number | null;
  heading: number | null;
  at: number;
}

/* eslint-disable @typescript-eslint/no-explicit-any -- Google Maps JS โหลดแบบ script ไม่มี type ในโปรเจค */
declare global {
  interface Window {
    google?: any;
    __storeosMapsLoading?: Promise<void>;
  }
}

function loadGoogleMaps(key: string): Promise<void> {
  if (window.google?.maps?.Map) return Promise.resolve();
  if (window.__storeosMapsLoading) return window.__storeosMapsLoading;
  window.__storeosMapsLoading = new Promise<void>((resolve, reject) => {
    const cb = `__storeosMapsReady${Date.now()}`;
    (window as any)[cb] = () => resolve();
    const s = document.createElement("script");
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=weekly&language=th&region=TH&callback=${cb}`;
    s.async = true;
    s.onerror = () => {
      window.__storeosMapsLoading = undefined;
      reject(new Error("โหลดแผนที่ Google ไม่สำเร็จ"));
    };
    document.head.appendChild(s);
  });
  return window.__storeosMapsLoading;
}

export function DriveMode({
  job,
  shop,
  browserMapsKey,
  mapId,
  onClose,
  onComplete,
}: {
  job: RiderJobVM;
  shop: LatLng | null;
  browserMapsKey: string | null;
  mapId: string | null;
  onClose: () => void;
  onComplete: () => void;
}) {
  const mapEl = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const routeLineRef = useRef<any>(null);
  const meRef = useRef<any>(null);
  const [route, setRoute] = useState<DeliveryRoute | null>(null);
  const [routeError, setRouteError] = useState<string | null>(null);
  const [mapError, setMapError] = useState<string | null>(null);
  const [fix, setFix] = useState<Fix | null>(null);
  const [gpsError, setGpsError] = useState<string | null>(null);
  const [compass, setCompass] = useState<number | null>(null);
  const [follow, setFollow] = useState(true);
  const [stepIndex, setStepIndex] = useState(0);
  const [offRoute, setOffRoute] = useState(false);
  const [arrived, setArrived] = useState(false);
  const [wakeOk, setWakeOk] = useState<boolean | null>(null);
  const offSinceRef = useRef<number | null>(null);
  const nearSinceRef = useRef<number | null>(null);
  const dismissedArrivalRef = useRef(false);
  const lastFixRef = useRef<Fix | null>(null);
  const routingRef = useRef(false);
  const [mapReady, setMapReady] = useState(false);
  const lineRef = useRef<LatLng[]>([]);
  const routeRef = useRef<DeliveryRoute | null>(null);
  const stepRef = useRef(0);

  const dest = job.dest;

  // ---------- เส้นทาง ----------
  const requestRoute = useCallback(
    async (origin: LatLng | null) => {
      if (routingRef.current) return;
      routingRef.current = true;
      const res = await getRiderRouteAction(job.id, origin).catch(() => ({ route: null, error: "ขอเส้นทางไม่สำเร็จ" }));
      routingRef.current = false;
      routeRef.current = res.route;
      lineRef.current = res.route ? decodePolyline(res.route.polyline) : [];
      stepRef.current = 0;
      setRoute(res.route);
      setRouteError(res.error);
      setStepIndex(0);
      setOffRoute(false);
      offSinceRef.current = null;
    },
    [job.id],
  );

  // ---------- ขั้นตอนถัดไป / หลุดเส้น / ถึงแล้ว (คิดทุกครั้งที่ได้ตำแหน่งใหม่) ----------
  const trackProgress = useCallback(
    (f: Fix) => {
      const me = { lat: f.lat, lng: f.lng };
      const poorGps = f.accuracy !== null && f.accuracy > 50;
      const r = routeRef.current;
      const ln = lineRef.current;
      // เลื่อนขั้นเมื่อเข้าใกล้ปลายขั้นปัจจุบัน
      if (r && stepRef.current < r.steps.length - 1 && haversineM(me, r.steps[stepRef.current].end) < 25) {
        stepRef.current += 1;
        setStepIndex(stepRef.current);
      }
      // หลุดเส้นทาง (ไม่นับตอน GPS แย่)
      if (ln.length > 1 && !poorGps) {
        if (distanceToPolylineM(me, ln) > OFF_ROUTE_M) {
          offSinceRef.current ??= f.at;
          if (f.at - offSinceRef.current > OFF_ROUTE_MS) setOffRoute(true);
        } else {
          offSinceRef.current = null;
          setOffRoute(false);
        }
      }
      // ถึงแล้ว (GPS แย่ ปิดเด้งอัตโนมัติ — กดเองได้)
      if (dest && !dismissedArrivalRef.current && !poorGps) {
        if (haversineM(me, dest) <= arrivalRadiusM(f.accuracy)) {
          nearSinceRef.current ??= f.at;
          if (f.at - nearSinceRef.current >= ARRIVAL_DWELL_MS) setArrived(true);
        } else {
          nearSinceRef.current = null;
        }
      }
    },
    [dest],
  );

  // ---------- GPS ----------
  useEffect(() => {
    if (!navigator.geolocation) {
      // setTimeout(0): setState หลัง effect
      const t = window.setTimeout(() => setGpsError("เครื่องนี้ไม่รองรับ GPS"), 0);
      return () => window.clearTimeout(t);
    }
    const onPos = (p: GeolocationPosition) => {
      const next: Fix = {
        lat: p.coords.latitude,
        lng: p.coords.longitude,
        accuracy: Number.isFinite(p.coords.accuracy) ? p.coords.accuracy : null,
        speed: p.coords.speed,
        heading: p.coords.heading,
        at: Date.now(),
      };
      const first = !lastFixRef.current;
      lastFixRef.current = next;
      setFix(next);
      setGpsError(null);
      if (first) void requestRoute({ lat: next.lat, lng: next.lng });
      trackProgress(next);
    };
    const onErr = (e: GeolocationPositionError) => {
      setGpsError(e.code === e.PERMISSION_DENIED ? "ไม่ได้อนุญาต GPS — เปิดในตั้งค่าเบราว์เซอร์ หรือใช้แอป Google Maps" : "หาตำแหน่งไม่ได้");
      // ไม่มี GPS ยังขอเส้นทางจากร้านได้
      if (!lastFixRef.current) void requestRoute(null);
    };
    const watch = navigator.geolocation.watchPosition(onPos, onErr, { enableHighAccuracy: true, maximumAge: 2_000, timeout: 20_000 });
    return () => navigator.geolocation.clearWatch(watch);
  }, [requestRoute, trackProgress]);

  // ---------- เข็มทิศ (Android ได้เลย · iPhone ต้องกดขออนุญาต) ----------
  useEffect(() => {
    const onOrient = (e: DeviceOrientationEvent & { webkitCompassHeading?: number }) => {
      const h = typeof e.webkitCompassHeading === "number" ? e.webkitCompassHeading : e.alpha !== null ? (360 - e.alpha) % 360 : null;
      if (h !== null && Number.isFinite(h)) setCompass(h);
    };
    window.addEventListener("deviceorientationabsolute", onOrient as EventListener);
    window.addEventListener("deviceorientation", onOrient as EventListener);
    return () => {
      window.removeEventListener("deviceorientationabsolute", onOrient as EventListener);
      window.removeEventListener("deviceorientation", onOrient as EventListener);
    };
  }, []);
  const needsCompassPermission =
    typeof window !== "undefined" && typeof (window as any).DeviceOrientationEvent?.requestPermission === "function" && compass === null;
  const askCompass = async () => {
    try {
      await (window as any).DeviceOrientationEvent.requestPermission();
    } catch {
      /* ไม่อนุญาต = ใช้ทิศจาก GPS */
    }
  };

  // ---------- กันจอดับ + กลับเข้าแอป ----------
  useEffect(() => {
    let lock: any = null;
    const request = async () => {
      try {
        lock = await (navigator as any).wakeLock?.request("screen");
        setWakeOk(Boolean(lock));
      } catch {
        setWakeOk(false);
      }
    };
    void request();
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      void request();
      // กลับจากแอปอื่น: ขอตำแหน่งใหม่ทันที (ไม่เด้ง "ถึงแล้ว" ย้อนหลัง)
      nearSinceRef.current = null;
      navigator.geolocation?.getCurrentPosition(() => undefined, () => undefined, { enableHighAccuracy: true, maximumAge: 0 });
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      void lock?.release?.().catch?.(() => undefined);
    };
  }, []);

  // ---------- แผนที่ ----------
  useEffect(() => {
    if (!browserMapsKey || !mapEl.current) return;
    let cancelled = false;
    loadGoogleMaps(browserMapsKey)
      .then(() => {
        if (cancelled || !mapEl.current || mapRef.current) return;
        const g = window.google.maps;
        const center = dest ?? shop ?? { lat: 13.7563, lng: 100.5018 };
        mapRef.current = new g.Map(mapEl.current, {
          center,
          zoom: 16,
          disableDefaultUI: true,
          gestureHandling: "greedy",
          ...(mapId ? { mapId, renderingType: "VECTOR" } : {}),
        });
        mapRef.current.addListener("dragstart", () => setFollow(false));
        setMapReady(true);
        if (dest) new g.Marker({ map: mapRef.current, position: dest, label: { text: "ส่ง", color: "#fff", fontSize: "11px" } });
        if (shop) new g.Marker({ map: mapRef.current, position: shop, opacity: 0.6, label: { text: "ร้าน", fontSize: "10px" } });
      })
      .catch((e: Error) => setMapError(e.message));
    return () => {
      cancelled = true;
    };
  }, [browserMapsKey, mapId, dest, shop]);

  // เส้นทางบนแผนที่
  useEffect(() => {
    const g = window.google?.maps;
    if (!g || !mapRef.current) return;
    routeLineRef.current?.setMap(null);
    if (lineRef.current.length > 1) {
      routeLineRef.current = new g.Polyline({ map: mapRef.current, path: lineRef.current, strokeColor: "#2563eb", strokeOpacity: 0.9, strokeWeight: 6 });
    }
    // lineRef เปลี่ยนพร้อม route เสมอ
  }, [route, mapReady]);

  const heading =
    fix && fix.speed !== null && fix.speed > HEADING_MIN_SPEED && fix.heading !== null && Number.isFinite(fix.heading) ? fix.heading : compass;

  // ตำแหน่งฉัน + ตามตัว/หมุนตามทิศ
  useEffect(() => {
    const g = window.google?.maps;
    if (!g || !mapRef.current || !fix) return;
    const pos = { lat: fix.lat, lng: fix.lng };
    const icon = {
      path: g.SymbolPath.FORWARD_CLOSED_ARROW,
      scale: 6,
      rotation: mapId ? 0 : (heading ?? 0),
      fillColor: "#ea580c",
      fillOpacity: 1,
      strokeColor: "#fff",
      strokeWeight: 2,
    };
    if (!meRef.current) meRef.current = new g.Marker({ map: mapRef.current, position: pos, icon, zIndex: 999 });
    else {
      meRef.current.setPosition(pos);
      meRef.current.setIcon(icon);
    }
    if (follow) {
      mapRef.current.panTo(pos);
      if (mapId && heading !== null) mapRef.current.setHeading?.(heading);
    }
  }, [fix, follow, heading, mapId]);


  const step = route?.steps[stepIndex] ?? null;
  const toStep = step && fix ? haversineM({ lat: fix.lat, lng: fix.lng }, step.end) : null;
  const remainingM =
    route && fix
      ? (toStep ?? 0) + route.steps.slice(stepIndex + 1).reduce((s, st) => s + st.distanceM, 0)
      : (route?.distanceM ?? null);
  const etaMin = route && remainingM !== null && route.distanceM > 0 ? Math.max(1, Math.round(((route.durationS / route.distanceM) * remainingM) / 60)) : null;
  // นับจากเวลาของตำแหน่งล่าสุด (ไม่เรียก Date.now ระหว่าง render)
  const etaClock = etaMin !== null && fix ? new Date(fix.at + etaMin * 60_000).toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit" }) : null;
  const hasMap = Boolean(browserMapsKey) && !mapError;

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-stone-900 text-white">
      {/* ป้ายเลี้ยว */}
      <div className="z-10 bg-emerald-800 px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            {step ? (
              <>
                <p className="text-2xl font-bold">{toStep !== null ? formatDistanceTh(toStep) : formatDistanceTh(step.distanceM)}</p>
                <p className="text-base leading-snug">{step.instruction}</p>
              </>
            ) : (
              <p className="text-base">{routeError ?? (route ? "ไปต่อตามเส้นทาง" : "กำลังคำนวณเส้นทาง…")}</p>
            )}
          </div>
          <button type="button" onClick={onClose} className="min-h-11 min-w-11 rounded-lg bg-white/15 px-3 text-sm" aria-label="ออกจากโหมดขับ">
            ✕
          </button>
        </div>
      </div>

      {offRoute && (
        <div className="z-10 flex items-center justify-between gap-2 bg-amber-500 px-4 py-2 text-sm text-black">
          <span>หลุดเส้นทาง</span>
          <button type="button" onClick={() => void requestRoute(fix ? { lat: fix.lat, lng: fix.lng } : null)} className="min-h-11 rounded-lg bg-black/80 px-3 text-white">
            คำนวณใหม่
          </button>
        </div>
      )}
      {(gpsError || (fix?.accuracy ?? 0) > 50) && (
        <div className="z-10 bg-red-600 px-4 py-2 text-sm">{gpsError ?? "GPS ไม่แม่น — ปิดเด้ง “ถึงแล้ว” อัตโนมัติ (กดเองได้)"}</div>
      )}
      {wakeOk === false && <div className="z-10 bg-stone-700 px-4 py-1 text-xs">จออาจดับเอง — ตั้งเวลาปิดจอให้นานขึ้นระหว่างส่ง</div>}

      {/* แผนที่ / ทางสำรอง */}
      <div className="relative flex-1">
        {hasMap ? (
          <div ref={mapEl} className="absolute inset-0" />
        ) : (
          <div className="absolute inset-0 overflow-y-auto bg-stone-800 p-4 text-sm">
            <p className="mb-2 text-stone-300">{mapError ?? "แผนที่ในหน้านี้ยังไม่เปิดใช้"} — ใช้ขั้นตอนด้านล่าง หรือปุ่มแอป Google Maps</p>
            <ol className="space-y-2">
              {(route?.steps ?? []).map((st, i) => (
                <li key={i} className={`rounded-lg p-2 ${i === stepIndex ? "bg-emerald-700" : "bg-stone-700"}`}>
                  {st.instruction} · {formatDistanceTh(st.distanceM)}
                </li>
              ))}
            </ol>
          </div>
        )}
        {hasMap && !follow && (
          <button type="button" onClick={() => setFollow(true)} className="absolute bottom-4 right-4 min-h-12 rounded-full bg-orange-600 px-4 text-sm font-semibold shadow-lg">
            ◎ กลับมาตาม
          </button>
        )}
        {needsCompassPermission && (
          <button type="button" onClick={() => void askCompass()} className="absolute left-4 top-4 min-h-11 rounded-lg bg-white/90 px-3 text-sm text-black">
            เปิดเข็มทิศ
          </button>
        )}
      </div>

      {/* แถบล่าง */}
      <div className="z-10 space-y-2 bg-white px-4 py-3 text-stone-900">
        <div className="flex items-center justify-between text-sm">
          <span>{etaClock ? `ถึง ${etaClock}` : "—"}</span>
          <span>
            {remainingM !== null ? formatDistanceTh(remainingM) : "—"}
            {etaMin !== null ? ` · ${etaMin} นาที` : ""}
          </span>
        </div>
        <p className="truncate text-sm">
          <b>{job.orderCode}</b> {job.customerName} ·{" "}
          <a href={`tel:${job.customerPhone}`} className="text-orange-700 underline">
            โทร
          </a>
          {job.paymentMethod === "cod" ? ` · เก็บ ฿${job.total.toLocaleString("th-TH")}` : ""}
        </p>
        <div className="flex gap-2">
          {job.navUrl && (
            <a href={job.navUrl} target="_blank" rel="noreferrer" className="flex min-h-11 flex-1 items-center justify-center rounded-lg border text-sm">
              แอป Google Maps
            </a>
          )}
          <button type="button" onClick={() => setArrived(true)} className="min-h-11 flex-1 rounded-lg bg-orange-600 text-sm font-semibold text-white">
            ถึงแล้ว
          </button>
        </div>
      </div>

      {arrived && (
        <div className="absolute inset-x-0 bottom-0 z-20 space-y-3 rounded-t-2xl bg-white p-4 text-stone-900 shadow-2xl" role="dialog" aria-label="ถึงแล้ว">
          <p className="text-lg font-bold">ถึงแล้ว — {job.orderCode}</p>
          <p className="text-sm">{job.address}</p>
          {job.paymentMethod === "cod" && <p className="rounded bg-amber-50 p-2 text-sm text-amber-900">เก็บเงิน ฿{job.total.toLocaleString("th-TH")}</p>}
          <div className="flex gap-2">
            <button type="button" onClick={onComplete} className="min-h-12 flex-1 rounded-lg bg-orange-600 font-semibold text-white">
              ส่งสำเร็จ
            </button>
            <button
              type="button"
              onClick={() => {
                dismissedArrivalRef.current = true;
                setArrived(false);
              }}
              className="min-h-12 rounded-lg border px-4"
            >
              ยังไม่ถึง
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
/* eslint-enable @typescript-eslint/no-explicit-any */
