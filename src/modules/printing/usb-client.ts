"use client";

// Minimal WebUSB typings (avoid lib.dom variation issues).
interface USBEndpointX {
  endpointNumber: number;
  direction: "in" | "out";
  type: string;
}
interface USBAltX {
  endpoints: USBEndpointX[];
}
interface USBInterfaceX {
  interfaceNumber: number;
  alternate: USBAltX;
}
interface USBConfigX {
  interfaces: USBInterfaceX[];
}
interface USBDeviceX {
  productName?: string;
  manufacturerName?: string;
  configuration?: USBConfigX | null;
  open(): Promise<void>;
  selectConfiguration(n: number): Promise<void>;
  claimInterface(n: number): Promise<void>;
  transferOut(endpoint: number, data: BufferSource): Promise<unknown>;
}
interface USBNavigator {
  usb?: { requestDevice(options: { filters: unknown[] }): Promise<USBDeviceX> };
}

const NAME_KEY = "usb_printer_name";

let conn: { device: USBDeviceX; endpoint: number } | null = null;

export function isUsbPrinterConnected(): boolean {
  return conn !== null;
}

export function getUsbPrinterName(): string | null {
  if (conn) return conn.device.productName ?? "USB Printer";
  if (typeof localStorage !== "undefined") return localStorage.getItem(NAME_KEY);
  return null;
}

/** Pairs + opens a USB printer and remembers it for this session. */
export async function connectUsbPrinter(): Promise<string> {
  const nav = navigator as unknown as USBNavigator;
  if (!nav.usb) throw new Error("เบราว์เซอร์นี้ไม่รองรับ WebUSB (ใช้ Chrome/Edge เดสก์ท็อป)");

  const device = await nav.usb.requestDevice({ filters: [] });
  await device.open();
  if (!device.configuration) await device.selectConfiguration(1);
  const config = device.configuration;
  if (!config) throw new Error("ไม่พบ configuration ของอุปกรณ์");

  let endpoint: number | null = null;
  for (const itf of config.interfaces) {
    const out = itf.alternate.endpoints.find((e) => e.direction === "out");
    if (out) {
      await device.claimInterface(itf.interfaceNumber);
      endpoint = out.endpointNumber;
      break;
    }
  }
  if (endpoint == null) throw new Error("ไม่พบ endpoint สำหรับส่งข้อมูลไปเครื่องพิมพ์");

  conn = { device, endpoint };
  if (typeof localStorage !== "undefined") localStorage.setItem(NAME_KEY, device.productName ?? "");
  return device.productName ?? device.manufacturerName ?? "USB Printer";
}

/** Sends raw ESC/POS bytes to the connected USB printer. */
export async function printViaUsb(bytes: Uint8Array): Promise<void> {
  if (!conn) throw new Error("ยังไม่ได้เชื่อมต่อเครื่องพิมพ์ USB");
  const CHUNK = 4096;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    await conn.device.transferOut(conn.endpoint, bytes.slice(i, i + CHUNK));
  }
}
