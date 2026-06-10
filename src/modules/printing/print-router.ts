import { ensureBluetoothConnected, printViaBluetooth } from "./bluetooth-client";
import { ensureUsbConnected, printViaUsb } from "./usb-client";
import { browserAdapter } from "./adapters/browser";
import { buildEscPosReceipt, type EscPosReceiptInput } from "./escpos";
import { renderReceiptRaster } from "./receipt-raster-client";
import type { ReceiptData } from "./types";
import type { Printer } from "@/modules/stores/types";

export type PrintChannel = "bluetooth" | "usb" | "pdf";

export const CHANNEL_LABELS: Record<PrintChannel, string> = {
  bluetooth: "Bluetooth",
  usb: "USB",
  pdf: "PDF / Browser",
};

/**
 * Bytes to send to a thermal printer. Prefer an image/raster job — Thai text
 * renders reliably regardless of the printer's code-page support (fixes blank
 * output on printers like the PT-280). Falls back to text ESC/POS.
 */
function receiptBytes(escpos: EscPosReceiptInput, browser: ReceiptData): Uint8Array {
  try {
    const raster = renderReceiptRaster(browser);
    if (raster && raster.length > 8) return raster;
  } catch {
    /* fall through to text ESC/POS */
  }
  return buildEscPosReceipt(escpos);
}

/**
 * Prints a receipt using the configured fallback order: Bluetooth → USB → PDF.
 * ESC/POS bytes go to a connected Bluetooth/USB printer; otherwise the browser
 * print dialog (save as PDF) is used. Returns which channel handled it.
 */
export async function printReceiptAuto(
  escpos: EscPosReceiptInput,
  browser: ReceiptData,
): Promise<PrintChannel> {
  if (await ensureBluetoothConnected()) {
    await printViaBluetooth(receiptBytes(escpos, browser));
    return "bluetooth";
  }
  if (await ensureUsbConnected()) {
    await printViaUsb(receiptBytes(escpos, browser));
    return "usb";
  }
  await browserAdapter.print(browser, {} as unknown as Printer);
  return "pdf";
}
