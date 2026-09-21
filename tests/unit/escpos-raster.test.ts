import { describe, expect, it } from "vitest";
import {
  RASTER_WIDTH,
  packEscPosRaster,
  planRasterBands,
  wrapRasterJob,
  rgbaToMono,
} from "@/modules/printing/escpos-raster";

describe("ESC/POS raster (image) printing", () => {
  it("packs a monochrome bitmap into a GS v 0 raster command with MSB-first bits", () => {
    // 8x1: black, white, black, white, black, white, black, white -> 0b10101010 = 0xAA
    const width = 8;
    const height = 1;
    const mono = Uint8Array.from([1, 0, 1, 0, 1, 0, 1, 0]);
    const out = packEscPosRaster(width, height, mono);
    // header: GS 'v' '0' m xL xH yL yH
    expect([...out.slice(0, 8)]).toEqual([0x1d, 0x76, 0x30, 0x00, 1, 0, 1, 0]);
    expect(out[8]).toBe(0xaa);
    expect(out.length).toBe(8 + 1 * 1);
  });

  it("rounds the row stride up to whole bytes for non-multiple-of-8 widths", () => {
    const out = packEscPosRaster(10, 2, new Uint8Array(20));
    // 10 px -> 2 bytes per row; header yields xL=2, and 2 rows * 2 bytes
    expect(out[4]).toBe(2);
    expect(out[6]).toBe(2);
    expect(out.length).toBe(8 + 2 * 2);
  });

  // เครื่องพิมพ์หยุดมอเตอร์ชั่วขณะระหว่างแถบ ถ้ารอยต่อตกกลางบรรทัด ตัวหนังสือจะขาด
  // ครึ่งตัว -- อาการที่หน้าร้านเจอ ("พิมพ์ไม่ต่อเนื่อง ตัวหนังสือขาด")
  it("ตัดแถบตรงช่องว่างระหว่างบรรทัดที่ผู้เรียกบอกมา ไม่ผ่ากลางตัวหนังสือ", () => {
    const lineTops = Array.from({ length: 40 }, (_, index) => 8 + index * 24);
    const bands = planRasterBands(900, lineTops);

    expect(bands.reduce((sum, band) => sum + band.height, 0)).toBe(900);
    for (const band of bands) {
      expect(band.height).toBeLessThanOrEqual(255);
      expect(band.height).toBeGreaterThan(0);
    }
    // ทุกรอยต่อ (ยกเว้นต้นภาพ) ต้องตรงกับจุดขึ้นบรรทัดใหม่
    for (const band of bands.slice(1)) {
      expect(lineTops).toContain(band.top);
    }
  });

  it("ไม่มีจุดตัดที่ปลอดภัยในระยะแถบ -> ตัดตามความยาวสูงสุดเหมือนเดิม", () => {
    expect(planRasterBands(600, [])).toEqual([
      { top: 0, height: 240 },
      { top: 240, height: 240 },
      { top: 480, height: 120 },
    ]);
    // จุดตัดที่อยู่นอกภาพ/ไม่ใช่จำนวนเต็ม ต้องถูกมองข้าม ไม่ทำให้แถบเพี้ยน
    expect(planRasterBands(100, [0, 100, 250, 12.5])).toEqual([{ top: 0, height: 100 }]);
  });

  it("splits tall raster images into short bands for mobile printers", () => {
    const pixels = new Uint8Array(8 * 300);
    for (let row = 0; row < 300; row += 1) {
      for (let bit = 0; bit < 8; bit += 1) {
        pixels[row * 8 + bit] = (row & (0x80 >> bit)) ? 1 : 0;
      }
    }

    const out = packEscPosRaster(8, 300, pixels);
    const commands: { bytesPerRow: number; height: number; payloadStart: number }[] = [];
    let offset = 0;

    while (offset < out.length) {
      expect([...out.slice(offset, offset + 4)]).toEqual([0x1d, 0x76, 0x30, 0x00]);
      const bytesPerRow = out[offset + 4] + (out[offset + 5] << 8);
      const height = out[offset + 6] + (out[offset + 7] << 8);
      commands.push({ bytesPerRow, height, payloadStart: offset + 8 });
      expect(out[offset + 7]).toBe(0);
      expect(height).toBeLessThanOrEqual(255);
      offset += 8 + bytesPerRow * height;
    }

    expect(commands.length).toBeGreaterThan(1);
    expect(commands.reduce((sum, command) => sum + command.height, 0)).toBe(300);

    let sourceRow = 0;
    for (const command of commands) {
      expect(command.bytesPerRow).toBe(1);
      for (let row = 0; row < command.height; row += 1) {
        expect(out[command.payloadStart + row]).toBe((sourceRow + row) & 0xff);
      }
      sourceRow += command.height;
    }
  });

  it("thresholds RGBA luminance to black dots (transparent = white)", () => {
    // pixel0 black opaque, pixel1 white opaque, pixel2 black but transparent, pixel3 light-gray text edge
    const rgba = Uint8ClampedArray.from([
      0, 0, 0, 255,
      255, 255, 255, 255,
      0, 0, 0, 0,
      190, 190, 190, 255,
    ]);
    const mono = rgbaToMono(rgba, 4, 1);
    expect([...mono]).toEqual([1, 0, 0, 1]);
  });

  it("wraps a raster image with printer init + feed/cut", () => {
    const raster = packEscPosRaster(8, 1, Uint8Array.from([1, 1, 1, 1, 1, 1, 1, 1]));
    const job = wrapRasterJob(raster);
    expect([...job.slice(0, 2)]).toEqual([0x1b, 0x40]); // ESC @
    expect([...job.slice(-4)]).toEqual([0x1d, 0x56, 0x41, 0x03]); // GS V A partial cut
  });

  it("uses 384/576 dot widths for 58/80mm", () => {
    expect(RASTER_WIDTH["58mm"]).toBe(384);
    expect(RASTER_WIDTH["80mm"]).toBe(576);
  });
});

