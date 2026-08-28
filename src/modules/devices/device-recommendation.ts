// F2 · Task 7 (v0.33.6) — Deterministic print-channel recommendation
// เมทริกซ์อ่านง่าย: 1 primary + fallback ที่ทำได้จริง + เหตุผลภาษาคนทุกตัวเลือก
// กฎ IP ตามแผน: ห้ามแสดงว่า "พร้อม" จาก browser API — ต้องมีทดสอบพิมพ์สำเร็จก่อน
// (สถานะทดสอบสำเร็จจะมาพร้อม migration Task 10: last_test_ok_at)
import type { DeviceCapabilities, RecommendedPrint } from "./capability";

export type ChannelRole = "primary" | "fallback" | "unavailable" | "unknown";

export type PrintChannelOption = Readonly<{
  id: RecommendedPrint;
  role: ChannelRole;
  title: string;
  reason: string;
  href: string | null;
}>;

export type DeviceRecommendation = Readonly<{
  primary: PrintChannelOption | null;
  fallbacks: ReadonlyArray<PrintChannelOption>;
  unavailable: ReadonlyArray<PrintChannelOption>;
  unknown: ReadonlyArray<PrintChannelOption>;
}>;

export type RecommendContext = Readonly<{ hasNetworkPrinter: boolean }>;

const TITLES: Record<RecommendedPrint, string> = {
  hub: "Print Hub (แนะนำที่สุด)",
  "native-ble": "Bluetooth ในแอป StoreOS",
  usb: "USB ตรง",
  "web-bluetooth": "Bluetooth ผ่านเบราว์เซอร์",
  ip: "เครื่องพิมพ์ IP / WiFi",
  browser: "พิมพ์ผ่านหน้าต่างพิมพ์ของเบราว์เซอร์",
};

const HUB_HREF = "/settings/print-hub";
const RECEIPT_HREF = "/settings/receipt";

const option = (
  id: RecommendedPrint,
  role: ChannelRole,
  reason: string,
  href: string | null = null,
): PrintChannelOption => ({ id, role, title: TITLES[id], reason, href });

export function recommendPrintChannels(caps: DeviceCapabilities, context: RecommendContext): DeviceRecommendation {
  const primary: PrintChannelOption | null = caps.recommendedPrint === "ip" ? null : option(
    caps.recommendedPrint,
    "primary",
    caps.recommendedPrint === "hub"
      ? `Hub ออนไลน์อยู่ — ทุกอุปกรณ์ในร้านส่งงานพิมพ์ผ่าน Hub ได้ทันที${caps.printHub === "online" ? "" : " (ยังยืนยันสถานะไม่สำเร็จ)"}`
      : caps.recommendedPrint === "native-ble"
        ? "แอป StoreOS เชื่อมเครื่องพิมพ์ Bluetooth ได้โดยตรง"
        : caps.recommendedPrint === "usb"
          ? "เบราว์เซอร์นี้รองรับ WebUSB — เสียบสายแล้วเชื่อมได้เลย"
          : caps.recommendedPrint === "web-bluetooth"
            ? "เบราว์เซอร์นี้รองรับ Web Bluetooth"
            : "เปิดหน้าต่างพิมพ์ของเบราว์เซอร์ตอนกดพิมพ์ใบเสร็จ",
    caps.recommendedPrint === "hub" ? HUB_HREF : null,
  );

  const fallbacks: PrintChannelOption[] = [];
  const unavailable: PrintChannelOption[] = [];
  const unknown: PrintChannelOption[] = [];

  // Hub
  if (caps.printHub === "online") {
    if (caps.recommendedPrint !== "hub") {
      fallbacks.push(option("hub", "fallback", "Hub ออนไลน์ — ใช้เป็นช่องทางสำรองได้เสมอ", HUB_HREF));
    }
  } else if (caps.printHub === "unknown") {
    unknown.push(option("hub", "unknown", "ยังตรวจสถานะ Hub ไม่สำเร็จ — กดรีเฟรชหน้านี้เพื่อลองใหม่", null));
  } else {
    fallbacks.push(option("hub", "fallback", "Hub ยังออฟไลน์ — ติดตั้ง/เปิดโปรแกรม Hub บนเครื่องแคชเชียร์แล้วสถานะจะเปลี่ยนเป็นออนไลน์", HUB_HREF));
  }

  // Native BLE (Android app)
  if (caps.nativeBle) {
    if (caps.recommendedPrint !== "native-ble") {
      fallbacks.push(option("native-ble", "fallback", "แอป StoreOS บน Android เชื่อม BLE ได้ ใช้เป็นช่องทางสำรอง"));
    }
  } else {
    unavailable.push(option("native-ble", "unavailable", "ช่องทางนี้ใช้ได้เฉพาะแอป StoreOS บน Android"));
  }

  // USB
  if (caps.webUsb) {
    if (caps.recommendedPrint !== "usb") {
      fallbacks.push(option("usb", "fallback", "เบราว์เซอร์นี้รองรับ WebUSB ใช้เป็นช่องทางสำรอง"));
    }
  } else {
    unavailable.push(option("usb", "unavailable", caps.os === "ios" ? "iPad/iPhone Safari ไม่รองรับ USB จากเบราว์เซอร์ — ใช้ Print Hub หรือ IP ผ่าน Hub แทน" : "อุปกรณ์/เบราว์เซอร์นี้ไม่รองรับ WebUSB"));
  }

  // Web Bluetooth
  if (caps.webBluetooth) {
    if (caps.recommendedPrint !== "web-bluetooth") {
      fallbacks.push(option("web-bluetooth", "fallback", "เบราว์เซอร์นี้รองรับ Web Bluetooth ใช้เป็นช่องทางสำรอง"));
    }
  } else {
    unavailable.push(option("web-bluetooth", "unavailable", caps.os === "ios" ? "iPad/iPhone Safari ไม่รองรับ Bluetooth จากเบราว์เซอร์ — ใช้ Print Hub หรือ IP ผ่าน Hub แทน" : "อุปกรณ์/เบราว์เซอร์นี้ไม่รองรับ Web Bluetooth"));
  }

  // IP / WiFi — ห้ามพร้อมจาก browser API ต้องทดสอบพิมพ์ก่อน
  if (context.hasNetworkPrinter) {
    fallbacks.push(option("ip", "fallback", `มีเครื่องพิมพ์ IP ตั้งค่าไว้แล้ว — ต้องกดพิมพ์ทดสอบสำเร็จก่อนจึงถือว่าพร้อมใช้ (ระบบไม่ถือว่า IP พร้อมจากข้อมูล browser)`, RECEIPT_HREF));
  } else {
    unavailable.push(option("ip", "unavailable", "ยังไม่มีเครื่องพิมพ์ IP/WiFi ที่ตั้งค่าไว้ในร้านนี้ — เพิ่มได้ที่หน้าเครื่องพิมพ์", RECEIPT_HREF));
  }

  // Browser fallback
  if (caps.recommendedPrint !== "browser") {
    fallbacks.push(option("browser", "fallback", "ใช้ได้ทุกอุปกรณ์เสมอ — เปิดหน้าต่างพิมพ์ของเบราว์เซอร์ตอนกดพิมพ์"));
  }

  return { primary, fallbacks, unavailable, unknown };
}