// U15 — Voice Tier B cart: แตะได้เฉพาะตะกร้าในเครื่อง และต้อง "ไม่แตะ" ทุกครั้งที่ไม่ชัวร์
import { describe, expect, it } from "vitest";
import { addToCart, emptyCart } from "@/modules/pos/cart";
import type { Cart } from "@/modules/pos/types";
import type { Product } from "@/modules/catalog/types";
import { parseVoiceCommand } from "@/modules/voice-pos/parser";
import { applyVoiceCartIntent, isVoiceCartIntent, matchVoiceProduct } from "@/modules/voice-pos/cart";

function product(overrides: Partial<Product> = {}): Product {
  return {
    id: "p1",
    storeId: "store-1",
    organizationId: "org-1",
    categoryId: "cat-1",
    name: "ลาเต้",
    description: undefined,
    basePrice: 100,
    imageUrl: undefined,
    isActive: true,
    availableForPos: true,
    availableForQr: true,
    sortOrder: 0,
    createdAt: "2026-06-17T00:00:00.000Z",
    updatedAt: "2026-06-17T00:00:00.000Z",
    variants: [],
    modifierGroups: [],
    ...overrides,
  };
}

const LATTE = product();
const AMERICANO = product({ id: "p2", name: "อเมริกาโน่" });
const CATALOG: readonly Product[] = [LATTE, AMERICANO];

function cartWith(p: Product, quantity: number): Cart {
  return addToCart(emptyCart("store-1"), { product: p, variant: null, modifiers: [], quantity });
}

function run(phrase: string, context: { cart: Cart; products?: readonly Product[]; locked?: boolean }) {
  const result = parseVoiceCommand(phrase);
  return applyVoiceCartIntent(result.intent, {
    cart: context.cart,
    products: context.products ?? CATALOG,
    locked: context.locked,
  });
}

describe("matchVoiceProduct", () => {
  it("ตรงทั้งชื่อ = ได้สินค้าเดียว", () => {
    expect(matchVoiceProduct("ลาเต้", CATALOG)).toEqual({ product: LATTE });
  });

  it("ชื่อคล้ายกันหลายตัว = คลุมเครือ ไม่เดา", () => {
    const catalog = [product({ id: "a", name: "ชาเย็น" }), product({ id: "b", name: "ชาเย็นพิเศษ" })];
    const match = matchVoiceProduct("ชาเย็น", catalog);
    expect(match).toEqual({ product: catalog[0] }); // ตรงทั้งชื่อชนะชั้นแรก
    expect(matchVoiceProduct("ชา", catalog)).toMatchObject({ candidates: catalog });
  });

  it("สินค้าปิดขาย/ไม่ขายหน้าร้าน ไม่ถูกนำมาจับคู่", () => {
    const catalog = [product({ id: "x", name: "ลาเต้", availableForPos: false })];
    expect(matchVoiceProduct("ลาเต้", catalog)).toBeNull();
  });
});

describe("applyVoiceCartIntent — เพิ่มสินค้า", () => {
  it("เพิ่มสินค้าที่ตรงรายการเดียว → ตะกร้าใบใหม่ (ใบเดิมไม่ถูกแก้)", () => {
    const before = emptyCart("store-1");
    const resolution = run("เพิ่มลาเต้ 2 แก้ว", { cart: before });

    expect(resolution.status).toBe("applied");
    if (resolution.status !== "applied") return;
    expect(resolution.cart.items).toHaveLength(1);
    expect(resolution.cart.items[0].quantity).toBe(2);
    expect(resolution.cart.total).toBe(200);
    expect(before.items).toHaveLength(0);
  });

  it("ไม่พบสินค้า → ไม่แตะตะกร้า", () => {
    const before = emptyCart("store-1");
    const resolution = run("เพิ่มยานอวกาศ", { cart: before });
    expect(resolution).toMatchObject({ status: "blocked", reason: "product_not_found" });
  });

  it("ชื่อคลุมเครือ → ไม่แตะตะกร้า และเสนอรายการให้เลือก", () => {
    const catalog = [product({ id: "a", name: "ชาเย็นสูตร 1" }), product({ id: "b", name: "ชาเย็นสูตร 2" })];
    const resolution = run("เพิ่มชาเย็น", { cart: emptyCart("store-1"), products: catalog });
    expect(resolution).toMatchObject({ status: "blocked", reason: "ambiguous_product" });
    if (resolution.status === "blocked") expect(resolution.candidates).toHaveLength(2);
  });

  it("สินค้าที่มี variant หรือ modifier บังคับ → ต้องเลือกบนจอ", () => {
    const withVariant = product({
      id: "v1",
      name: "ชาไทย",
      variants: [
        {
          id: "v1-s",
          productId: "v1",
          name: "เล็ก",
          priceAdjustment: 0,
          trackStock: false,
          isActive: true,
          sortOrder: 0,
        },
      ],
    });
    const resolution = run("เพิ่มชาไทย", { cart: emptyCart("store-1"), products: [withVariant] });
    expect(resolution).toMatchObject({ status: "blocked", reason: "needs_selection" });
  });

  it("ของหมด → ไม่แตะตะกร้า", () => {
    const soldOut = product({ id: "s1", name: "โกโก้", outOfStock: true });
    const resolution = run("เพิ่มโกโก้", { cart: emptyCart("store-1"), products: [soldOut] });
    expect(resolution).toMatchObject({ status: "blocked", reason: "product_unavailable" });
  });

  it("ตะกร้าถูกล็อก (สร้างออร์เดอร์แล้ว) → ห้ามแก้ด้วยเสียง", () => {
    const resolution = run("เพิ่มลาเต้", { cart: emptyCart("store-1"), locked: true });
    expect(resolution).toMatchObject({ status: "blocked", reason: "cart_locked" });
  });
});

