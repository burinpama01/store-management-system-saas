"use client";

import type { ReceiptData } from "./types";
import { buildReceiptLines, type ReceiptLine } from "./receipt-lines";
import { RASTER_WIDTH, floydSteinbergMono, packEscPosRaster, rgbaToMono, wrapRasterJob } from "./escpos-raster";
import { getReceiptQrMetrics } from "./receipt-qr";

const TEXT_DARKEN_OFFSET_DOTS = 0.7;

interface LoadedImage {
  source: CanvasImageSource;
  width: number;
  height: number;
}

interface PreparedImage {
  source: CanvasImageSource;
  drawW: number;
  drawH: number;
  kind: NonNullable<ReceiptLine["imageKind"]>;
}

/** Fetches a URL and decodes it to a non-tainting bitmap, or null on any failure. */
async function decodeBitmap(url: string, init?: RequestInit): Promise<LoadedImage | null> {
  try {
    const res = await fetch(url, { cache: "no-store", ...init });
    if (!res.ok) return null;
    const bitmap = await createImageBitmap(await res.blob());
    if (bitmap.width > 0 && bitmap.height > 0) {
      return { source: bitmap, width: bitmap.width, height: bitmap.height };
    }
  } catch {
    /* caller falls back */
  }
  return null;
}

/**
 * Loads a receipt image for canvas drawing without tainting the canvas — the
 * reason uploaded logos/QRs printed blank on the IP / Print Hub raster path
 * while showing fine on the browser/PDF receipt.
 *
 * Order of attempts:
 *  1. Same-origin proxy (`/api/receipt-image`) — bulletproof: the image is
 *     served from our own origin, so there is no CORS/cache/browser variance
 *     and the canvas is never tainted (works on PC, iPad, Android alike).
 *  2. Direct CORS fetch — for non-Supabase pasted URLs that send CORS headers.
 *  3. `crossOrigin` <img> with a cache-buster — last resort.
 *
 * A blob-decoded `ImageBitmap` (1 & 2) is never origin-tainted, so getImageData
 * always succeeds and the image ends up in the raster bytes.
 */
async function loadImage(url: string): Promise<LoadedImage | null> {
  if (typeof fetch === "function" && typeof createImageBitmap === "function") {
    const proxied = await decodeBitmap(`/api/receipt-image?src=${encodeURIComponent(url)}`);
    if (proxied) return proxied;

    const direct = await decodeBitmap(url, { mode: "cors" });
    if (direct) return direct;
  }

  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve({ source: img, width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => resolve(null);
    img.src = url + (url.includes("?") ? "&" : "?") + "storeosCors=1";
  });
}

/** Fits an image into the printable width, capped by a per-kind max height. */
function fitImage(natW: number, natH: number, maxW: number, maxH: number): { drawW: number; drawH: number } {
  if (natW <= 0 || natH <= 0) return { drawW: 0, drawH: 0 };
  let drawW = Math.min(natW, maxW);
  let drawH = Math.round((drawW / natW) * natH);
  if (drawH > maxH) {
    drawH = maxH;
    drawW = Math.round((drawH / natH) * natW);
  }
  return { drawW: Math.max(1, drawW), drawH: Math.max(1, drawH) };
}

/**
 * Renders the receipt to a monochrome bitmap on a <canvas> (Thai text via the
 * browser's own font rendering) and returns a full ESC/POS raster print job.
 * This is the reliable Bluetooth/USB path for Thai receipts — it does not depend
 * on the printer supporting any Thai code page.
 *
 * Header logo + footer image (e.g. a LINE/static QR) are drawn onto the same
 * bitmap, so every channel (BT/USB/IP bridge/Print Hub) prints them identically.
 *
 * Returns null if a canvas 2D context is unavailable (caller should fall back).
 */
