import { isBluetoothPrinterConnected, printViaBluetooth } from "./bluetooth-client";
import { isUsbPrinterConnected, printViaUsb } from "./usb-client";
import { browserAdapter } from "./adapters/browser";
import { buildEscPosReceipt, type EscPosReceiptInput } from "./escpos";
import type { ReceiptData } from "./types";
import type { Printer } from "@/modules/stores/types";

export type PrintChannel = "bluetooth" | "usb" | "pdf";

export const CHANNEL_LABELS: Record<PrintChannel, string> = {
  bluetooth: "Bluetooth",
  usb: "USB",
  pdf: "PDF / Browser",
};

/**
 * Prints a receipt using the configured fallback order: Bluetooth → USB → PDF.
 * ESC/POS bytes go to a connected Bluetooth/USB printer; otherwise the browser
 * print dialog (save as PDF) is used. Returns which channel handled it.
 */
export async function printReceiptAuto(
  escpos: EscPosReceiptInput,
  browser: ReceiptData,
): Promise<PrintChannel> {
  if (isBluetoothPrinterConnected()) {
    await printViaBluetooth(buildEscPosReceipt(escpos));
    return "bluetooth";
  }
  if (isUsbPrinterConnected()) {
    await printViaUsb(buildEscPosReceipt(escpos));
    return "usb";
  }
  await browserAdapter.print(browser, {} as unknown as Printer);
  return "pdf";
}
