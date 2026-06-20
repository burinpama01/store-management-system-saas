import { buildEscPosReceipt, type EscPosReceiptInput } from "./escpos";
import { renderReceiptRaster } from "./receipt-raster-client";
import { normalizePrintCopies, type ReceiptData } from "./types";

function repeatReceiptJob(job: Uint8Array, copies: number): Uint8Array {
  if (copies <= 1) return job;
  const repeated = new Uint8Array(job.length * copies);
  for (let i = 0; i < copies; i += 1) {
    repeated.set(job, i * job.length);
  }
  return repeated;
}

/**
 * Prefer browser-rendered raster bytes so Thai text does not depend on a
 * thermal printer code page. Fall back to text ESC/POS when canvas is absent.
 */
export function buildReceiptPrinterBytes(escpos: EscPosReceiptInput, browser: ReceiptData): Uint8Array {
  const copies = normalizePrintCopies(browser.printCopies);
  try {
    const raster = renderReceiptRaster(browser);
    if (raster && raster.length > 8) return repeatReceiptJob(raster, copies);
  } catch {
    /* fall through to text ESC/POS */
  }
  return repeatReceiptJob(buildEscPosReceipt(escpos), copies);
}
