import type { PrintAdapter, ReceiptData } from "./types";
import type { Printer } from "@/modules/stores/types";
import { browserAdapter } from "./adapters/browser";
import { usbAdapter } from "./adapters/usb";
import { ipAdapter } from "./adapters/ip";
import { bluetoothAdapter } from "./adapters/bluetooth";
import { escposAdapter } from "./adapters/escpos";

const ADAPTERS: Record<string, PrintAdapter> = {
  browser: browserAdapter,
  usb: usbAdapter,
  ip: ipAdapter,
  bluetooth: bluetoothAdapter,
  escpos: escposAdapter,
};

export class PrintService {
  private getAdapter(printer: Printer): PrintAdapter {
    const adapter = ADAPTERS[printer.type];
    if (!adapter) throw new Error(`Unsupported printer type: ${printer.type}`);
    return adapter;
  }

  async print(printer: Printer, data: ReceiptData): Promise<void> {
    const adapter = this.getAdapter(printer);
    const available = await adapter.isAvailable();
    if (!available) {
      throw new Error(`${adapter.name} printer is not available in this environment`);
    }
    await adapter.print(data, printer);
  }

  async isAvailable(printer: Printer): Promise<boolean> {
    const adapter = ADAPTERS[printer.type];
    if (!adapter) return false;
    return adapter.isAvailable();
  }
}

export const printService = new PrintService();
