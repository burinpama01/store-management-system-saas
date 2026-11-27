// เรขาคณิตสำหรับโหมดขับ (R4) — ฟังก์ชันล้วน ใช้ได้ทั้ง server/client

export interface LatLng {
  lat: number;
  lng: number;
}

const R = 6_371_000;
const rad = (d: number) => (d * Math.PI) / 180;

/** ระยะทางเส้นตรง (เมตร) */
export function haversineM(a: LatLng, b: LatLng): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** ถอด encoded polyline ของ Google (precision 5) */
export function decodePolyline(encoded: string): LatLng[] {
  const points: LatLng[] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  while (index < encoded.length) {
    for (const axis of [0, 1]) {
      let result = 0;
      let shift = 0;
      let byte: number;
      do {
        byte = encoded.charCodeAt(index++) - 63;
        result |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20 && index < encoded.length);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (axis === 0) lat += delta;
      else lng += delta;
    }
    points.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }
  return points;
}

/** ระยะจากจุดถึงเส้นทาง (เมตร) — ฉายลงบนระนาบท้องถิ่น (พอสำหรับระยะไม่กี่กิโลเมตร) */
export function distanceToPolylineM(p: LatLng, line: LatLng[]): number {
  if (line.length === 0) return Infinity;
  if (line.length === 1) return haversineM(p, line[0]);
  const kx = Math.cos(rad(p.lat)) * (Math.PI / 180) * R;
  const ky = (Math.PI / 180) * R;
  let best = Infinity;
  for (let i = 0; i < line.length - 1; i++) {
    const ax = (line[i].lng - p.lng) * kx;
    const ay = (line[i].lat - p.lat) * ky;
    const bx = (line[i + 1].lng - p.lng) * kx;
    const by = (line[i + 1].lat - p.lat) * ky;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
    const cx = ax + t * dx;
    const cy = ay + t * dy;
    best = Math.min(best, Math.hypot(cx, cy));
  }
  return best;
}

/** ทิศ (องศา 0 = เหนือ ตามเข็ม) จาก a ไป b */
export function bearingDeg(a: LatLng, b: LatLng): number {
  const y = Math.sin(rad(b.lng - a.lng)) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lng - a.lng));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** "240 ม." / "1.2 กม." */
export function formatDistanceTh(meters: number): string {
  if (!Number.isFinite(meters)) return "-";
  if (meters < 1000) return `${Math.max(0, Math.round(meters / 10) * 10)} ม.`;
  return `${(meters / 1000).toFixed(1)} กม.`;
}

// ---------- กติกาโหมดขับ (อ้างอิง HubOS v1.4 §6c) ----------

/** ถึงแล้ว: อยู่ในรัศมี 30 ม. (GPS แย่ > 50 ม. ใช้ 50 ม.) */
export function arrivalRadiusM(accuracyM: number | null): number {
  return accuracyM !== null && accuracyM > 50 ? 50 : 30;
}
export const ARRIVAL_DWELL_MS = 5_000;
/** หลุดเส้นทาง: ห่างเส้น > 50 ม. นาน > 15 วิ (ไม่นับตอน GPS แย่) */
export const OFF_ROUTE_M = 50;
export const OFF_ROUTE_MS = 15_000;
/** ใช้ทิศจาก GPS เมื่อเร็วกว่า 2 m/s (ช้ากว่านั้นใช้เข็มทิศ) */
export const HEADING_MIN_SPEED = 2;
