"use client";

/**
 * เชื่อมเครื่องพิมพ์ความร้อน BLE ผ่าน native plugin (Capacitor) — ใช้ได้บน iOS/Android
 * ที่ WebView ไม่รองรับ Web Bluetooth. ส่ง ESC/POS raster bytes ชุดเดียวกับฝั่งเว็บ
 * (buildReceiptPrinterBytes) จึงพิมพ์ภาษาไทยได้ทุกเครื่อง
 *
 * ใช้ dynamic import ของ @capacitor-community/bluetooth-le เพื่อไม่ให้ SSR/เว็บบันเดิล
 * ต้องโหลด native bridge ที่ไม่มีบนเบราว์เซอร์ปกติ
 */

// ESC/POS BLE service UUID ที่พบบ่อยในเครื่องพิมพ์ความร้อน (ตรงกับฝั่ง Web Bluetooth)
const PRINTER_SERVICES = [
  "000018f0-0000-1000-8000-00805f9b34fb",
  "0000ff00-0000-1000-8000-00805f9b34fb",
  "0000ffe0-0000-1000-8000-00805f9b34fb",
  "49535343-fe7d-4ae5-8fa9-9fafd205e455",
  "e7810a71-73ae-499d-8c15-faa9aef0c3f2",
];

const DEVICE_ID_KEY = "native_bt_printer_id";
const NAME_KEY = "native_bt_printer_name";
const SERVICE_KEY = "native_bt_printer_service";
const CHAR_KEY = "native_bt_printer_char";

interface NativeConnection {
  deviceId: string;
  name: string;
  service: string;
  characteristic: string;
  writeWithoutResponse: boolean;
}

let connected: NativeConnection | null = null;

interface CapacitorBridge {
  isNativePlatform?: () => boolean;
}

/** true เมื่อรันในแอป Capacitor (ไม่ใช่เบราว์เซอร์ปกติ) */
export function isNativePlatform(): boolean {
  if (typeof window === "undefined") return false;
  const cap = (window as unknown as { Capacitor?: CapacitorBridge }).Capacitor;
  return Boolean(cap?.isNativePlatform?.());
}

async function loadBle() {
  const mod = await import("@capacitor-community/bluetooth-le");
  return mod.BleClient;
}

function persist(conn: NativeConnection) {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(DEVICE_ID_KEY, conn.deviceId);
  localStorage.setItem(NAME_KEY, conn.name);
  localStorage.setItem(SERVICE_KEY, conn.service);
  localStorage.setItem(CHAR_KEY, conn.characteristic);
}

export function isNativeBluetoothConnected(): boolean {
  return connected !== null;
}

export function getNativeBluetoothPrinterName(): string | null {
  if (connected) return connected.name;
  if (typeof localStorage !== "undefined") return localStorage.getItem(NAME_KEY);
  return null;
}

function servicePriority(uuid: string): number {
  const idx = PRINTER_SERVICES.indexOf(uuid.toLowerCase());
  return idx === -1 ? PRINTER_SERVICES.length : idx;
}

interface BleService {
  uuid: string;
  characteristics: Array<{
    uuid: string;
    properties: { write?: boolean; writeWithoutResponse?: boolean };
  }>;
}

/** หา characteristic ที่เขียนได้ โดยเลือก printer service ที่รู้จักก่อน */
function findWritable(services: BleService[]): Pick<NativeConnection, "service" | "characteristic" | "writeWithoutResponse"> | null {
  const ordered = [...services].sort((a, b) => servicePriority(a.uuid) - servicePriority(b.uuid));
  for (const service of ordered) {
    const woResp = service.characteristics.find((c) => c.properties.writeWithoutResponse);
    if (woResp) {
      return { service: service.uuid, characteristic: woResp.uuid, writeWithoutResponse: true };
    }
    const withResp = service.characteristics.find((c) => c.properties.write);
    if (withResp) {
      return { service: service.uuid, characteristic: withResp.uuid, writeWithoutResponse: false };
    }
  }
  return null;
}

