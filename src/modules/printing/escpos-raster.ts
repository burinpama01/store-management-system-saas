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
 * ความยาวขั้นต่ำของช่วงแถวขาวล้วนที่จะถูกแทนด้วยคำสั่งเลื่อนกระดาษ
 *
 * ที่มา: ใบเสร็จจริงของหน้าร้าน 94KB มีแถวขาวล้วน 44% ของภาพ (599 จาก 1,338 แถว)
 * ซึ่งถูกส่งเป็นข้อมูลรูปแถวละ 72 ไบต์ ทั้งที่ ESC J เลื่อนกระดาษได้ผลเท่ากันด้วย
 * 3 ไบต์ ยิ่งข้อมูลน้อย เวลาส่งผ่าน WiFi ไปเครื่องพิมพ์ยิ่งสั้น (ที่ร้านวัดได้
 * 4-23 วินาทีต่อใบ ซึ่งเกือบทั้งหมดคือเวลาส่ง ไม่ใช่เวลาพิมพ์)
 *
 * 12 แถว = 1.5 มม. เลือกจากการวัดใบเสร็จจริงสามใบ: เกณฑ์ 12 ลดขนาดได้ 31-35%
 * โดยจำนวนแถบเพิ่มจาก 6 เป็น 15-17 ส่วนเกณฑ์ 8 ลดได้ 38-42% แต่แถบพุ่งเป็น 25-28
 * ซึ่งแลกไม่คุ้ม เพราะทุกรอยต่อแถบคือจังหวะที่มอเตอร์หยุดแล้วออกตัวใหม่
 *
 * สั้นกว่านี้ยังไม่คุ้มอีกทางหนึ่งด้วย เพราะการปิด/เปิดแถบมี overhead 8 ไบต์
 */
const MIN_BLANK_RUN_ROWS = 12;

/** ESC J เลื่อนกระดาษได้สูงสุด 255 จุดต่อคำสั่ง */
const MAX_FEED_DOTS = 255;

type RasterSegment =
  | { kind: "content"; top: number; height: number }
  | { kind: "feed"; dots: number };

/** แถวนี้ขาวล้วน (ไม่มีจุดดำสักจุด) หรือไม่ */
function isBlankRow(pixels: Uint8Array, width: number, y: number): boolean {
  const start = y * width;
  for (let x = 0; x < width; x += 1) {
    if (pixels[start + x]) return false;
  }
  return true;
}

/**
 * แบ่งภาพเป็นช่วงที่มีเนื้อหา คั่นด้วยช่วงขาวที่ยาวพอจะแทนด้วยการเลื่อนกระดาษ
 *
 * ช่วงขาวที่สั้นกว่าเกณฑ์จะถูกปล่อยไว้ในภาพตามเดิม เพื่อให้ระยะห่างระหว่างบรรทัด
 * ยังมาจากตัวภาพ ไม่ต้องพึ่งความแม่นของการเลื่อนกระดาษในระยะสั้น ๆ
 */
export function planRasterSegments(
  width: number,
  height: number,
  pixels: Uint8Array,
  minBlankRun: number = MIN_BLANK_RUN_ROWS,
): RasterSegment[] {
  const segments: RasterSegment[] = [];
  let contentTop = 0;
  let y = 0;
  while (y < height) {
    if (!isBlankRow(pixels, width, y)) {
      y += 1;
      continue;
    }
    let runEnd = y;
    while (runEnd < height && isBlankRow(pixels, width, runEnd)) runEnd += 1;
    const run = runEnd - y;
    if (run >= minBlankRun) {
      if (y > contentTop) segments.push({ kind: "content", top: contentTop, height: y - contentTop });
      segments.push({ kind: "feed", dots: run });
      contentTop = runEnd;
    }
    y = runEnd;
  }
  if (height > contentTop) segments.push({ kind: "content", top: contentTop, height: height - contentTop });
  return segments;
}

/**
 * Packs a 1-byte-per-pixel monochrome bitmap (1 = black dot, 0 = white) into an
 * ESC/POS GS v 0 raster bit-image command. width must match the row stride of
 * `pixels` (length = width * height). `breaks` are y positions where splitting
 * the image into a new band is safe (see planRasterBands).
 *
 * ช่วงขาวยาว ๆ ถูกส่งเป็นคำสั่งเลื่อนกระดาษแทนข้อมูลรูป ผลที่ออกมาบนกระดาษ
 * เหมือนเดิมทุกจุด แต่ข้อมูลที่ต้องส่งลดลง 31-35% เมื่อวัดกับใบเสร็จจริงของหน้าร้าน
 */
export function packEscPosRaster(
  width: number,
  height: number,
  pixels: Uint8Array,
  breaks: number[] = [],
): Uint8Array {
  const bytesPerRow = Math.ceil(width / 8);
  const segments = planRasterSegments(width, height, pixels);
  const bands: Array<{ top: number; height: number } | { feed: number }> = [];
  for (const segment of segments) {
    if (segment.kind === "feed") {
      let left = segment.dots;
      while (left > 0) {
        const step = Math.min(left, MAX_FEED_DOTS);
        bands.push({ feed: step });
        left -= step;
      }
      continue;
    }
    // breaks ของผู้เรียกอยู่ในพิกัดของภาพเต็ม ต้องเลื่อนให้เป็นพิกัดภายในช่วงนี้
    const localBreaks = breaks
      .filter((value) => value > segment.top && value < segment.top + segment.height)
      .map((value) => value - segment.top);
    for (const band of planRasterBands(segment.height, localBreaks)) {
      bands.push({ top: segment.top + band.top, height: band.height });
    }
  }

  let totalLength = 0;
  for (const band of bands) {
    totalLength += "feed" in band ? 3 : 8 + bytesPerRow * band.height;
  }

  const body = new Uint8Array(totalLength);
  let p = 0;

  for (const band of bands) {
    if ("feed" in band) {
      // ESC J n — พิมพ์บัฟเฟอร์แล้วเลื่อนกระดาษ n จุด ให้ผลเท่ากับพิมพ์แถวขาว n แถว
      body[p++] = ESC;
      body[p++] = 0x4a; // 'J'
      body[p++] = band.feed & 0xff;
      continue;
    }
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
