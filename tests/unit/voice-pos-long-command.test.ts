// U21 — คำสั่งยาว: พูดชื่อสินค้า + ตัวเลือกติดกันในประโยคเดียว
// และ "ตัวเลือกที่พูด" ต้องทับค่าเริ่มต้นของเมนูได้ (ราคาจึงต้องเปลี่ยนตามจริง)
import { describe, expect, it } from "vitest";
import { emptyCart } from "@/modules/pos/cart";
import type { ModifierGroup, Product } from "@/modules/catalog/types";
import { parseVoiceCommand } from "@/modules/voice-pos/parser";
import { applyVoiceCartIntent, resolveVoiceProductPhrase } from "@/modules/voice-pos/cart";

function group(overrides: Partial<ModifierGroup> & Pick<ModifierGroup, "id" | "name" | "options">): ModifierGroup {
  return {
    productId: "p-americano",
    selectionType: "single",
    isRequired: false,
    minSelections: 0,
    maxSelections: 1,
    sortOrder: 1,
    ...overrides,
  } as ModifierGroup;
}

/** อเมริกาโน่: ค่าเริ่มต้น "เย็น" (แพงกว่าร้อน 5 บาท) + ระดับคั่ว + ชนิดนม */
const AMERICANO: Product = {
  id: "p-americano",
  storeId: "store-1",
  organizationId: "org-1",
  categoryId: "cat-1",
  name: "อเมริกาโน่",
  description: undefined,
  basePrice: 50,
  imageUrl: undefined,
  isActive: true,
  availableForPos: true,
  availableForQr: true,
  sortOrder: 0,
  createdAt: "2026-06-17T00:00:00.000Z",
  updatedAt: "2026-06-17T00:00:00.000Z",
  variants: [],
  modifierGroups: [
    group({
      id: "g-serve",
      name: "ประเภท",
      isRequired: true,
      minSelections: 1,
      options: [
        { id: "o-hot", modifierGroupId: "g-serve", name: "ร้อน", priceAdjustment: 0, isDefault: false, isActive: true, sortOrder: 1 },
        { id: "o-cold", modifierGroupId: "g-serve", name: "เย็น", priceAdjustment: 5, isDefault: true, isActive: true, sortOrder: 2 },
      ],
    }),
    group({
      id: "g-roast",
      name: "ระดับคั่ว",
      options: [
        { id: "o-dark", modifierGroupId: "g-roast", name: "คั่วเข้ม", priceAdjustment: 0, isDefault: false, isActive: true, sortOrder: 1 },
        { id: "o-medium", modifierGroupId: "g-roast", name: "คั่วกลาง", priceAdjustment: 0, isDefault: false, isActive: true, sortOrder: 2 },
      ],
    }),
  ],
};

/** ลาเต้: ความหวาน (ค่าเริ่มต้น 100%) + ชนิดนม (นมโอ๊ตบวก 15) + ระดับคั่ว */
const LATTE: Product = {
  ...AMERICANO,
  id: "p-latte",
  name: "ลาเต้",
  basePrice: 60,
  modifierGroups: [
    group({
      id: "g-sweet",
      productId: "p-latte",
      name: "ความหวาน",
      isRequired: true,
      minSelections: 1,
      options: [
        { id: "o-s0", modifierGroupId: "g-sweet", name: "หวาน 0%", priceAdjustment: 0, isDefault: false, isActive: true, sortOrder: 1 },
        { id: "o-s100", modifierGroupId: "g-sweet", name: "100%", priceAdjustment: 0, isDefault: false, isActive: true, sortOrder: 2 },
      ],
    }),
    group({
      id: "g-milk",
      productId: "p-latte",
      name: "นม",
      options: [
        { id: "o-oat", modifierGroupId: "g-milk", name: "นมโอ๊ต", priceAdjustment: 15, isDefault: false, isActive: true, sortOrder: 1 },
        { id: "o-fresh", modifierGroupId: "g-milk", name: "นมสด", priceAdjustment: 0, isDefault: false, isActive: true, sortOrder: 2 },
      ],
    }),
    group({
      id: "g-roast2",
      productId: "p-latte",
      name: "ระดับคั่ว",
      options: [
        { id: "o-dark2", modifierGroupId: "g-roast2", name: "คั่วเข้ม", priceAdjustment: 0, isDefault: false, isActive: true, sortOrder: 1 },
        { id: "o-medium2", modifierGroupId: "g-roast2", name: "คั่วกลาง", priceAdjustment: 0, isDefault: false, isActive: true, sortOrder: 2 },
      ],
    }),
  ],
};

