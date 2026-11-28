import { describe, expect, it } from "vitest";
import { adPosterFileName, dataUrlToBlob, wrapLines } from "@/app/(dashboard)/settings/ad-self-serve/ad-poster";

// วัดความกว้าง = จำนวนตัวอักษร × 10
const measure = (s: string) => Array.from(s).length * 10;

describe("ad-poster", () => {
  it("ชื่อสั้นอยู่บรรทัดเดียว", () => {
    expect(wrapLines("ร้านกาแฟ", 200, measure, 2)).toEqual(["ร้านกาแฟ"]);
  });
  it("ภาษาไทยไม่มีเว้นวรรคตัดทีละตัวอักษร และไม่เกิน 2 บรรทัดพร้อม …", () => {
    const lines = wrapLines("ก".repeat(50), 100, measure, 2);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("ก".repeat(10));
    expect(lines[1].endsWith("…")).toBe(true);
    expect(measure(lines[1])).toBeLessThanOrEqual(100);
  });
  it("ตัดตามเว้นวรรคก่อน", () => {
    expect(wrapLines("Coffee House Bangkok", 130, measure, 3)).toEqual(["Coffee House", "Bangkok"]);
  });
  it("ข้อความว่าง = ไม่มีบรรทัด", () => {
    expect(wrapLines("   ", 100, measure, 2)).toEqual([]);
  });
  it("ชื่อไฟล์ตัดอักขระต้องห้าม", () => {
    expect(adPosterFileName('ร้าน/ก:ข*"', "poster")).toBe("ad-poster-ร้าน_ก_ข__.png");
    expect(adPosterFileName("", "qr")).toBe("qr-ads-store.png");
  });
  it("data URL → Blob และปฏิเสธค่าที่ไม่ใช่ data URL", () => {
    const blob = dataUrlToBlob("data:image/png;base64,iVBORw0KGgo=");
    expect(blob.type).toBe("image/png");
    expect(blob.size).toBe(8);
    expect(() => dataUrlToBlob("not-a-data-url")).toThrow();
    expect(() => dataUrlToBlob("data:image/png;base64,")).toThrow();
  });
});
