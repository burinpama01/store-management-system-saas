import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CartValidationError, resolveVariant } from "@/modules/pos/server-cart";

const root = process.cwd();

describe("ตะกร้าที่ถือตัวเลือกสินค้าเก่า", () => {
  const product = {
    id: "p1",
    name: "โปร เบียร์สิงห์ 3 ขวด",
    variants: [{ id: "v-new", name: "3 ขวด", isActive: true, priceAdjustment: 0 }],
  };

  it("บอกชื่อสินค้าและให้ลบแล้วเพิ่มใหม่เมื่อตัวเลือกถูกลบไปแล้ว", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => resolveVariant(product as any, "v-deleted")).toThrow(CartValidationError);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => resolveVariant(product as any, "v-deleted")).toThrow(/โปร เบียร์สิงห์ 3 ขวด.*ลบรายการนี้/);
  });

  it("ตรวจตะกร้าก่อนออก QR Beam โดยข้ามรายการแลกรางวัล/แพ็กเหมือน checkout", () => {
    const source = readFileSync(join(root, "src/app/pos/actions.ts"), "utf8");
    const start = source.indexOf("export async function prepareBeamQrAction");
    const body = source.slice(start, source.indexOf("export async function getBeamPaymentStatusAction"));
    expect(body.indexOf("validateCartForPayment")).toBeGreaterThan(-1);
    expect(body.indexOf("validateCartForPayment")).toBeLessThan(body.indexOf("createBeamQrPayment"));
    const helper = source.slice(source.indexOf("async function validateCartForPayment"));
    expect(helper).toContain("!item.rewardVoucherCode && !isPassCartItem(item)");
  });

  it("ตัวเลือกที่สร้างจากหน้าสต็อกไม่รับราคาจาก client", () => {
    const source = readFileSync(join(root, "src/app/(dashboard)/stock/actions.ts"), "utf8");
    expect(source).toContain("const priceAdjustment = 0;");
    const dialog = readFileSync(join(root, "src/app/(dashboard)/stock/AddStockDialog.tsx"), "utf8");
    expect(dialog).not.toContain("stock-variant-price");
  });
});