const ORANGE_AMERICANO: Product = { ...AMERICANO, id: "p-am-orange", name: "อเมริกาโน่น้ำส้ม", modifierGroups: [] };

const CATALOG: readonly Product[] = [AMERICANO, LATTE, ORANGE_AMERICANO];

function add(phrase: string, products: readonly Product[] = CATALOG) {
  return applyVoiceCartIntent(parseVoiceCommand(phrase).intent, {
    cart: emptyCart("store-1"),
    products,
  });
}

function optionNames(resolution: ReturnType<typeof add>): string[] {
  if (resolution.status !== "applied") return [];
  return resolution.cart.items[0].modifiers.map((m) => m.option.name).sort();
}

describe("resolveVoiceProductPhrase — แยกชื่อสินค้าออกจากตัวเลือก", () => {
  it("ชื่อสินค้าที่ยาวกว่าชนะ (อเมริกาโน่น้ำส้ม ไม่ใช่ อเมริกาโน่ + น้ำส้ม)", () => {
    const resolution = resolveVoiceProductPhrase("อเมริกาโน่น้ำส้ม", CATALOG);
    expect(resolution.status).toBe("matched");
    if (resolution.status === "matched") expect(resolution.selection.product.id).toBe("p-am-orange");
  });

  it("สะกดต่างที่วรรณยุกต์ยังจับคู่ได้ (อเมริกาโน / ลาเต)", () => {
    const a = resolveVoiceProductPhrase("อเมริกาโน", CATALOG);
    expect(a.status).toBe("matched");
    if (a.status === "matched") expect(a.selection.product.id).toBe("p-americano");
    const b = resolveVoiceProductPhrase("ลาเต", CATALOG);
    if (b.status === "matched") expect(b.selection.product.id).toBe("p-latte");
  });
});

describe("คำสั่งยาว — สินค้า + ตัวเลือกในประโยคเดียว", () => {
  it("อเมริกาโน่คั่วเข้ม → เพิ่มได้เลย พร้อมตัวเลือกที่พูด และคงค่าเริ่มต้นที่ไม่ได้พูด", () => {
    const resolution = add("เพิ่มอเมริกาโน่คั่วเข้ม");
    expect(resolution.status).toBe("applied");
    // "เย็น" เป็นค่าเริ่มต้นที่ยังอยู่ + "คั่วเข้ม" ที่พูดเพิ่ม
    expect(optionNames(resolution)).toEqual(["คั่วเข้ม", "เย็น"]);
  });

  it("อเมริกาโน่ร้อน → ทับค่าเริ่มต้น 'เย็น' และราคาลดลงตามจริง", () => {
    const cold = add("เพิ่มอเมริกาโน่");
    const hot = add("เพิ่มอเมริกาโน่ร้อน");
    expect(cold.status).toBe("applied");
    expect(hot.status).toBe("applied");
    if (cold.status !== "applied" || hot.status !== "applied") return;

    expect(cold.cart.items[0].modifiers.map((m) => m.option.name)).toEqual(["เย็น"]);
    expect(hot.cart.items[0].modifiers.map((m) => m.option.name)).toEqual(["ร้อน"]);
    // เย็น +5 บาท / ร้อน +0 → ราคาต้องต่างกันจริง
    expect(cold.cart.items[0].unitPrice).toBe(55);
    expect(hot.cart.items[0].unitPrice).toBe(50);
  });

  it("ลาเต้หวาน 0% นมโอ๊ต คั่วกลาง → รับครบ 3 ตัวเลือกและคิดราคาตามนม", () => {
    const resolution = add("เพิ่มลาเต้หวาน 0% นมโอ๊ต คั่วกลาง");
    expect(resolution.status).toBe("applied");
    if (resolution.status !== "applied") return;
    expect(optionNames(resolution)).toEqual(["คั่วกลาง", "นมโอ๊ต", "หวาน 0%"]);
    expect(resolution.cart.items[0].unitPrice).toBe(75); // 60 + นมโอ๊ต 15
  });

  it("พูดตัวเลือกพร้อมจำนวนก็ยังได้", () => {
    const resolution = add("เพิ่มอเมริกาโน่ร้อน 2 แก้ว");
    expect(resolution.status).toBe("applied");
    if (resolution.status !== "applied") return;
    expect(resolution.cart.items[0].quantity).toBe(2);
    expect(resolution.cart.items[0].modifiers.map((m) => m.option.name)).toEqual(["ร้อน"]);
  });

  it("ตัวเลือกที่ไม่รู้จัก → ไม่เดา ไม่แตะตะกร้า (ให้ไปเลือกบนจอ)", () => {
    const resolution = add("เพิ่มอเมริกาโน่ใส่ไข่มุก");
    expect(resolution).toMatchObject({ status: "blocked", reason: "needs_selection" });
    if (resolution.status === "blocked") expect(resolution.candidates?.[0]?.name).toBe("อเมริกาโน่");
  });

  it("ตัวเลือกบังคับที่ยังไม่ได้เลือกและไม่มีค่าเริ่มต้น → ให้เลือกบนจอ", () => {
    const noDefault: Product = {
      ...LATTE,
      id: "p-plain",
      name: "ชาไทย",
      modifierGroups: [
        group({
          id: "g-need",
          productId: "p-plain",
          name: "ขนาด",
          isRequired: true,
          minSelections: 1,
          options: [
            { id: "o-s", modifierGroupId: "g-need", name: "เล็ก", priceAdjustment: 0, isDefault: false, isActive: true, sortOrder: 1 },
            { id: "o-l", modifierGroupId: "g-need", name: "ใหญ่", priceAdjustment: 10, isDefault: false, isActive: true, sortOrder: 2 },
          ],
        }),
      ],
    };
    const resolution = add("เพิ่มชาไทย", [noDefault]);
    expect(resolution).toMatchObject({ status: "blocked", reason: "needs_selection" });
    if (resolution.status === "blocked") expect(resolution.announcement).toContain("ขนาด");
  });

  it("พูดตัวเลือกบังคับมาด้วย → เพิ่มได้เลยไม่ต้องเปิด dialog", () => {
    const resolution = add("เพิ่มลาเต้หวาน 0%");
    expect(resolution.status).toBe("applied");
    if (resolution.status === "applied") {
      expect(resolution.cart.items[0].modifiers.map((m) => m.option.name)).toContain("หวาน 0%");
    }
  });
});

