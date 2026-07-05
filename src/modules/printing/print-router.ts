import { ensureBluetoothConnected, printViaBluetooth } from "./bluetooth-client";
import { ensureUsbConnected, printViaUsb } from "./usb-client";
import {
  ensureNativeBluetoothConnected,
  isNativePlatform,
  printViaNativeBluetooth,
} from "./native-print-client";
import { browserAdapter } from "./adapters/browser";
import type { EscPosReceiptInput } from "./escpos";
import { buildReceiptPrinterBytes } from "./receipt-printer-bytes";
import type { ReceiptData } from "./types";
import type { Printer } from "@/modules/stores/types";

export type PrintChannel = "native-bluetooth" | "bluetooth" | "usb" | "pdf";

export const CHANNEL_LABELS: Record<PrintChannel, string> = {
  "native-bluetooth": "Bluetooth (แอป)",
  bluetooth: "Bluetooth",
  usb: "USB",
  pdf: "PDF / Browser",
};

export interface PrintReceiptAutoOptions {
  skipBluetooth?: boolean;
}

/**
 * Prints a receipt using the fallback order:
 *   native BLE (มือถือ) → Web Bluetooth → USB → PDF.
 * The native BLE path lets the StoreOS app print to thermal printers on iOS/Android
 * where the WebView has no Web Bluetooth/WebUSB. The same ESC/POS raster bytes are
 * used on every channel, so Thai text prints identically. Returns the channel used.
 */
export async function printReceiptAuto(
  escpos: EscPosReceiptInput,
  browser: ReceiptData,
  options: PrintReceiptAutoOptions = {},
): Promise<PrintChannel> {
  if (!options.skipBluetooth && isNativePlatform() && await ensureNativeBluetoothConnected()) {
    await printViaNativeBluetooth(await buildReceiptPrinterBytes(escpos, browser));
    return "native-bluetooth";
  }
  if (!options.skipBluetooth && await ensureBluetoothConnected()) {
    await printViaBluetooth(await buildReceiptPrinterBytes(escpos, browser));
    return "bluetooth";
  }
  if (await ensureUsbConnected()) {
    await printViaUsb(await buildReceiptPrinterBytes(escpos, browser));
    return "usb";
  }
  await browserAdapter.print(browser, {} as unknown as Printer);
  return "pdf";
}
