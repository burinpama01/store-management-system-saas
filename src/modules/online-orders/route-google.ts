// เส้นทางส่งของจาก Google Routes API (R4) — เรียกจาก server เท่านั้น (key ไม่ออกหน้าเว็บ)
// ข้อกำหนด Google: เส้นทางนี้ต้องแสดงบนแผนที่ Google (Maps JavaScript API) ในหน้าคนส่ง

import type { LatLng } from "./geo";

export interface RouteStep {
  instruction: string;
  maneuver: string | null;
  distanceM: number;
  end: LatLng;
}

export interface DeliveryRoute {
  distanceM: number;
  durationS: number;
  polyline: string;
  steps: RouteStep[];
}

const FIELD_MASK = [
  "routes.distanceMeters",
  "routes.duration",
  "routes.polyline.encodedPolyline",
  "routes.legs.steps.distanceMeters",
  "routes.legs.steps.endLocation",
  "routes.legs.steps.navigationInstruction",
].join(",");

export function googleRoutesKey(): string | null {
  return process.env.GOOGLE_MAPS_API_KEY?.trim() || null;
}

/** มอเตอร์ไซค์ ภาษาไทย — คืน null พร้อมเหตุผลเมื่อใช้ไม่ได้ (ผู้เรียกไปใช้ปุ่มเปิดแอป Google Maps แทน) */
export async function computeDeliveryRoute(origin: LatLng, destination: LatLng): Promise<{ route: DeliveryRoute | null; error: string | null }> {
  const key = googleRoutesKey();
  if (!key) return { route: null, error: "ยังไม่ได้ตั้งค่า Google Maps key บนเซิร์ฟเวอร์" };
  try {
    const res = await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
      method: "POST",
      headers: { "content-type": "application/json", "X-Goog-Api-Key": key, "X-Goog-FieldMask": FIELD_MASK },
      body: JSON.stringify({
        origin: { location: { latLng: { latitude: origin.lat, longitude: origin.lng } } },
        destination: { location: { latLng: { latitude: destination.lat, longitude: destination.lng } } },
        travelMode: "TWO_WHEELER",
        languageCode: "th",
        units: "METRIC",
      }),
      signal: AbortSignal.timeout(10_000),
      cache: "no-store",
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ตอบกลับจาก Google
    const json: any = await res.json().catch(() => null);
    if (!res.ok) return { route: null, error: `Google Routes ${res.status}: ${json?.error?.status ?? "error"}` };
    const r = json?.routes?.[0];
    if (!r?.polyline?.encodedPolyline) return { route: null, error: "ไม่พบเส้นทาง" };
    const steps: RouteStep[] = (r.legs?.[0]?.steps ?? []).map((st: Record<string, unknown>) => {
      const nav = (st.navigationInstruction ?? {}) as { instructions?: string; maneuver?: string };
      const end = ((st.endLocation as { latLng?: { latitude?: number; longitude?: number } })?.latLng ?? {}) as { latitude?: number; longitude?: number };
      return {
        instruction: (nav.instructions ?? "").replace(/\s+/g, " ").trim() || "ไปต่อ",
        maneuver: nav.maneuver ?? null,
        distanceM: Number(st.distanceMeters ?? 0),
        end: { lat: Number(end.latitude ?? 0), lng: Number(end.longitude ?? 0) },
      };
    });
    return {
      route: {
        distanceM: Number(r.distanceMeters ?? 0),
        durationS: Number(String(r.duration ?? "0s").replace("s", "")) || 0,
        polyline: r.polyline.encodedPolyline,
        steps,
      },
      error: null,
    };
  } catch (e) {
    return { route: null, error: e instanceof Error ? e.message : "เรียก Google Routes ไม่สำเร็จ" };
  }
}

/** ลิงก์เปิดแอป Google Maps นำทาง (สำรองเสมอ) */
export function googleMapsNavUrl(dest: LatLng): string {
  return `https://www.google.com/maps/dir/?api=1&destination=${dest.lat},${dest.lng}&travelmode=two-wheeler`;
}