// U22 — คำเรียกเมนูที่ร้านบันทึกไว้ (แก้เคสเมนูชื่ออังกฤษ)
describe("คำเรียกเมนูของร้าน (product alias)", () => {
  const ENGLISH_MENU: Product = {
    ...AMERICANO,
    id: "p-matcha-latte",
    name: "Matcha latte",
    basePrice: 70,
    modifierGroups: [],
  };

  function addWithAlias(phrase: string) {
    return applyVoiceCartIntent(parseVoiceCommand(phrase).intent, {
      cart: emptyCart("store-1"),
      products: [ENGLISH_MENU],
      productAliases: [{ aliasText: "มัจฉะลาเต้", productId: "p-matcha-latte" }],
    });
  }

  it("พูดไทยสั่งเมนูชื่ออังกฤษได้เมื่อมีคำเรียกที่ร้านบันทึกไว้", () => {
    const resolution = addWithAlias("เพิ่มมัจฉะลาเต้ 2 แก้ว");
    expect(resolution.status).toBe("applied");
    if (resolution.status === "applied") {
      expect(resolution.cart.items[0].productName).toBe("Matcha latte");
      expect(resolution.cart.items[0].quantity).toBe(2);
    }
  });

  it("ไม่มีคำเรียก = ยังหาไม่เจอเหมือนเดิม (ไม่เดา)", () => {
    const resolution = applyVoiceCartIntent(parseVoiceCommand("เพิ่มมัจฉะลาเต้").intent, {
      cart: emptyCart("store-1"),
      products: [ENGLISH_MENU],
    });
    expect(resolution).toMatchObject({ status: "blocked", reason: "product_not_found" });
  });

  it("คำเรียกใช้ร่วมกับตัวเลือกที่พูดต่อท้ายได้", () => {
    const withOptions: Product = { ...AMERICANO, id: "p-am2", name: "Americano" };
    const resolution = applyVoiceCartIntent(parseVoiceCommand("เพิ่มอเมริกาโน่ร้อน").intent, {
      cart: emptyCart("store-1"),
      products: [withOptions],
      productAliases: [{ aliasText: "อเมริกาโน่", productId: "p-am2" }],
    });
    expect(resolution.status).toBe("applied");
    if (resolution.status === "applied") {
      expect(resolution.cart.items[0].modifiers.map((m) => m.option.name)).toEqual(["ร้อน"]);
    }
  });

  it("คำเรียกชี้ไปสินค้าที่ไม่มีในเมนูแล้ว ต้องไม่พัง", () => {
    const resolution = applyVoiceCartIntent(parseVoiceCommand("เพิ่มมัจฉะลาเต้").intent, {
      cart: emptyCart("store-1"),
      products: [AMERICANO],
      productAliases: [{ aliasText: "มัจฉะลาเต้", productId: "ไม่มีแล้ว" }],
    });
    expect(resolution).toMatchObject({ status: "blocked", reason: "product_not_found" });
  });
});
