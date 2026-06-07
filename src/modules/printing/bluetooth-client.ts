"use client";

// Minimal Web Bluetooth typings (avoid depending on lib.dom variations).
interface BTChar {
  properties: { write?: boolean; writeWithoutResponse?: boolean };
  writeValue(data: BufferSource): Promise<void>;
  writeValueWithoutResponse?(data: BufferSource): Promise<void>;
}
interface BTService {
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
  bluetooth?: { requestDevice(options: unknown): Promise<BTDevice> };
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

export function getBluetoothPrinterName(): string | null {
  if (connected) return connected.device.name ?? "Bluetooth Printer";
  if (typeof localStorage !== "undefined") return localStorage.getItem(NAME_KEY);
  return null;
}

export function isBluetoothPrinterConnected(): boolean {
  return connected !== null;
}

async function findWritable(server: BTServer): Promise<BTChar | null> {
  const services = await server.getPrimaryServices();
  for (const service of services) {
    const chars = await service.getCharacteristics();
    const w = chars.find((c) => c.properties.write || c.properties.writeWithoutResponse);
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
  if (typeof localStorage !== "undefined") localStorage.setItem(NAME_KEY, device.name ?? "");
  return device.name ?? "Bluetooth Printer";
}

/** Writes raw ESC/POS bytes to the connected printer in BLE-sized chunks. */
export async function printViaBluetooth(bytes: Uint8Array): Promise<void> {
  if (!connected) throw new Error("ยังไม่ได้เชื่อมต่อเครื่องพิมพ์ Bluetooth");
  const { characteristic } = connected;
  const CHUNK = 180;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.slice(i, i + CHUNK);
    if (characteristic.writeValueWithoutResponse) await characteristic.writeValueWithoutResponse(slice);
    else await characteristic.writeValue(slice);
  }
}
