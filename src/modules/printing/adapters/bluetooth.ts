import type { PrintAdapter, ReceiptData } from "../types";
import type { Printer } from "@/modules/stores/types";
import { ensureBluetoothConnected, getBluetoothPrinterIdentity, getBluetoothPrinterName, printViaBluetooth } from "../bluetooth-client";
import { buildReceiptPrinterBytes } from "../receipt-printer-bytes";

type BluetoothNavigator = Navigator & { bluetooth?: unknown };

function hasBluetoothSupport(): boolean {
  return typeof navigator !== "undefined" && !!(navigator as BluetoothNavigator).bluetooth;
}

export class BluetoothPrinterMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BluetoothPrinterMismatchError";
  }
}

function assertConfiguredBluetoothPrinter(printer: Printer): void {
  const expected = printer.bluetoothDeviceId?.trim();
  if (!expected) return;

  const connectedIdentity = getBluetoothPrinterIdentity()?.trim();
  const connectedName = getBluetoothPrinterName()?.trim();
  if (expected === connectedIdentity || expected === connectedName) return;

  const current = connectedName || connectedIdentity || "ไม่ทราบชื่อ";
  throw new BluetoothPrinterMismatchError(`เครื่องพิมพ์ Bluetooth ที่เชื่อมต่อ (${current}) ไม่ตรงกับเครื่องพิมพ์ Bluetooth ที่ตั้งไว้`);
}

export const bluetoothAdapter: PrintAdapter = {
  name: "bluetooth",

  async isAvailable(): Promise<boolean> {
    return hasBluetoothSupport();
  },

  async print(data: ReceiptData, printer: Printer): Promise<void> {
    if (!hasBluetoothSupport()) {
      throw new Error("Web Bluetooth ไม่รองรับในเบราว์เซอร์นี้");
    }
    if (!(await ensureBluetoothConnected())) {
      throw new Error("ยังไม่ได้เชื่อมต่อเครื่องพิมพ์ Bluetooth กรุณาเชื่อมต่อจากหน้าตั้งค่าเครื่องพิมพ์ก่อน");
    }
    assertConfiguredBluetoothPrinter(printer);
    await printViaBluetooth(buildReceiptPrinterBytes(data, data));
  },
};
