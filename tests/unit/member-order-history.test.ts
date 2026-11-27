import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { PricedLine } from "@/modules/online-orders/core";
import type { OnlineMenuProduct } from "@/modules/online-orders/menu";
import { buildReorderCart } from "@/modules/online-orders/reorder";

const read = (p: string) => readFileSync(p, "utf8");

const menu: OnlineMenuProduct[] = [
  {
    id: "p-capu",
    name: "คาปูชิโน่",
    description: null,
    price: 40,
    imageUrl: null,
    categoryName: "กาแฟ",
    variants: [],
    groups: [
      { id: "g-temp", name: "ร้อน/เย็น", selectionType: "single", minSelections: 1, maxSelections: 1, options: [{ id: "o-hot", name: "ร้อน", priceAdjustment: 0 }, { id: "o-cold", name: "เย็น", priceAdjustment: 5 }] },
      { id: "g-milk", name: "นม", selectionType: "multiple", minSelections: 0, maxSelections: 2, options: [{ id: "o-oat", name: "นมโอ๊ต", priceAdjustment: 10 }] },
    ],
  },
  { id: "p-tea", name: "ชาไทย", description: null, price: 35, imageUrl: null, categoryName: "ชา", variants: [{ id: "v-l", name: "ใหญ่", priceAdjustment: 10 }], groups: [] },
];

function line(over: Partial<PricedLine>): PricedLine {
  return {
    productId: "p-capu",
    productName: "คาปูชิโน่",
    variantId: null,
    variantName: null,
    modifiers: [],
    quantity: 1,
    unitPrice: 0,
    totalPrice: 0,
    note: null,
    kitchenStationId: null,
    kitchenStationName: null,
    ...over,
  };
}
const mod = (id: string) => ({ modifierGroupId: "g", modifierGroupName: "g", option: { id, name: id, priceAdjustment: 999 } });

describe("สั่งอีกครั้ง — buildReorderCart", () => {
  it("ใช้ราคาปัจจุบันจากเมนู ไม่ใช้ราคาใน snapshot", () => {
    const { cart, skipped } = buildReorderCart([line({ modifiers: [mod("o-cold"), mod("o-oat")], quantity: 2, unitPrice: 1 })], menu);
    expect(skipped).toBe(0);
    expect(cart).toHaveLength(1);
    expect(cart[0].unitPrice).toBe(55);
    expect(cart[0].quantity).toBe(2);
    expect(cart[0].modifierOptionIds).toEqual(["o-cold", "o-oat"]);
    expect(cart[0].detail).toBe("เย็น · นมโอ๊ต");
  });

  it("เมนูที่ไม่มีขายแล้วถูกข้ามและนับจำนวน", () => {
    const { cart, skipped } = buildReorderCart([line({ productId: "gone" }), line({ modifiers: [mod("o-hot")] })], menu);
    expect(cart).toHaveLength(1);
    expect(skipped).toBe(1);
  });

  it("กลุ่มบังคับเลือกไม่ครบ (ตัวเลือกเดิมถูกลบ) → ข้ามทั้งรายการ", () => {
    const { cart, skipped } = buildReorderCart([line({ modifiers: [mod("o-deleted")] })], menu);
    expect(cart).toHaveLength(0);
    expect(skipped).toBe(1);
  });

  it("ขนาด: ขนาดเดิมหายหรือเดิมไม่มีขนาดแต่ตอนนี้ต้องเลือก → ข้าม · ขนาดยังอยู่ → ใช้ได้", () => {
    expect(buildReorderCart([line({ productId: "p-tea", variantId: "v-x" })], menu).skipped).toBe(1);
    expect(buildReorderCart([line({ productId: "p-tea", variantId: null })], menu).skipped).toBe(1);
    const ok = buildReorderCart([line({ productId: "p-tea", variantId: "v-l" })], menu);
    expect(ok.cart[0].unitPrice).toBe(45);
  });

  it("รายการเหมือนกันรวมจำนวน (เพดาน 50)", () => {
    const { cart } = buildReorderCart([line({ modifiers: [mod("o-hot")], quantity: 30 }), line({ modifiers: [mod("o-hot")], quantity: 30 })], menu);
    expect(cart).toHaveLength(1);
    expect(cart[0].quantity).toBe(50);
  });
});

describe("ประวัติสั่งซื้อสมาชิก", () => {
  it("ดึงเฉพาะร้านนี้ + เบอร์สมาชิก (normalize) — สั่งอีกครั้งตรวจเจ้าของออเดอร์ฝั่ง server", () => {
    const src = read("src/modules/online-orders/member-history.ts");
    expect(src).toContain('.eq("store_id", storeId)');
    expect(src).toContain('.eq("customer_phone", phone)');
    expect(src).toContain("const phone = normalizeThaiPhone(memberPhone);");
    const page = read("src/app/member/[storeSlug]/order/page.tsx");
    expect(page).toContain("getMemberOrderLines(site.storeId, member.phone, reorderId)");
  });

  it("หน้าประวัติอยู่ใต้ /member/<slug>/orders ต้องล็อกอินสมาชิก + มีปุ่มสั่งอีกครั้ง", () => {
    const page = read("src/app/member/[storeSlug]/orders/page.tsx");
    expect(page).toContain("const member = await getMemberSessionByStoreId(site.storeId);");
    expect(page).toContain("if (!member) redirect(memberHref);");
    expect(page).toContain("/order?reorder=");
    expect(read("src/app/member/[storeSlug]/MemberPortal.tsx")).toContain('{ key: "history", icon: "🧾", label: "ประวัติสั่ง"');
  });

  it("หน้าติดตาม: คำขอค้าง (iOS ล็อกจอ) ไม่ล็อกการรีเฟรชถาวร + กลับมาที่หน้าแล้วถามสถานะทันที", () => {
    const src = read("src/app/s/[slug]/order/t/[token]/TrackingClient.tsx");
    expect(src).toContain("if (busySince.current && Date.now() - busySince.current < 20_000) return;");
    expect(src).toContain('document.addEventListener("visibilitychange", onVisible);');
    expect(src).toContain('window.addEventListener("pageshow", onVisible);');
  });
});
