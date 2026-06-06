import type { PrintAdapter, ReceiptData } from "../types";
import type { Printer } from "@/modules/stores/types";
import { buildEscPosReceipt } from "../escpos";

type BluetoothServiceUUID = string | number;
type BluetoothDevice = object;

declare global {
  interface Navigator {
    bluetooth?: {
      requestDevice(options: {
        filters?: Array<{ namePrefix?: string; services?: BluetoothServiceUUID[] }>;
        optionalServices?: BluetoothServiceUUID[];
        acceptAllDevices?: boolean;
      }): Promise<BluetoothDevice>;
    };
  }
}

export const bluetoothAdapter: PrintAdapter = {
  name: "bluetooth",

  async isAvailable(): Promise<boolean> {
    return typeof navigator !== "undefined" && !!navigator.bluetooth;
  },

  async print(data: ReceiptData, printer: Printer): Promise<void> {
    void buildEscPosReceipt(data);
    void printer;
    if (!navigator.bluetooth) {
      throw new Error("Web Bluetooth ไม่รองรับในเบราว์เซอร์นี้");
    }
    throw new Error("Bluetooth printing ยังต้องตั้งค่า service/characteristic ของรุ่นเครื่องพิมพ์ก่อนใช้งานจริง");
  },
};
