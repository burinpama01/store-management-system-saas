// F2 · Task 7 (v0.33.6) — Browser adapter: อ่านข้อเท็จจริงที่วัดได้จากเครื่องนี้
// ห้ามสรุปเกินสิ่งที่ API บอก: presence = "เริ่มเชื่อมได้" ไม่ใช่ "พร้อมพิมพ์";
// Hub ที่ยังไม่รู้ผล (timeout/403) ต้องรายงาน null (unknown) ไม่ใช่ offline
import { detectDeviceCapabilities, type DeviceCapabilities, type DeviceBrowser, type DeviceOs } from "./capability";

/** UA + (ตัวเลือก) maxTouchPoints — iPad สมัยใหม่ปลอมเป็น Mac UA จึงต้องใช้ touch points ช่วยตัดสิน */
export function detectOs(userAgent: string, maxTouchPoints = 0): DeviceOs {
  const ua = userAgent;
  if (/iPad|iPhone|iPod/.test(ua)) return "ios";
  // iPadOS 13+: รายงานเป็น Macintosh แต่มี multi-touch
  if (/Macintosh/.test(ua) && maxTouchPoints > 1) return "ios";
  if (/Android/.test(ua)) return "android";
  if (/Windows NT/.test(ua)) return "windows";
  if (/Macintosh/.test(ua)) return "macos";
  return "other";
}

export function detectBrowser(userAgent: string): DeviceBrowser {
  const ua = userAgent;
  if (/Firefox\//.test(ua)) return "firefox";
  if (/(Chrome|Chromium|Edg|EdgA|CriOS)\//.test(ua)) return "chromium";
  if (/Safari\//.test(ua)) return "safari";
  return "other";
}

type CapacitorGlobal = { Plugins?: Record<string, unknown> } | undefined;

function nativeBleApiPresent(storeOsApp: boolean): boolean {
  if (!storeOsApp || typeof window === "undefined") return false;
  const capacitor = (window as { Capacitor?: CapacitorGlobal }).Capacitor;
  return Boolean(capacitor?.Plugins && "BluetoothLe" in capacitor.Plugins);
}

export async function fetchHubOnline(): Promise<boolean | null> {
  if (typeof fetch === "undefined") return null;
  try {
    const res = await fetch("/api/print/hub/status", { cache: "no-store" });
    // 401/403 = ยังมีสิทธิ์ไม่ครบ/ยังไม่ล็อกอิน → ไม่รู้ผล ห้ามตีความเป็น offline
    if (res.status === 401 || res.status === 403) return null;
    if (!res.ok) return null;
    const data = (await res.json()) as { online?: unknown };
    return typeof data.online === "boolean" ? data.online : null;
  } catch {
    return null;
  }
}

/** อ่านข้อเท็จจริงจากเครื่องนี้แล้วเรียก capability contract — ต้องรันใน browser เท่านั้น */
export async function readDeviceCapabilities(options: { withHub?: boolean } = {}): Promise<DeviceCapabilities> {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    throw new Error("browser_only");
  }
  const nav = navigator as Navigator & { maxTouchPoints?: number };
  const ua = nav.userAgent;
  const storeOsApp = ua.includes("StoreOSApp") || (await isNativePlatformSafe());
  const input = {
    width: window.innerWidth,
    os: detectOs(ua, nav.maxTouchPoints ?? 0),
    browser: detectBrowser(ua),
    storeOsApp,
    webBluetoothApi: "bluetooth" in nav,
    webUsbApi: "usb" in nav,
    nativeBleApi: nativeBleApiPresent(storeOsApp),
    hubOnline: options.withHub === false ? null : await fetchHubOnline(),
  };
  return detectDeviceCapabilities(input);
}

async function isNativePlatformSafe(): Promise<boolean> {
  try {
    const mod = await import("@/modules/printing/native-print-client");
    return typeof mod.isNativePlatform === "function" ? mod.isNativePlatform() : false;
  } catch {
    return false;
  }
}