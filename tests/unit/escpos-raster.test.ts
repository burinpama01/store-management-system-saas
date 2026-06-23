import { describe, expect, it } from "vitest";
import {
  RASTER_WIDTH,
  packEscPosRaster,
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
    // pixel0 black opaque, pixel1 white opaque, pixel2 black but transparent
    const rgba = Uint8ClampedArray.from([
      0, 0, 0, 255,
      255, 255, 255, 255,
      0, 0, 0, 0,
    ]);
    const mono = rgbaToMono(rgba, 3, 1);
    expect([...mono]).toEqual([1, 0, 0]);
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
