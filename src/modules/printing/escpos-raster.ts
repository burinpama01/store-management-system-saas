// ESC/POS raster (image) printing — the reliable path for Thai receipts on cheap
// thermal printers (e.g. PT-280) that lack a Thai code page. The receipt is
// rendered to a 1-bit bitmap and sent with GS v 0, so text prints as an image
// regardless of printer firmware/encoding support.

// Printer dot width per paper size (203 dpi): 58mm ≈ 384 dots, 80mm ≈ 576 dots.
export const RASTER_WIDTH: Record<"58mm" | "80mm", number> = { "58mm": 384, "80mm": 576 };

const ESC = 0x1b;
const GS = 0x1d;

/**
 * Packs a 1-byte-per-pixel monochrome bitmap (1 = black dot, 0 = white) into an
 * ESC/POS GS v 0 raster bit-image command. width must match the row stride of
 * `pixels` (length = width * height).
 */
export function packEscPosRaster(width: number, height: number, pixels: Uint8Array): Uint8Array {
  const bytesPerRow = Math.ceil(width / 8);
  const body = new Uint8Array(8 + bytesPerRow * height);
  // GS v 0 m xL xH yL yH
  body[0] = GS;
  body[1] = 0x76; // 'v'
  body[2] = 0x30; // '0'
  body[3] = 0; // m = normal
  body[4] = bytesPerRow & 0xff;
  body[5] = (bytesPerRow >> 8) & 0xff;
  body[6] = height & 0xff;
  body[7] = (height >> 8) & 0xff;

  let p = 8;
  for (let y = 0; y < height; y++) {
    const rowStart = y * width;
    for (let bx = 0; bx < bytesPerRow; bx++) {
      let b = 0;
      for (let bit = 0; bit < 8; bit++) {
        const x = bx * 8 + bit;
        if (x < width && pixels[rowStart + x]) b |= 0x80 >> bit;
      }
      body[p++] = b;
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
