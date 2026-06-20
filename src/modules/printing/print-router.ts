import { ensureBluetoothConnected, printViaBluetooth } from "./bluetooth-client";
import { ensureUsbConnected, printViaUsb } from "./usb-client";
import { browserAdapter } from "./adapters/browser";
import type { EscPosReceiptInput } from "./escpos";
import { buildReceiptPrinterBytes } from "./receipt-printer-bytes";
import type { ReceiptData } from "./types";
import type { Printer } from "@/modules/stores/types";

export type PrintChannel = "bluetooth" | "usb" | "pdf";

export const CHANNEL_LABELS: Record<PrintChannel, string> = {
  bluetooth: "Bluetooth",
  usb: "USB",
  pdf: "PDF / Browser",
};

export interface PrintReceiptAutoOptions {
  skipBluetooth?: boolean;
}

/**
 * Prints a receipt using the configured fallback order: Bluetooth → USB → PDF.
 * ESC/POS bytes go to a connected Bluetooth/USB printer; otherwise the browser
 * print dialog (save as PDF) is used. Returns which channel handled it.
 */
export async function printReceiptAuto(
  escpos: EscPosReceiptInput,
  browser: ReceiptData,
  options: PrintReceiptAutoOptions = {},
): Promise<PrintChannel> {
  if (!options.skipBluetooth && await ensureBluetoothConnected()) {
    await printViaBluetooth(buildReceiptPrinterBytes(escpos, browser));
    return "bluetooth";
  }
  if (await ensureUsbConnected()) {
    await printViaUsb(buildReceiptPrinterBytes(escpos, browser));
    return "usb";
  }
  await browserAdapter.print(browser, {} as unknown as Printer);
  return "pdf";
}