export async function renderReceiptRaster(data: ReceiptData): Promise<Uint8Array | null> {
  if (typeof document === "undefined") return null;

  const width = RASTER_WIDTH[data.paperWidth];
  const { lines } = buildReceiptLines(data);

  // Monospace so the pre-padded columns line up; size tuned to fit the dot width.
  const fontPx = data.paperWidth === "58mm" ? 20 : 22;
  const lineH = Math.round(fontPx * 1.25);
  const padX = 8;
  const padY = 8;
  const qrGap = Math.round(lineH * 0.6);
  const imageGap = Math.round(lineH * 0.5);
  const maxImgW = width - padX * 2;
  const logoMaxH = Math.round(width * 0.5);
  const footerMaxH = Math.round(width * 0.85);

  // Pre-load images so their dimensions are known before the canvas is sized.
  const prepared = new Map<ReceiptLine, PreparedImage>();
  await Promise.all(
    lines
      .filter((line) => line.imageUrl)
      .map(async (line) => {
        const loaded = await loadImage(line.imageUrl as string);
        if (!loaded || !loaded.width || !loaded.height) return;
        const kind = line.imageKind ?? "footer";
        const { drawW, drawH } = fitImage(
          loaded.width,
          loaded.height,
          maxImgW,
          kind === "logo" ? logoMaxH : footerMaxH,
        );
        if (drawW > 0 && drawH > 0) prepared.set(line, { source: loaded.source, drawW, drawH, kind });
      }),
  );

  const height = padY * 2 + lines.reduce((sum, line) => {
    if (line.imageUrl) {
      const prep = prepared.get(line);
      return prep ? sum + prep.drawH + imageGap : sum;
    }
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

  const drawText = (text: string, x: number, y: number, maxWidth: number) => {
    ctx.fillText(text, x, y, maxWidth);
    ctx.fillText(text, x + TEXT_DARKEN_OFFSET_DOTS, y, maxWidth);
  };

  /** Draws a prepared image as a dithered/thresholded 1-bit stamp onto the canvas. */
  const drawImageMono = (prep: PreparedImage, x0: number, y: number) => {
    const tmp = document.createElement("canvas");
    tmp.width = prep.drawW;
    tmp.height = prep.drawH;
    const tctx = tmp.getContext("2d");
    if (!tctx) return;
    tctx.fillStyle = "#fff";
    tctx.fillRect(0, 0, prep.drawW, prep.drawH);
    tctx.drawImage(prep.source, 0, 0, prep.drawW, prep.drawH);
    let src: Uint8ClampedArray;
    try {
      src = tctx.getImageData(0, 0, prep.drawW, prep.drawH).data;
    } catch {
      return; // tainted canvas (image lacked CORS headers) — skip silently
    }
    const mono = prep.kind === "logo"
      ? floydSteinbergMono(src, prep.drawW, prep.drawH)
      : rgbaToMono(src, prep.drawW, prep.drawH, 200);
    const out = ctx.createImageData(prep.drawW, prep.drawH);
    for (let i = 0; i < mono.length; i++) {
      const v = mono[i] ? 0 : 255;
      out.data[i * 4] = v;
      out.data[i * 4 + 1] = v;
      out.data[i * 4 + 2] = v;
      out.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(out, x0, y);
  };

  let y = padY;
  for (const line of lines) {
    if (line.imageUrl) {
      const prep = prepared.get(line);
      if (!prep) continue;
      const x0 = Math.floor((width - prep.drawW) / 2);
      drawImageMono(prep, x0, y);
      y += prep.drawH + imageGap;
      continue;
    }

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

    ctx.font = line.bold ? `700 ${baseFont}` : `600 ${baseFont}`;
    const text = line.text ?? "";
    if (line.align === "center") {
      ctx.textAlign = "center";
      drawText(text, width / 2, y, width - padX * 2);
    } else {
      ctx.textAlign = "left";
      drawText(text, padX, y, width - padX * 2);
    }
    y += lineH;
  }

  const img = ctx.getImageData(0, 0, width, height);
  const mono = rgbaToMono(img.data, width, height);
  const raster = packEscPosRaster(width, height, mono);
  return wrapRasterJob(raster);
}
