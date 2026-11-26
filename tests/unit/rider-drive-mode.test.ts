import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ARRIVAL_DWELL_MS,
  OFF_ROUTE_M,
  OFF_ROUTE_MS,
  arrivalRadiusM,
  bearingDeg,
  decodePolyline,
  distanceToPolylineM,
  formatDistanceTh,
  haversineM,
} from "@/modules/online-orders/geo";

const read = (p: string) => readFileSync(p, "utf8");

describe("R4 เรขาคณิตโหมดขับ", () => {
  it("ถอด polyline ตามตัวอย่างของ Google", () => {
    const pts = decodePolyline("_p~iF~ps|U_ulLnnqC_mqNvxq`@");
    expect(pts).toHaveLength(3);
    expect(pts[0]).toEqual({ lat: 38.5, lng: -120.2 });
    expect(pts[1]).toEqual({ lat: 40.7, lng: -120.95 });
    expect(pts[2]).toEqual({ lat: 43.252, lng: -126.453 });
  });

  it("ระยะเส้นตรง ~111 กม. ต่อ 1 องศาละติจูด", () => {
    expect(haversineM({ lat: 0, lng: 0 }, { lat: 1, lng: 0 })).toBeGreaterThan(111_000);
    expect(haversineM({ lat: 0, lng: 0 }, { lat: 1, lng: 0 })).toBeLessThan(111_400);
  });

  it("ระยะจากจุดถึงเส้น: บนเส้น ≈ 0, ห่างออกไป ~100 ม.", () => {
    const line = [
      { lat: 13.75, lng: 100.5 },
      { lat: 13.75, lng: 100.51 },
    ];
    expect(distanceToPolylineM({ lat: 13.75, lng: 100.505 }, line)).toBeLessThan(1);
    const off = distanceToPolylineM({ lat: 13.7509, lng: 100.505 }, line);
    expect(off).toBeGreaterThan(90);
    expect(off).toBeLessThan(110);
  });

  it("ทิศ: ไปทางตะวันออก ≈ 90°", () => {
    expect(Math.round(bearingDeg({ lat: 0, lng: 0 }, { lat: 0, lng: 1 }))).toBe(90);
  });

  it("กติกาแบบ HubOS: ถึงแล้ว 30 ม. (GPS แย่ 50) ≥5 วิ · หลุดเส้น >50 ม. >15 วิ", () => {
    expect(arrivalRadiusM(10)).toBe(30);
    expect(arrivalRadiusM(80)).toBe(50);
    expect(arrivalRadiusM(null)).toBe(30);
    expect(ARRIVAL_DWELL_MS).toBe(5_000);
    expect(OFF_ROUTE_M).toBe(50);
    expect(OFF_ROUTE_MS).toBe(15_000);
    expect(formatDistanceTh(243)).toBe("240 ม.");
    expect(formatDistanceTh(1234)).toBe("1.2 กม.");
  });
});

describe("R4 หน้าคนส่ง — สิทธิ์และเงิน", () => {
  const actions = read("src/app/rider/actions.ts");

  it("guard = pos.use + Enterprise (พนักงานทุกตำแหน่งที่ขายได้)", () => {
    expect(actions).toContain('if (!resolved.can("pos.use"))');
    expect(actions).toContain("getPlanFeatures(billing).byoPaymentGateway");
  });

  it("ทำได้เฉพาะงานของตัวเอง: รับงานที่ยังไม่มีคนส่ง / ส่งสำเร็จ-ส่งไม่สำเร็จ-ขอเส้นทาง เฉพาะของฉัน", () => {
    expect(actions).toContain('if (order.riderUserId && order.riderUserId !== g.user.id) return { ok: false, error: "มีคนรับงานนี้ไปแล้ว" };');
    expect(actions.match(/if \(order\.riderUserId !== g\.user\.id\)/g)?.length).toBe(3);
  });

  it("กติกาเงินใช้ transition-service เดียวกับหน้าร้าน (ไม่เขียนซ้ำ)", () => {
    expect(actions.match(/performOnlineOrderTransition\(/g)?.length).toBe(3);
    expect(actions).not.toMatch(/addPaymentAndClose|voidOrder|recordRiderPayAdjustment/);
  });

  it("ส่งไม่สำเร็จจากหน้าคนส่งได้เฉพาะเก็บปลายทาง", () => {
    expect(actions).toContain('if (order.paymentMethod !== "cod") return { ok: false, error: "ออเดอร์จ่ายแล้ว — แจ้งร้านให้จัดการ" };');
  });

  it("เส้นทาง Google: เรียกจาก server (key ไม่ออกหน้าเว็บ) + จำกัดต่อออเดอร์ + log", () => {
    const route = read("src/modules/online-orders/route-google.ts");
    expect(route).toContain('travelMode: "TWO_WHEELER"');
    expect(route).toContain('languageCode: "th"');
    expect(route).toContain("process.env.GOOGLE_MAPS_API_KEY");
    expect(actions).toContain("ROUTE_LIMIT_PER_HOUR = 20");
    expect(actions).toContain('action: "riderRoute"');
    // หน้าเว็บใช้ key เบราว์เซอร์แยก (NEXT_PUBLIC_*) ไม่ใช่ key server
    expect(read("src/app/rider/page.tsx")).toContain("NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY");
    expect(read("src/app/rider/page.tsx")).not.toContain("process.env.GOOGLE_MAPS_API_KEY");
  });

  it("โหมดขับ: Wake Lock + กลับเข้าแอปขอตำแหน่งใหม่ + ทางสำรองแอป Google Maps", () => {
    const drive = read("src/app/rider/DriveMode.tsx");
    expect(drive).toContain('wakeLock?.request("screen")');
    expect(drive).toContain('document.addEventListener("visibilitychange", onVisible)');
    expect(drive).toContain("แอป Google Maps");
  });
});
