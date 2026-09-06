// แก้ตัวเลือกของเมนูที่อยู่ในตะกร้าแล้วด้วยเสียง ("เปลี่ยนลาเต้เป็นหวานน้อย")
//
// ทำไมสำคัญ: เดิมแก้ตัวเลือกด้วยเสียงไม่ได้เลย ต้องเอามือแตะจอ ซึ่งขัดกับเหตุผล
// ของฟีเจอร์ทั้งหมด (มีไว้ให้คนที่มือไม่ว่าง) และลูกค้าเปลี่ยนใจเรื่องความหวาน/ร้อนเย็น
// เป็นเรื่องปกติที่สุดที่หน้าเคาน์เตอร์
import { describe, expect, it } from "vitest";
import { addToCart, emptyCart } from "@/modules/pos/cart";
import type { Cart } from "@/modules/pos/types";
import type { ModifierGroup, Product, ProductVariant } from "@/modules/catalog/types";
import { parseVoiceCommand } from "@/modules/voice-pos/parser";
import { applyVoiceCartIntent } from "@/modules/voice-pos/cart";

function option(id: string, groupId: string, name: string, priceAdjustment = 0, isDefault = false) {
  return { id, modifierGroupId: groupId, name, priceAdjustment, isDefault, isActive: true, sortOrder: 0 };
}

const SWEETNESS: ModifierGroup = {
  id: "g-sweet",
  productId: "p1",
  name: "ความหวาน",
  selectionType: "single",
  isRequired: true,
  minSelections: 1,
  maxSelections: 1,
  sortOrder: 0,
  options: [option("o-normal", "g-sweet", "หวานปกติ", 0, true), option("o-less", "g-sweet", "หวานน้อย")],
};

const TOPPINGS: ModifierGroup = {
  id: "g-top",
  productId: "p1",
  name: "ท็อปปิ้ง",
  selectionType: "multiple",
  isRequired: false,
  minSelections: 0,
  maxSelections: 3,
  sortOrder: 1,
  options: [option("o-oat", "g-top", "นมโอ๊ต", 15), option("o-shot", "g-top", "ช็อตพิเศษ", 20)],
};

const HOT: ProductVariant = {
  id: "v-hot",
  productId: "p2",
  name: "ร้อน",
  priceAdjustment: 0,
  isActive: true,
  sortOrder: 0,
  sku: undefined,
  trackStock: false,
  stockQuantity: undefined,
};
const ICED: ProductVariant = { ...HOT, id: "v-iced", name: "เย็น", priceAdjustment: 10, sortOrder: 1 };

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

const LATTE = product({ modifierGroups: [SWEETNESS, TOPPINGS] });
const AMERICANO = product({ id: "p2", name: "อเมริกาโน่", variants: [HOT, ICED] });
const CATALOG: readonly Product[] = [LATTE, AMERICANO];

/** ตะกร้าที่มีลาเต้ หวานปกติ + นมโอ๊ต 2 แก้ว */
function latteInCart(quantity = 2): Cart {
  return addToCart(emptyCart("store-1"), {
    product: LATTE,
    variant: null,
    modifiers: [
      { groupId: SWEETNESS.id, groupName: SWEETNESS.name, option: SWEETNESS.options[0] },
      { groupId: TOPPINGS.id, groupName: TOPPINGS.name, option: TOPPINGS.options[0] },
    ],
    quantity,
  });
}

function run(phrase: string, cart: Cart) {
  return applyVoiceCartIntent(parseVoiceCommand(phrase).intent, { cart, products: CATALOG });
}

describe("parser — “เปลี่ยน X เป็น Y”", () => {
  it.each(["เปลี่ยนลาเต้เป็นหวานน้อย", "แก้ลาเต้เป็นหวานน้อย", "แก้ไขลาเต้ให้เป็นหวานน้อย"])(
    "“%s” = แก้ตัวเลือก",
    (phrase) => {
      expect(parseVoiceCommand(phrase).intent).toEqual({
        type: "pos.change_option",
        productPhrase: "ลาเต้",
        optionPhrase: "หวานน้อย",
      });
    },
  );

  it("พูดตัวเลขหลัง “เป็น” = คนหมายถึงจำนวน ไม่ใช่ชื่อตัวเลือก", () => {
    expect(parseVoiceCommand("เปลี่ยนลาเต้เป็น 3").intent).toEqual({
      type: "pos.set_quantity",
      productPhrase: "ลาเต้",
      quantity: 3,
    });
  });

  it("รูปเดิม “เปลี่ยนจำนวน…เป็น…” ต้องไม่เปลี่ยนความหมาย", () => {
    expect(parseVoiceCommand("เปลี่ยนจำนวนลาเต้เป็น 5").intent).toEqual({
      type: "pos.set_quantity",
      productPhrase: "ลาเต้",
      quantity: 5,
    });
  });
});

