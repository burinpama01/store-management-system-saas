"use client";

// Minimal Web Bluetooth typings (avoid depending on lib.dom variations).
interface BTChar {
  properties: { write?: boolean; writeWithoutResponse?: boolean };
  writeValue(data: BufferSource): Promise<void>;
  writeValueWithoutResponse?(data: BufferSource): Promise<void>;
}
interface BTService {
  uuid?: string;
  getCharacteristics(): Promise<BTChar[]>;
}
interface BTServer {
  connect(): Promise<BTServer>;
  getPrimaryServices(): Promise<BTService[]>;
}
interface BTDevice {
  name?: string;
  gatt?: BTServer;
}
interface BTNavigator {
  bluetooth?: {
    requestDevice(options: unknown): Promise<BTDevice>;
    getDevices?(): Promise<BTDevice[]>;
  };
}

// Common BLE service UUIDs used by ESC/POS thermal printers.
const PRINTER_SERVICES = [
  "000018f0-0000-1000-8000-00805f9b34fb",
  "0000ff00-0000-1000-8000-00805f9b34fb",
  "0000ffe0-0000-1000-8000-00805f9b34fb",
  "49535343-fe7d-4ae5-8fa9-9fafd205e455",
  "e7810a71-73ae-499d-8c15-faa9aef0c3f2",
];

const NAME_KEY = "bt_printer_name";

let connected: { device: BTDevice; characteristic: BTChar } | null = null;
let lastDevice: BTDevice | null = null;

export function getBluetoothPrinterName(): string | null {
  if (connected) return connected.device.name ?? "Bluetooth Printer";
  if (typeof localStorage !== "undefined") return localStorage.getItem(NAME_KEY);
  return null;
}

export function isBluetoothPrinterConnected(): boolean {
  return connected !== null;
}

/** Known printer services tried first, so we don't grab an unrelated writable characteristic. */
function servicePriority(uuid: string | undefined): number {
  if (!uuid) return PRINTER_SERVICES.length;
  const idx = PRINTER_SERVICES.indexOf(uuid.toLowerCase());
  return idx === -1 ? PRINTER_SERVICES.length : idx;
}

async function findWritable(server: BTServer): Promise<BTChar | null> {
  const services = await server.getPrimaryServices();
  // Prefer well-known ESC/POS printer services before any others.
  const ordered = [...services].sort((a, b) => servicePriority(a.uuid) - servicePriority(b.uuid));
  for (const service of ordered) {
    const chars = await service.getCharacteristics();
    // Prefer write-without-response (typical for streaming raster to printers).
    const w =
      chars.find((c) => c.properties.writeWithoutResponse) ??
      chars.find((c) => c.properties.write);
    if (w) return w;
  }
  return null;
}

/** Pairs + connects a Bluetooth printer and remembers it for this session. */
export async function connectBluetoothPrinter(): Promise<string> {
  const nav = navigator as unknown as BTNavigator;
  if (!nav.bluetooth) throw new Error("เบราว์เซอร์นี้ไม่รองรับ Web Bluetooth (ใช้ Chrome/Edge)");

  const device = await nav.bluetooth.requestDevice({
    acceptAllDevices: true,
    optionalServices: PRINTER_SERVICES,
  });
  if (!device.gatt) throw new Error("อุปกรณ์นี้ไม่รองรับ GATT");

  const server = await device.gatt.connect();
  const characteristic = await findWritable(server);
  if (!characteristic) throw new Error("ไม่พบช่องเขียนข้อมูลของเครื่องพิมพ์ (characteristic)");

  connected = { device, characteristic };
  lastDevice = device;
  if (typeof localStorage !== "undefined") localStorage.setItem(NAME_KEY, device.name ?? "");
  return device.name ?? "Bluetooth Printer";
}

/**
 * Ensures a live GATT connection, reconnecting a previously-granted device
 * (after a reload) without a fresh pairing dialog. Must be called from a user
 * gesture. Returns true if connected.
 */
export async function ensureBluetoothConnected(): Promise<boolean> {
  if (connected) return true;
  const nav = navigator as unknown as BTNavigator;
  if (!nav.bluetooth) return false;
  const rememberedName = getBluetoothPrinterName();
  if (!rememberedName && !lastDevice) return false;

  try {
    let device = lastDevice;
    if (!device && nav.bluetooth.getDevices) {
      const devices = await nav.bluetooth.getDevices();
      device = devices.find((d) => (d.name ?? "") === rememberedName) ?? null;
    }
    if (!device?.gatt) return false;
    const server = await device.gatt.connect();
    const characteristic = await findWritable(server);
    if (!characteristic) return false;
    connected = { device, characteristic };
    lastDevice = device;
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Writes raw ESC/POS bytes to the connected printer in small BLE chunks with a
 * brief pause between writes. Cheap thermal printers (e.g. PT-280) have tiny RX
 * buffers and silently drop data when flooded — chunking + pacing fixes blank
 * output, especially for larger raster image jobs.
 */
export async function printViaBluetooth(bytes: Uint8Array): Promise<void> {
  if (!connected) throw new Error("ยังไม่ได้เชื่อมต่อเครื่องพิมพ์ Bluetooth");
  const { characteristic } = connected;
  const CHUNK = 120;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.slice(i, i + CHUNK);
    if (characteristic.writeValueWithoutResponse) await characteristic.writeValueWithoutResponse(slice);
    else await characteristic.writeValue(slice);
    await sleep(12);
  }
}
