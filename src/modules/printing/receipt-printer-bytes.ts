import { buildEscPosReceipt, type EscPosReceiptInput } from "./escpos";
import { buildReceiptPromptPayQr } from "./receipt-qr";
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
export async function buildReceiptPrinterBytes(escpos: EscPosReceiptInput, browser: ReceiptData): Promise<Uint8Array> {
  const copies = normalizePrintCopies(browser.printCopies);
  // QR-bearing receipts (PromptPay, or a table-open QR slip) must render as a
  // raster image so the QR is scannable and Thai text is code-page-independent.
  const requiresRaster = Boolean(buildReceiptPromptPayQr(browser)) || browser.ticketMode === "table_qr";
  const rasterError = "QR ต้องพิมพ์ผ่าน raster image กรุณาสั่งพิมพ์จาก browser ที่รองรับ canvas";
  try {
    const raster = await renderReceiptRaster(browser);
    if (raster && raster.length > 8) return repeatReceiptJob(raster, copies);
  } catch {
    if (requiresRaster) {
      throw new Error(rasterError);
    }
    /* fall through to text ESC/POS */
  }
  if (requiresRaster) {
    throw new Error(rasterError);
  }
  return repeatReceiptJob(buildEscPosReceipt(escpos), copies);
}
