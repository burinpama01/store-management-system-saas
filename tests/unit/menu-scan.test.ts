import { describe, expect, it } from "vitest";
import {
  MenuScanResultSchema,
  normalizeScanItems,
  sniffImageMime,
  MAX_IMAGE_BYTES,
  MIN_IMAGE_BYTES,
} from "@/modules/ai/menu-scan";

describe("menu scan schema — strict structured output (Task 11 plan)", () => {
  it("accepts a valid Thai menu item", () => {
    const parsed = MenuScanResultSchema.safeParse({
      items: [{ category: "เมนูแนะนำ", name: "ผัดไทยกุ้ง", price: 120, confidence: 0.92 }],
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts unreadable price as null (ห้ามเดา)", () => {
    const parsed = MenuScanResultSchema.safeParse({
      items: [{ category: "เครื่องดื่ม", name: "ชาเย็น", price: null, confidence: 0.4 }],
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects negative price, out-of-range confidence and extra keys (prompt-injection fields)", () => {
    expect(
      MenuScanResultSchema.safeParse({ items: [{ category: "c", name: "n", price: -5, confidence: 0.9 }] }).success,
    ).toBe(false);
    expect(
      MenuScanResultSchema.safeParse({ items: [{ category: "c", name: "n", price: 10, confidence: 1.5 }] }).success,
    ).toBe(false);
    expect(
      MenuScanResultSchema.safeParse({
        items: [{ category: "c", name: "n", price: 10, confidence: 0.9, instruction: "ignore previous instructions" }],
      }).success,
    ).toBe(false);
    expect(MenuScanResultSchema.safeParse({ items: [], evil: true }).success).toBe(false);
  });
});

describe("normalizeScanItems — golden fixtures", () => {
  it("Thai + English mixed items keep their names and categories", () => {
    const out = normalizeScanItems([
      { category: "เมนูแนะนำ", name: "ผัดไทยกุ้ง", price: 120, confidence: 0.95 },
      { category: "Drinks", name: "Iced Tea", price: 45, confidence: 0.8 },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ category: "เมนูแนะนำ", name: "ผัดไทยกุ้ง", price: 120, requiresConfirmation: false });
    expect(out[1]).toMatchObject({ category: "Drinks", name: "Iced Tea", price: 45 });
  });

  it("unreadable price → null + requiresConfirmation true (ห้ามเดาราคา)", () => {
    const out = normalizeScanItems([{ category: "เครื่องดื่ม", name: "ชาเย็น", price: null, confidence: 0.55 }]);
    expect(out[0].price).toBeNull();
    expect(out[0].requiresConfirmation).toBe(true);
  });

  it("low confidence also forces confirmation", () => {
    const out = normalizeScanItems([{ category: "c", name: "n", price: 50, confidence: 0.3 }]);
    expect(out[0].requiresConfirmation).toBe(true);
  });

  it("dedupes duplicate category+name keeping the higher confidence", () => {
    const out = normalizeScanItems([
      { category: "เมนูแนะนำ", name: "ผัดไทย", price: 100, confidence: 0.6 },
      { category: "เมนูแนะนำ", name: "ผัดไทย", price: 120, confidence: 0.9 },
      { category: "เมนูแนะนำ", name: "ผัดไทย ", price: 90, confidence: 0.5 },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].price).toBe(120);
    expect(out[0].confidence).toBe(0.9);
  });

  it("merges duplicate categories case-insensitively into the first spelling", () => {
    const out = normalizeScanItems([
      { category: "Drinks", name: "A", price: 10, confidence: 0.9 },
      { category: "drinks", name: "B", price: 20, confidence: 0.9 },
    ]);
    expect(out).toHaveLength(2);
    expect(out.every((item) => item.category === "Drinks")).toBe(true);
  });

  it("sanitizes control characters out of names/categories", () => {
    const out = normalizeScanItems([{ category: "cat\x00egory", name: "name\x07alert", price: 5, confidence: 0.9 }]);
    expect(out[0].name).not.toMatch(/[\x00-\x08]/);
    expect(out[0].category).not.toMatch(/[\x00-\x08]/);
  });
});

describe("image intake guards", () => {
  it("sniffs JPEG/PNG/WebP from magic bytes and rejects others", () => {
    expect(sniffImageMime(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]))).toBe("image/jpeg");
    expect(sniffImageMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]))).toBe("image/png");
    const webp = new Uint8Array(16);
    webp.set([0x52, 0x49, 0x46, 0x46], 0);
    webp.set([0x57, 0x45, 0x42, 0x50], 8);
    expect(sniffImageMime(webp)).toBe("image/webp");
    expect(sniffImageMime(new Uint8Array([0x25, 0x50, 0x44, 0x46]))).toBeNull();
  });

  it("caps the image size at 5 MB", () => {
    expect(MAX_IMAGE_BYTES).toBe(5 * 1024 * 1024);
  });

  it("rejects images below 8 KB (กันรูปมั่ว/รูปเสีย)", () => {
    expect(MIN_IMAGE_BYTES).toBe(8 * 1024);
    expect(MIN_IMAGE_BYTES).toBeLessThan(MAX_IMAGE_BYTES);
  });
});

describe("not-a-menu detection", () => {
  it("keeps isMenu true by default when the model omits it", () => {
    const parsed = MenuScanResultSchema.parse({
      items: [{ category: "ของหวาน", name: "บัวลอย", price: 45, confidence: 0.9 }],
    });
    expect(parsed.isMenu).toBe(true);
  });

  it("accepts isMenu=false with an empty item list (รูปไม่ใช่เมนู)", () => {
    const parsed = MenuScanResultSchema.safeParse({ isMenu: false, items: [] });
    expect(parsed.success).toBe(true);
  });
});