describe("applyVoiceCartIntent — แก้ของที่มีอยู่แล้ว", () => {
  it("ตั้งจำนวน", () => {
    const resolution = run("ตั้งจำนวนลาเต้เป็น 5", { cart: cartWith(LATTE, 2) });
    expect(resolution.status).toBe("applied");
    if (resolution.status === "applied") expect(resolution.cart.items[0].quantity).toBe(5);
  });

  it("เพิ่มอีก / ลด", () => {
    const increased = run("เพิ่มอีก 2 ลาเต้", { cart: cartWith(LATTE, 1) });
    expect(increased.status).toBe("applied");
    if (increased.status === "applied") expect(increased.cart.items[0].quantity).toBe(3);

    const decreased = run("ลดลาเต้ 1", { cart: cartWith(LATTE, 3) });
    expect(decreased.status).toBe("applied");
    if (decreased.status === "applied") expect(decreased.cart.items[0].quantity).toBe(2);
  });

  it("ลดจนเหลือศูนย์ = เอาออกจากตะกร้า (ยังย้อนกลับได้ด้วย Undo)", () => {
    const resolution = run("ลดลาเต้ 3", { cart: cartWith(LATTE, 2) });
    expect(resolution.status).toBe("applied");
    if (resolution.status === "applied") expect(resolution.cart.items).toHaveLength(0);
  });

  it("ลบรายการ", () => {
    const resolution = run("ลบลาเต้", { cart: cartWith(LATTE, 2) });
    expect(resolution.status).toBe("applied");
    if (resolution.status === "applied") expect(resolution.cart.items).toHaveLength(0);
  });

  it("เอา ... ออก", () => {
    const resolution = run("เอาลาเต้ออก", { cart: cartWith(LATTE, 1) });
    expect(resolution.status).toBe("applied");
    if (resolution.status === "applied") expect(resolution.cart.items).toHaveLength(0);
  });

  it("ยังไม่มีในตะกร้า → ไม่แตะตะกร้า", () => {
    const resolution = run("ลบอเมริกาโน่", { cart: cartWith(LATTE, 1) });
    expect(resolution).toMatchObject({ status: "blocked", reason: "item_not_in_cart" });
  });

  it("จำนวนเกินช่วง → ไม่แตะตะกร้า", () => {
    const resolution = run("เพิ่มอีก 99 ลาเต้", { cart: cartWith(LATTE, 5) });
    expect(resolution).toMatchObject({ status: "blocked", reason: "invalid_quantity" });
  });
});

describe("ขอบเขตความปลอดภัยของ Tier B", () => {
  it("คำสั่งที่ไม่ใช่ตะกร้าไม่ถูกจัดการที่นี่", () => {
    expect(isVoiceCartIntent(parseVoiceCommand("เปิดครัว").intent)).toBe(false);
    expect(isVoiceCartIntent(parseVoiceCommand("ชำระเงิน").intent)).toBe(false);
    expect(isVoiceCartIntent(parseVoiceCommand("ล้างตะกร้า").intent)).toBe(false);
  });

  it("คำสั่งการเงิน/ล้างตะกร้ายังถูก block ที่ parser (ไม่มีทางถึงตะกร้า)", () => {
    for (const phrase of ["ชำระเงิน", "เช็คบิล", "ล้างตะกร้า", "ให้ส่วนลด 50 บาท", "คืนเงิน"]) {
      const result = parseVoiceCommand(phrase);
      expect(result.decision, phrase).toBe("block");
      expect(result.intent.type, phrase).toBe("unknown");
    }
  });

  it("คำสั่งตะกร้าทุกแบบเป็น Tier B และ execute ได้เมื่อฟังชัด", () => {
    for (const phrase of ["เพิ่มลาเต้", "ลบลาเต้", "ลดลาเต้ 1", "เพิ่มอีก 1 ลาเต้", "ตั้งจำนวนลาเต้เป็น 2"]) {
      const result = parseVoiceCommand(phrase);
      expect(result.tier, phrase).toBe("B");
      expect(result.decision, phrase).toBe("execute");
    }
  });
});
