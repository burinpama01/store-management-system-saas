import { describe, expect, it } from "vitest";
import type { Product } from "@/modules/catalog/types";
import {
  resolveAiVoiceCommand,
  resolveOptionPhrase,
} from "@/modules/voice-pos/intent-resolver";
import type { AiVoiceCommand } from "@/modules/voice-pos/ai-intent-schema";

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
const LATTE_ORANGE = product({ id: "p3", name: "ลาเต้ส้ม" });
const CATALOG = [LATTE, AMERICANO, LATTE_ORANGE];

const cmd = (over: Partial<AiVoiceCommand> = {}): AiVoiceCommand => ({
  intent: "pos.add_item",
  productPhrase: "ลาเต้",
  quantity: 2,
  optionPhrases: [],
  ...over,
});

describe("resolveOptionPhrase — ห้ามเดาความหมายของตัวเลือก", () => {
  const options = ["0%", "25%", "50%", "100%"];

  it('"หวานน้อย" ไม่ใช่ 25% จนกว่าร้านจะบอกว่าใช่', () => {
    expect(resolveOptionPhrase("หวานน้อย", { options, aliases: [] })).toEqual({ status: "needs_selection" });
    expect(
      resolveOptionPhrase("หวานน้อย", { options, aliases: [{ aliasText: "หวานน้อย", optionId: "25%" }] }),
    ).toEqual({ status: "matched", optionId: "25%" });
  });

  it("ชื่อตรงตัวจับคู่ได้ทันที", () => {
    expect(resolveOptionPhrase("50%", { options, aliases: [] })).toEqual({ status: "matched", optionId: "50%" });
  });

  it("alias ที่ชี้ไปตัวเลือกที่ไม่มีอยู่แล้ว ถือว่าใช้ไม่ได้", () => {
    expect(
      resolveOptionPhrase("หวานน้อย", { options, aliases: [{ aliasText: "หวานน้อย", optionId: "ลบไปแล้ว" }] }),
    ).toEqual({ status: "needs_selection" });
  });

  it("รับ option แบบ {id,name} ได้ และคืน id ไม่ใช่ชื่อ", () => {
    expect(
      resolveOptionPhrase("ร้อน", { options: [{ id: "opt-hot", name: "ร้อน" }], aliases: [] }),
    ).toEqual({ status: "matched", optionId: "opt-hot" });
  });

  it("วลีว่างไม่จับคู่", () => {
    expect(resolveOptionPhrase("   ", { options, aliases: [] })).toEqual({ status: "needs_selection" });
  });
});

describe("resolveAiVoiceCommand — จับคู่กับสินค้าจริงเท่านั้น", () => {
  it("แปลงเป็น intent เดิมของระบบเมื่อชัดเจน", () => {
    const resolved = resolveAiVoiceCommand(cmd(), { products: CATALOG });
    expect(resolved).toMatchObject({
      status: "apply",
      productName: "ลาเต้",
      intent: { type: "pos.add_item", quantity: 2 },
    });
  });

  it("ชื่อที่ยาวกว่าชนะ (ลาเต้ส้ม ไม่ใช่ ลาเต้)", () => {
    const resolved = resolveAiVoiceCommand(cmd({ productPhrase: "ลาเต้ส้ม" }), { products: CATALOG });
    expect(resolved).toMatchObject({ status: "apply", productName: "ลาเต้ส้ม" });
  });

  it("ไม่พบสินค้า = ไม่เดา", () => {
    const resolved = resolveAiVoiceCommand(cmd({ productPhrase: "ชาเขียวมัจฉะพิเศษ" }), { products: CATALOG });
    expect(resolved).toMatchObject({ status: "not_found" });
  });

  it("จำนวนที่ไม่ได้พูดของ add/set = ต้องถาม", () => {
    expect(resolveAiVoiceCommand(cmd({ quantity: null }), { products: CATALOG })).toMatchObject({
      status: "needs_quantity",
      productName: "ลาเต้",
    });
  });

  it("เพิ่ม/ลดที่ไม่ได้พูดจำนวน = ทีละ 1", () => {
    expect(
      resolveAiVoiceCommand(cmd({ intent: "pos.increase_item", quantity: null }), { products: CATALOG }),
    ).toMatchObject({ status: "apply", intent: { type: "pos.increase_item", delta: 1 } });
  });

  it("สินค้าของหมด = บอกตามจริง ไม่ใส่ตะกร้า", () => {
    const resolved = resolveAiVoiceCommand(cmd(), { products: [product({ outOfStock: true })] });
    expect(resolved).toEqual({ status: "unavailable", productName: "ลาเต้" });
  });

  it("สินค้าปิดขาย/ปิดใช้งานถือว่าไม่มีในเมนู", () => {
    expect(resolveAiVoiceCommand(cmd(), { products: [product({ isActive: false })] })).toMatchObject({
      status: "not_found",
    });
    expect(resolveAiVoiceCommand(cmd(), { products: [product({ availableForPos: false })] })).toMatchObject({
      status: "not_found",
    });
  });

  it("สินค้าที่ต้องเลือกตัวเลือก = เปิด dialog ไม่ใช่เดาให้", () => {
    const withRequiredGroup = product({
      modifierGroups: [
        {
          id: "g1",
          productId: "p1",
          name: "ความหวาน",
          selectionType: "single",
          isRequired: true,
          minSelections: 1,
          maxSelections: 1,
          sortOrder: 0,
          options: [
            { id: "o1", modifierGroupId: "g1", name: "0%", priceAdjustment: 0, isDefault: false, isActive: true, sortOrder: 0 },
            { id: "o2", modifierGroupId: "g1", name: "25%", priceAdjustment: 0, isDefault: false, isActive: true, sortOrder: 1 },
          ],
        },
      ],
    });
    const resolved = resolveAiVoiceCommand(cmd(), { products: [withRequiredGroup] });
    expect(resolved).toMatchObject({ status: "needs_option", productId: "p1" });
  });

  it("คำที่ไม่ตรงตัวเลือกใดเลย = ให้เลือกบนจอ ไม่ใช่ทิ้งคำนั้นเงียบ ๆ", () => {
    const resolved = resolveAiVoiceCommand(cmd({ optionPhrases: ["สูตรพิเศษของพี่"] }), { products: CATALOG });
    expect(resolved).toMatchObject({ status: "needs_option", productName: "ลาเต้" });
  });

  it("alias ของร้านชี้ไปสินค้าที่ถูกต้อง", () => {
    const resolved = resolveAiVoiceCommand(cmd({ productPhrase: "มัจฉะลาเต้" }), {
      products: CATALOG,
      productAliases: [{ aliasText: "มัจฉะลาเต้", productId: "p2" }],
    });
    expect(resolved).toMatchObject({ status: "apply", productName: "อเมริกาโน่" });
  });

  it("navigate ไม่ผ่านเส้นทาง AI (ยังเป็นของ deterministic parser)", () => {
    expect(
      resolveAiVoiceCommand(cmd({ intent: "navigate", productPhrase: null, quantity: null }), { products: CATALOG }),
    ).toEqual({ status: "unsupported" });
  });

  it("clear_search ผ่านได้โดยไม่ต้องมีสินค้า", () => {
    expect(
      resolveAiVoiceCommand(cmd({ intent: "pos.clear_search", productPhrase: null, quantity: null }), {
        products: CATALOG,
      }),
    ).toMatchObject({ status: "apply", intent: { type: "pos.clear_search" } });
  });
});
