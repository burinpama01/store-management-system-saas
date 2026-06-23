"use client";

import type { ReceiptData } from "./types";
import { buildReceiptLines } from "./receipt-lines";
import { RASTER_WIDTH, packEscPosRaster, rgbaToMono, wrapRasterJob } from "./escpos-raster";
import { getReceiptQrMetrics } from "./receipt-qr";

/**
 * Renders the receipt to a monochrome bitmap on a <canvas> (Thai text via the
 * browser's own font rendering) and returns a full ESC/POS raster print job.
 * This is the reliable Bluetooth/USB path for Thai receipts — it does not depend
 * on the printer supporting any Thai code page.
 *
 * Returns null if a canvas 2D context is unavailable (caller should fall back).
 */
export function renderReceiptRaster(data: ReceiptData): Uint8Array | null {
  if (typeof document === "undefined") return null;

  const width = RASTER_WIDTH[data.paperWidth];
  const { lines } = buildReceiptLines(data);

  // Monospace so the pre-padded columns line up; size tuned to fit the dot width.
  const fontPx = data.paperWidth === "58mm" ? 20 : 22;
  const lineH = Math.round(fontPx * 1.25);
  const padX = 8;
  const padY = 8;
  const qrGap = Math.round(lineH * 0.6);
  const height = padY * 2 + lines.reduce((sum, line) => {
    if (!line.qrPayload) return sum + lineH;
    return sum + getReceiptQrMetrics(line.qrPayload, data.paperWidth).drawDots + qrGap;
  }, 0);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = "#000";
  ctx.textBaseline = "top";
  const baseFont = `${fontPx}px "Courier New", "Sarabun", monospace`;

  let y = padY;
  for (const line of lines) {
    if (line.qrPayload) {
      const { matrix, quietModules, cellDots, drawDots } = getReceiptQrMetrics(line.qrPayload, data.paperWidth);
      const x0 = Math.floor((width - drawDots) / 2);
      ctx.fillStyle = "#fff";
      ctx.fillRect(x0, y, drawDots, drawDots);
      ctx.fillStyle = "#000";
      for (let row = 0; row < matrix.size; row += 1) {
        for (let col = 0; col < matrix.size; col += 1) {
          if (matrix.isDark(row, col)) {
            ctx.fillRect(
              x0 + (col + quietModules) * cellDots,
              y + (row + quietModules) * cellDots,
              cellDots,
              cellDots,
            );
          }
        }
      }
      y += drawDots + qrGap;
      continue;
    }

    ctx.font = line.bold ? `bold ${baseFont}` : baseFont;
    const text = line.text ?? "";
    if (line.align === "center") {
      ctx.textAlign = "center";
      ctx.fillText(text, width / 2, y, width - padX * 2);
    } else {
      ctx.textAlign = "left";
      ctx.fillText(text, padX, y, width - padX * 2);
    }
    y += lineH;
  }

  const img = ctx.getImageData(0, 0, width, height);
  const mono = rgbaToMono(img.data, width, height);
  const raster = packEscPosRaster(width, height, mono);
  return wrapRasterJob(raster);
}
