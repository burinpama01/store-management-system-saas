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
 * แบ่งภาพเป็นแถบ GS v 0 โดยพยายามให้รอยต่อของแถบตกอยู่ใน "ช่องว่างระหว่างบรรทัด"
 * ที่ผู้เรียกบอกมา (`breaks` = ตำแหน่ง y ที่ตัดได้)
 *
 * เครื่องพิมพ์ความร้อนจะหยุดมอเตอร์ชั่วขณะระหว่างแถบ ถ้ารอยต่อไปตกกลางบรรทัด
 * ตัวหนังสือจะขาดครึ่งตัวตรงรอยนั้น — อาการ "พิมพ์ไม่ต่อเนื่อง ตัวหนังสือขาด"
 * ที่หน้าร้านเจอ. เมื่อไม่มีจุดตัดที่ปลอดภัยในระยะที่แถบยาวได้ ก็ตัดตามความยาวสูงสุด
 */
export function planRasterBands(height: number, breaks: number[] = []): Array<{ top: number; height: number }> {
  const safe = Array.from(new Set(breaks))
    .filter((value) => Number.isInteger(value) && value > 0 && value < height)
    .sort((a, b) => a - b);
  const bands: Array<{ top: number; height: number }> = [];
  let top = 0;
  let cursor = 0;
  while (top < height) {
    const limit = Math.min(top + MAX_RASTER_BAND_HEIGHT, height);
    let end = limit;
    if (limit < height) {
      while (cursor < safe.length && safe[cursor] <= top) cursor += 1;
      let best = -1;
      for (let i = cursor; i < safe.length && safe[i] <= limit; i += 1) best = safe[i];
      if (best > top) end = best;
    }
    bands.push({ top, height: end - top });
    top = end;
  }
  return bands;
}

/**
 * Packs a 1-byte-per-pixel monochrome bitmap (1 = black dot, 0 = white) into an
 * ESC/POS GS v 0 raster bit-image command. width must match the row stride of
 * `pixels` (length = width * height). `breaks` are y positions where splitting
 * the image into a new band is safe (see planRasterBands).
 */
export function packEscPosRaster(
  width: number,
  height: number,
  pixels: Uint8Array,
  breaks: number[] = [],
): Uint8Array {
  const bytesPerRow = Math.ceil(width / 8);
  const bands = planRasterBands(height, breaks);
  let totalLength = 0;
  for (const band of bands) {
    totalLength += 8 + bytesPerRow * band.height;
  }

  const body = new Uint8Array(totalLength);
  let p = 0;

  for (const band of bands) {
    const bandTop = band.top;
    const bandHeight = band.height;

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
 * Converts RGBA canvas pixels to a 1-bit monochrome buffer. The default
 * threshold is intentionally high so anti-aliased text edges print darker on
 * low-density thermal printers. Returns 1 = black dot.
 *
 * Use this for sharp graphics like QR codes — thresholding keeps the modules
 * crisp and scannable. For photos/logos prefer `floydSteinbergMono`.
 */
export function rgbaToMono(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number, threshold = 220): Uint8Array {
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

/**
 * Floyd–Steinberg error-diffusion dithering to 1-bit. Gives photos and logos a
 * grayscale-like appearance on a 1-bit thermal printer instead of a harsh hard
 * threshold. Returns 1 = black dot.
 */
export function floydSteinbergMono(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number): Uint8Array {
  // Luminance buffer (0 = black, 255 = white); transparent treated as white.
  const lum = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const a = rgba[i * 4 + 3];
    lum[i] = a < 128 ? 255 : 0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2];
  }

  const mono = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const old = lum[idx];
      const newVal = old < 128 ? 0 : 255;
      mono[idx] = newVal === 0 ? 1 : 0;
      const err = old - newVal;
      // Distribute the quantization error to neighbouring pixels.
      if (x + 1 < width) lum[idx + 1] += (err * 7) / 16;
      if (y + 1 < height) {
        if (x > 0) lum[idx + width - 1] += (err * 3) / 16;
        lum[idx + width] += (err * 5) / 16;
        if (x + 1 < width) lum[idx + width + 1] += (err * 1) / 16;
      }
    }
  }
  return mono;
}