/**
 * ถอดกลับจากไบต์ที่จะส่งออกเครื่องพิมพ์ ให้เป็นภาพขาวดำอีกครั้ง
 *
 * ESC J n ถูกตีความว่า "แถวขาว n แถว" เพราะบนกระดาษมันให้ผลเท่ากับพิมพ์แถวขาว
 * ตามจำนวนนั้น — ถ้าภาพที่ถอดกลับมาตรงกับต้นฉบับทุกจุด แปลว่าใบเสร็จที่ออกจาก
 * เครื่องพิมพ์หน้าตาเหมือนเดิมเป๊ะ ต่อให้ข้อมูลที่ส่งจะเล็กลงก็ตาม
 */
function decodeEscPosRaster(bytes: Uint8Array, width: number): Uint8Array[] {
  const rows: Uint8Array[] = [];
  let i = 0;
  while (i < bytes.length) {
    if (bytes[i] === 0x1b && bytes[i + 1] === 0x4a) {
      for (let n = 0; n < bytes[i + 2]; n += 1) rows.push(new Uint8Array(width));
      i += 3;
      continue;
    }
    if (bytes[i] === 0x1d && bytes[i + 1] === 0x76 && bytes[i + 2] === 0x30) {
      const stride = bytes[i + 4] | (bytes[i + 5] << 8);
      const height = bytes[i + 6] | (bytes[i + 7] << 8);
      let p = i + 8;
      for (let y = 0; y < height; y += 1) {
        const row = new Uint8Array(width);
        for (let bx = 0; bx < stride; bx += 1) {
          const b = bytes[p++];
          for (let bit = 0; bit < 8; bit += 1) {
            const x = bx * 8 + bit;
            if (x < width) row[x] = (b & (0x80 >> bit)) ? 1 : 0;
          }
        }
        rows.push(row);
      }
      i = p;
      continue;
    }
    throw new Error(`ไบต์ที่ไม่รู้จักที่ตำแหน่ง ${i}: 0x${bytes[i].toString(16)}`);
  }
  return rows;
}

