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
  usb?: {
    requestDevice(options: { filters: unknown[] }): Promise<USBDeviceX>;
    getDevices?(): Promise<USBDeviceX[]>;
  };
}

const NAME_KEY = "usb_printer_name";

/**
 * ข้อความที่ผู้ใช้ทำอะไรต่อได้จริง เมื่อ WebUSB เปิดอุปกรณ์ไม่ได้
 *
 * บน Windows ไดรเวอร์ usbprint.sys จะยึดเครื่องพิมพ์ไว้ทันทีที่ระบบรู้จักมัน
 * เบราว์เซอร์จึงเปิดไม่ได้เลย ("Access denied") ไม่ว่าจะกดกี่ครั้ง — ไม่ใช่อาการชั่วคราว
 * ที่ลองใหม่แล้วหาย ทางแก้จริงคือพิมพ์ผ่าน Print Hub ซึ่งส่งงานเข้า Windows spooler
 */
export const USB_ACCESS_DENIED_MESSAGE =
  "Windows จองเครื่องพิมพ์ตัวนี้ไว้ให้ระบบพิมพ์ของตัวเอง เบราว์เซอร์จึงต่อตรงไม่ได้ (กดซ้ำก็ไม่หาย) — " +
  "ให้ตั้งค่าเป็นเครื่องพิมพ์ USB ผ่าน Print Hub ที่หน้า ตั้งค่า → Print Hub แทน แล้วพิมพ์ได้ทั้งจากคอมและแท็บเล็ต";

export function isUsbAccessDeniedError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.name === "SecurityError" ||
    error.name === "NotAllowedError" ||
    /access denied|permission denied/i.test(error.message)
  );
}

/** แปลง error ดิบของ WebUSB เป็นข้อความไทยที่บอกทางแก้ */
export function describeUsbError(error: unknown): string {
  if (isUsbAccessDeniedError(error)) return USB_ACCESS_DENIED_MESSAGE;
  if (error instanceof Error && error.name === "NotFoundError") {
    return "ยังไม่ได้เลือกเครื่องพิมพ์ — กดใหม่แล้วเลือกจากรายการอุปกรณ์";
  }
  return error instanceof Error && error.message ? error.message : "เชื่อมต่อ USB ไม่สำเร็จ";
}

let conn: { device: USBDeviceX; endpoint: number } | null = null;
let lastDevice: USBDeviceX | null = null;

async function openDevice(device: USBDeviceX): Promise<{ device: USBDeviceX; endpoint: number } | null> {
  await device.open();
  if (!device.configuration) await device.selectConfiguration(1);
  const config = device.configuration;
  if (!config) return null;
  for (const itf of config.interfaces) {
    const out = itf.alternate.endpoints.find((e) => e.direction === "out");
    if (out) {
      await device.claimInterface(itf.interfaceNumber);
      return { device, endpoint: out.endpointNumber };
    }
  }
  return null;
}

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
  let opened: { device: USBDeviceX; endpoint: number } | null;
  try {
    opened = await openDevice(device);
  } catch (error) {
    // ข้อความดิบของเบราว์เซอร์ ("Failed to execute 'open' on 'USBDevice': Access denied.")
    // ไม่บอกสาเหตุและไม่บอกทางแก้ — แคชเชียร์ได้แต่กดซ้ำ
    throw new Error(describeUsbError(error));
  }
  if (!opened) throw new Error("ไม่พบ endpoint สำหรับส่งข้อมูลไปเครื่องพิมพ์");

  conn = opened;
  lastDevice = device;
  if (typeof localStorage !== "undefined") localStorage.setItem(NAME_KEY, device.productName ?? "");
  return device.productName ?? device.manufacturerName ?? "USB Printer";
}

/**
 * Reconnects a previously-granted USB printer (after a reload) without a fresh
 * chooser. Must be called from a user gesture. Returns true if connected.
 */
export async function ensureUsbConnected(): Promise<boolean> {
  if (conn) return true;
  const nav = navigator as unknown as USBNavigator;
  if (!nav.usb?.getDevices) return false;
  const rememberedName = getUsbPrinterName();
  if (!rememberedName && !lastDevice) return false;
  try {
    let device = lastDevice;
    if (!device) {
      const devices = await nav.usb.getDevices();
      device = devices.find((d) => (d.productName ?? "") === rememberedName) ?? null;
    }
    if (!device) return false;
    const opened = await openDevice(device);
    if (!opened) return false;
    conn = opened;
    lastDevice = device;
    return true;
  } catch {
    return false;
  }
}

/** Sends raw ESC/POS bytes to the connected USB printer. */
export async function printViaUsb(bytes: Uint8Array): Promise<void> {
  if (!conn) throw new Error("ยังไม่ได้เชื่อมต่อเครื่องพิมพ์ USB");
  const CHUNK = 4096;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    await conn.device.transferOut(conn.endpoint, bytes.slice(i, i + CHUNK));
  }
}
