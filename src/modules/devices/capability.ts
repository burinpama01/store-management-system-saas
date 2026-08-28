/**
 * F0 · Task 1 (v0.33.0) — Pure device capability contract
 *
 * Classification + print-channel recommendation แบบ pure function:
 * ไม่มี React/DB/browser API — browser adapter (`browser-capability.ts`, Task 7)
 * เป็นผู้อ่าน UA/window APIs/Capactor/Hub status แล้วส่ง DeviceInput เข้ามาเท่านั้น
 *
 * กฎ fail closed:
 * - width ไม่ finite/ไม่ positive → throw (ห้ามเดา form factor)
 * - capability ที่ขัดแย้งกับ platform (เช่น iOS เอ่ยว่ามี native BLE) ต้องลงเป็น false เสมอ
 * - API presence แปลว่า "เริ่มขั้นตอนเชื่อมต่อได้" ไม่ใช่ "เชื่อมสำเร็จ"
 * - Hub timeout/403 ต้องรายงานเป็น "unknown" ไม่ใช่ not-installed (adapter คือผู้กำหนด)
 */

export type FormFactor = "mobile" | "tablet" | "desktop";

export type DeviceOs = "windows" | "android" | "ios" | "macos" | "other";
export type DeviceBrowser = "chromium" | "firefox" | "safari" | "other";
export type DeviceRuntime = "storeos-app" | "browser";
export type PrintHubState = "online" | "offline" | "unknown";
export type RecommendedPrint = "usb" | "web-bluetooth" | "native-ble" | "hub" | "ip" | "browser";

/** อินพุตจาก browser adapter/native runtime — ต้องเป็นข้อเท็จจริงที่วัดได้เท่านั้น */
export type DeviceInput = Readonly<{
  width: number;
  os: DeviceOs;
  browser: DeviceBrowser;
  /** ยืนยันจาก native runtime/plugin (เช่น Capacitor isNativePlatform) ไม่ใช่ UA */
  storeOsApp: boolean;
  webBluetoothApi: boolean;
  webUsbApi: boolean;
  nativeBleApi: boolean;
  /** null = ยังไม่รู้ผล (timeout/ยังไม่ตรวจ) — ห้ามตีความเป็น offline */
  hubOnline: boolean | null;
}>;

export type DeviceCapabilities = Readonly<{
  formFactor: FormFactor;
  os: DeviceOs;
  runtime: DeviceRuntime;
  webBluetooth: boolean;
  webUsb: boolean;
  nativeBle: boolean;
  printHub: PrintHubState;
  recommendedPrint: RecommendedPrint;
}>;

/** Breakpoint contract เดียวทั้งระบบ: mobile <768 · tablet 768–1279 · desktop ≥1280 */
export const classifyFormFactor = (width: number): FormFactor =>
  width < 768 ? "mobile" : width < 1280 ? "tablet" : "desktop";

export function detectDeviceCapabilities(input: DeviceInput): DeviceCapabilities {
  if (!Number.isFinite(input.width) || input.width <= 0) throw new RangeError("width");
  // Native BLE มีเฉพาะ StoreOS app บน Android — iOS/เบราว์เซอร์ที่อ้างว่ามีต้อง fail closed
  const nativeBle = input.storeOsApp && input.os === "android" && input.nativeBleApi;
  const webBluetooth = input.os !== "ios" && input.browser === "chromium" && input.webBluetoothApi;
  const webUsb = input.os === "windows" && input.browser === "chromium" && input.webUsbApi;
  return {
    formFactor: classifyFormFactor(input.width),
    os: input.os,
    runtime: input.storeOsApp ? "storeos-app" : "browser",
    nativeBle,
    webBluetooth,
    webUsb,
    printHub: input.hubOnline === null ? "unknown" : input.hubOnline ? "online" : "offline",
    recommendedPrint: input.hubOnline
      ? "hub"
      : nativeBle
        ? "native-ble"
        : webUsb
          ? "usb"
          : webBluetooth
            ? "web-bluetooth"
            : "browser",
  };
}