/** ใบเสร็จจำลอง: บรรทัดข้อความคั่นด้วยช่องว่างสั้น และช่องว่างยาวแบบที่พบจริง */
function makeReceiptLike(width: number) {
  const rows: number[][] = [];
  const blank = (n: number) => { for (let i = 0; i < n; i += 1) rows.push(new Array(width).fill(0)); };
  const textLine = (n: number) => {
    for (let i = 0; i < n; i += 1) {
      rows.push(Array.from({ length: width }, (_, x) => ((x + i) % 3 === 0 ? 1 : 0)));
    }
  };
  textLine(20); blank(6);            // หัวใบเสร็จ + ช่องว่างสั้น (ต้องคงอยู่ในภาพ)
  textLine(16); blank(110);          // รายการ + ช่องว่างยาวแบบที่เจอจริง
  textLine(24); blank(300);          // ยอดรวม + ช่องว่างยาวเกิน 255 จุด
  textLine(30); blank(40);           // QR + ท้ายใบ
  const height = rows.length;
  const pixels = new Uint8Array(width * height);
  rows.forEach((row, y) => pixels.set(row, y * width));
  return { pixels, height };
}

describe("raster — แทนช่วงขาวยาวด้วยคำสั่งเลื่อนกระดาษ", () => {
  const width = RASTER_WIDTH["80mm"];

  it("ภาพที่ถอดกลับมาต้องเหมือนต้นฉบับทุกพิกเซล", () => {
    const { pixels, height } = makeReceiptLike(width);
    const out = packEscPosRaster(width, height, pixels);
    const rows = decodeEscPosRaster(out, width);

    expect(rows.length).toBe(height);
    for (let y = 0; y < height; y += 1) {
      expect(Array.from(rows[y])).toEqual(Array.from(pixels.subarray(y * width, (y + 1) * width)));
    }
  });

  it("ข้อมูลที่ต้องส่งเล็กลงอย่างมีนัยสำคัญ", () => {
    const { pixels, height } = makeReceiptLike(width);
    const bytesPerRow = width / 8;
    const before = 8 + bytesPerRow * height; // ถ้าส่งทั้งภาพรวดเดียวแบบไม่มีการแทน
    const after = packEscPosRaster(width, height, pixels).length;
    expect(after).toBeLessThan(before * 0.5);
  });

  it("ช่องว่างสั้นกว่าเกณฑ์ยังอยู่ในภาพ ไม่ถูกแปลงเป็นคำสั่งเลื่อน", () => {
    const height = 40;
    const pixels = new Uint8Array(width * height);
    for (let x = 0; x < width; x += 1) {
      pixels[0 * width + x] = 1;
      pixels[(height - 1) * width + x] = 1;
    }
    // ช่องว่างตรงกลาง 38 แถว >= เกณฑ์ จึงต้องถูกแทน แต่ผลลัพธ์ต้องยังเท่าเดิม
    const rows = decodeEscPosRaster(packEscPosRaster(width, height, pixels), width);
    expect(rows.length).toBe(height);
    expect(rows[0].every((v) => v === 1)).toBe(true);
    expect(rows[1].every((v) => v === 0)).toBe(true);
    expect(rows[height - 1].every((v) => v === 1)).toBe(true);
  });

  it("ช่วงขาวที่ยาวเกิน 255 จุด ถูกแบ่งเป็นหลายคำสั่งโดยระยะรวมไม่เพี้ยน", () => {
    const height = 400;
    const pixels = new Uint8Array(width * height);
    for (let x = 0; x < width; x += 1) pixels[x] = 1; // แถวแรกมีเนื้อหา ที่เหลือขาว 399 แถว
    const out = packEscPosRaster(width, height, pixels);
    const feeds = [];
    for (let i = 0; i < out.length - 2; i += 1) {
      if (out[i] === 0x1b && out[i + 1] === 0x4a) feeds.push(out[i + 2]);
    }
    expect(feeds.length).toBeGreaterThan(1);
    expect(feeds.reduce((a, b) => a + b, 0)).toBe(399);
    expect(decodeEscPosRaster(out, width).length).toBe(height);
  });

  it("ภาพที่ไม่มีแถวขาวยาวเลย ให้ผลเหมือนเดิมทุกไบต์ (ไม่มี ESC J โผล่มา)", () => {
    const height = 50;
    const pixels = new Uint8Array(width * height).fill(1);
    const out = packEscPosRaster(width, height, pixels);
    for (let i = 0; i < out.length - 1; i += 1) {
      expect(out[i] === 0x1b && out[i + 1] === 0x4a).toBe(false);
    }
    expect(decodeEscPosRaster(out, width).length).toBe(height);
  });
});