/** เปิด dialog ให้ผู้ใช้เลือกเครื่องพิมพ์ BLE แล้วจำไว้ */
export async function connectNativeBluetoothPrinter(): Promise<string> {
  if (!isNativePlatform()) throw new Error("รองรับเฉพาะในแอปมือถือ StoreOS");
  const BleClient = await loadBle();
  await BleClient.initialize({ androidNeverForLocation: true });

  const device = await BleClient.requestDevice({ optionalServices: PRINTER_SERVICES });
  await BleClient.connect(device.deviceId, () => {
    // ตัดการเชื่อมต่อ (เครื่องพิมพ์ดับ/ห่าง) → ล้าง state ให้ ensure ต่อใหม่
    if (connected?.deviceId === device.deviceId) connected = null;
  });

  const services = (await BleClient.getServices(device.deviceId)) as unknown as BleService[];
  const writable = findWritable(services);
  if (!writable) {
    await BleClient.disconnect(device.deviceId).catch(() => {});
    throw new Error("ไม่พบช่องเขียนข้อมูลของเครื่องพิมพ์ (characteristic)");
  }

  const name = device.name ?? "เครื่องพิมพ์ Bluetooth";
  connected = { deviceId: device.deviceId, name, ...writable };
  persist(connected);
  return name;
}

/** ต่อเครื่องพิมพ์ที่จำไว้ใหม่หลังรีโหลด โดยไม่ต้องเลือกซ้ำ */
export async function ensureNativeBluetoothConnected(): Promise<boolean> {
  if (connected) return true;
  if (!isNativePlatform() || typeof localStorage === "undefined") return false;
  const deviceId = localStorage.getItem(DEVICE_ID_KEY);
  const service = localStorage.getItem(SERVICE_KEY);
  const characteristic = localStorage.getItem(CHAR_KEY);
  if (!deviceId || !service || !characteristic) return false;

  try {
    const BleClient = await loadBle();
    await BleClient.initialize({ androidNeverForLocation: true });
    await BleClient.connect(deviceId, () => {
      if (connected?.deviceId === deviceId) connected = null;
    });
    // ตรวจ property เขียนของ characteristic ที่จำไว้
    const services = (await BleClient.getServices(deviceId)) as unknown as BleService[];
    const svc = services.find((s) => s.uuid.toLowerCase() === service.toLowerCase());
    const ch = svc?.characteristics.find((c) => c.uuid.toLowerCase() === characteristic.toLowerCase());
    if (!ch) {
      await BleClient.disconnect(deviceId).catch(() => {});
      return false;
    }
    connected = {
      deviceId,
      name: localStorage.getItem(NAME_KEY) ?? "เครื่องพิมพ์ Bluetooth",
      service,
      characteristic,
      writeWithoutResponse: Boolean(ch.properties.writeWithoutResponse),
    };
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * เขียน ESC/POS bytes เป็น chunk เล็ก (120B) เว้นจังหวะ 12ms — เครื่องพิมพ์ราคาถูก
 * (เช่น PT-280) บัฟเฟอร์ RX เล็ก ถ้ายัดรวดเดียวจะ drop ข้อมูล พิมพ์ออกเป็นกระดาษเปล่า
 */
export async function printViaNativeBluetooth(bytes: Uint8Array): Promise<void> {
  if (!connected) throw new Error("ยังไม่ได้เชื่อมต่อเครื่องพิมพ์ Bluetooth");
  const BleClient = await loadBle();
  const { deviceId, service, characteristic, writeWithoutResponse } = connected;
  const CHUNK = 120;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.slice(i, i + CHUNK);
    const view = new DataView(slice.buffer, slice.byteOffset, slice.byteLength);
    if (writeWithoutResponse) {
      await BleClient.writeWithoutResponse(deviceId, service, characteristic, view);
    } else {
      await BleClient.write(deviceId, service, characteristic, view);
    }
    await sleep(12);
  }
}

/** ตัดการเชื่อมต่อ (สำหรับปุ่ม "ยกเลิกการจับคู่") */
export async function disconnectNativeBluetoothPrinter(): Promise<void> {
  if (!connected) return;
  try {
    const BleClient = await loadBle();
    await BleClient.disconnect(connected.deviceId);
  } catch {
    /* เครื่องอาจตัดไปแล้ว */
  }
  connected = null;
  if (typeof localStorage !== "undefined") {
    [DEVICE_ID_KEY, NAME_KEY, SERVICE_KEY, CHAR_KEY].forEach((k) => localStorage.removeItem(k));
  }
}