describe("แก้ตัวเลือกของรายการในตะกร้า", () => {
  it("เปลี่ยนความหวานแล้วตัวเลือกกลุ่มอื่นต้องอยู่ครบ", () => {
    // จุดที่พลาดง่ายที่สุด: ถ้าตั้งต้นจากค่าเริ่มต้นของสินค้า นมโอ๊ตจะหายไปเงียบ ๆ
    const resolution = run("เปลี่ยนลาเต้เป็นหวานน้อย", latteInCart());

    expect(resolution.status).toBe("applied");
    if (resolution.status !== "applied") return;
    const line = resolution.cart.items[0];
    expect(resolution.cart.items).toHaveLength(1);
    expect(line.modifiers.map((m) => m.option.name).sort()).toEqual(["นมโอ๊ต", "หวานน้อย"]);
    expect(line.quantity).toBe(2);
    expect(resolution.announcement).toContain("หวานน้อย");
  });

  it("ราคาต่อหน่วยคิดตามตัวเลือกใหม่ ไม่ใช่ค้างราคาเดิม", () => {
    const resolution = run("เปลี่ยนลาเต้เป็นช็อตพิเศษ", latteInCart(1));

    expect(resolution.status).toBe("applied");
    if (resolution.status !== "applied") return;
    // ฐาน 100 + นมโอ๊ต 15 + ช็อตพิเศษ 20 (กลุ่มเลือกได้หลายอย่าง = เพิ่ม ไม่ใช่แทนที่)
    expect(resolution.cart.items[0].unitPrice).toBe(135);
    expect(resolution.cart.items[0].modifiers).toHaveLength(3);
  });

  it("เปลี่ยนตัวเลือกสินค้า (ร้อน→เย็น) ได้ และจำนวนต้องคงเดิม", () => {
    const cart = addToCart(emptyCart("store-1"), {
      product: AMERICANO,
      variant: HOT,
      modifiers: [],
      quantity: 3,
    });

    const resolution = run("เปลี่ยนอเมริกาโน่เป็นเย็น", cart);

    expect(resolution.status).toBe("applied");
    if (resolution.status !== "applied") return;
    expect(resolution.cart.items[0].variant?.name).toBe("เย็น");
    expect(resolution.cart.items[0].quantity).toBe(3);
  });

  it("ยังไม่มีในตะกร้า = ไม่แตะอะไรเลย", () => {
    const resolution = run("เปลี่ยนอเมริกาโน่เป็นเย็น", latteInCart());

    expect(resolution).toMatchObject({ status: "blocked", reason: "item_not_in_cart" });
  });

  it("ตัวเลือกที่พูดไม่มีอยู่จริง = ไม่เดา", () => {
    const resolution = run("เปลี่ยนลาเต้เป็นเผ็ดน้อย", latteInCart());

    expect(resolution).toMatchObject({ status: "blocked", reason: "option_not_found" });
  });

  it("เป็นแบบนั้นอยู่แล้ว = บอกตรง ๆ ไม่แตะตะกร้า", () => {
    const resolution = run("เปลี่ยนลาเต้เป็นหวานปกติ", latteInCart());

    expect(resolution).toMatchObject({ status: "blocked", reason: "option_not_applicable" });
  });

  it("ตะกร้าถูกล็อกแล้ว (สร้างออร์เดอร์) ห้ามแก้ด้วยเสียง", () => {
    const resolution = applyVoiceCartIntent(parseVoiceCommand("เปลี่ยนลาเต้เป็นหวานน้อย").intent, {
      cart: latteInCart(),
      products: CATALOG,
      locked: true,
    });

    expect(resolution).toMatchObject({ status: "blocked", reason: "cart_locked" });
  });

  it("มีลาเต้หลายบรรทัด (คนละตัวเลือก) = ต้องให้แก้บนจอ ห้ามเดาว่าบรรทัดไหน", () => {
    const two = addToCart(latteInCart(), {
      product: LATTE,
      variant: null,
      modifiers: [{ groupId: SWEETNESS.id, groupName: SWEETNESS.name, option: SWEETNESS.options[1] }],
      quantity: 1,
    });

    const resolution = run("เปลี่ยนลาเต้เป็นนมโอ๊ต", two);

    expect(resolution).toMatchObject({ status: "blocked", reason: "needs_selection" });
  });
});
