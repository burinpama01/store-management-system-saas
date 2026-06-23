// ESC/POS raster (image) printing — the reliable path for Thai receipts on cheap
// thermal printers (e.g. PT-280) that lack a Thai code page. The receipt is
// rendered to a 1-bit bitmap and sent with GS v 0, so text prints as an image
// regardless of printer firmware/encoding support.

// Printer dot width per paper size (203 dpi): 58mm ≈ 384 dots, 80mm ≈ 576 dots.
export const RASTER_WIDTH: Record<"58mm" | "80mm", number> = { "58mm": 384, "80mm": 576 };

const ESC = 0x1b;
const GS = 0x1d;
const MAX_RASTER_BAND_HEIGHT = 240;

/**
 * Packs a 1-byte-per-pixel monochrome bitmap (1 = black dot, 0 = white) into an
 * ESC/POS GS v 0 raster bit-image command. width must match the row stride of
 * `pixels` (length = width * height).
 */
export function packEscPosRaster(width: number, height: number, pixels: Uint8Array): Uint8Array {
  const bytesPerRow = Math.ceil(width / 8);
  let totalLength = 0;
  for (let y = 0; y < height; y += MAX_RASTER_BAND_HEIGHT) {
    const bandHeight = Math.min(MAX_RASTER_BAND_HEIGHT, height - y);
    totalLength += 8 + bytesPerRow * bandHeight;
  }

  const body = new Uint8Array(totalLength);
  let p = 0;

  for (let bandTop = 0; bandTop < height; bandTop += MAX_RASTER_BAND_HEIGHT) {
    const bandHeight = Math.min(MAX_RASTER_BAND_HEIGHT, height - bandTop);

    // GS v 0 m xL xH yL yH. Keep yH zero because some mobile printers ignore
    // it and print the remaining raster bytes as garbage at the receipt tail.
    body[p++] = GS;
    body[p++] = 0x76; // 'v'
    body[p++] = 0x30; // '0'
    body[p++] = 0; // m = normal
    body[p++] = bytesPerRow & 0xff;
    body[p++] = (bytesPerRow >> 8) & 0xff;
    body[p++] = bandHeight & 0xff;
    body[p++] = 0;

    for (let y = 0; y < bandHeight; y++) {
      const rowStart = (bandTop + y) * width;
      for (let bx = 0; bx < bytesPerRow; bx++) {
        let b = 0;
        for (let bit = 0; bit < 8; bit++) {
          const x = bx * 8 + bit;
          if (x < width && pixels[rowStart + x]) b |= 0x80 >> bit;
        }
        body[p++] = b;
      }
    }
  }
  return body;
}

/** Wraps raster image bytes with printer init + a feed/cut so a full job can be sent. */
export function wrapRasterJob(raster: Uint8Array): Uint8Array {
  const init = [ESC, 0x40]; // ESC @  (reset)
  const feedCut = [0x0a, 0x0a, 0x0a, GS, 0x56, 0x41, 0x03]; // feed 3 + partial cut
  const out = new Uint8Array(init.length + raster.length + feedCut.length);
  out.set(init, 0);
  out.set(raster, init.length);
  out.set(feedCut, init.length + raster.length);
  return out;
}

/**
 * Converts RGBA canvas pixels to a 1-bit monochrome buffer via luminance
 * threshold (default mid-gray). Returns 1 = black dot.
 */
export function rgbaToMono(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number, threshold = 160): Uint8Array {
  const mono = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const r = rgba[i * 4];
    const g = rgba[i * 4 + 1];
    const b = rgba[i * 4 + 2];
    const a = rgba[i * 4 + 3];
    // Treat transparent as white; luminance below threshold = black dot.
    const lum = a < 128 ? 255 : 0.299 * r + 0.587 * g + 0.114 * b;
    mono[i] = lum < threshold ? 1 : 0;
  }
  return mono;
}
