// U15 — Voice Tier B cart (R2) · ตัวแปลง intent → ตะกร้าใบใหม่ (pure ล้วน)
// ห้าม import React/router/server action — ใช้สัญญาเดิมของ src/modules/pos/cart.ts เท่านั้น
//
// กฎที่ล็อกไว้:
//   - แตะได้เฉพาะตะกร้าในเครื่อง (local) และย้อนกลับได้ทุกครั้ง (Undo 6 วินาที ทำที่ชั้น UI)
//   - ต้องตรงสินค้า "รายการเดียว" เท่านั้น — คลุมเครือ/ไม่พบ/ต้องเลือกตัวเลือก = ไม่แตะตะกร้า
//   - สินค้าที่ต้องเลือก variant หรือ modifier บังคับ ต้องให้ผู้ใช้เลือกบนจอ (Tier C)
//   - transcript ไม่เข้ามาถึงไฟล์นี้ — รับเฉพาะ intent ที่ parse แล้ว

import { addToCart, removeFromCart, updateQuantity } from "@/modules/pos/cart";
import type { Cart } from "@/modules/pos/types";
import type { PriceTier } from "@/modules/pos/pricing";
import type { Product } from "@/modules/catalog/types";
import { VOICE_MAX_QUANTITY, VOICE_MIN_QUANTITY } from "./parser";
import type {
  VoiceAddItemIntent,
  VoiceDecreaseItemIntent,
  VoiceIncreaseItemIntent,
  VoiceIntent,
  VoiceRemoveItemIntent,
  VoiceSetQuantityIntent,
} from "./types";

/** intent ที่แตะตะกร้าได้ — นอกจากนี้ไฟล์นี้ไม่ยุ่งด้วย */
export type VoiceCartIntent =
  | VoiceAddItemIntent
  | VoiceSetQuantityIntent
  | VoiceIncreaseItemIntent
  | VoiceDecreaseItemIntent
  | VoiceRemoveItemIntent;

export function isVoiceCartIntent(intent: VoiceIntent): intent is VoiceCartIntent {
  return (
    intent.type === "pos.add_item" ||
    intent.type === "pos.set_quantity" ||
    intent.type === "pos.increase_item" ||
    intent.type === "pos.decrease_item" ||
    intent.type === "pos.remove_item"
  );
}

export type VoiceCartBlockedReason =
  | "not_cart_intent"
  | "cart_locked"
  | "product_not_found"
  | "ambiguous_product"
  | "needs_selection"
  | "product_unavailable"
  | "item_not_in_cart"
  | "invalid_quantity";

export interface VoiceCartCandidate {
  readonly id: string;
  readonly name: string;
}

export type VoiceCartResolution =
  | { readonly status: "applied"; readonly cart: Cart; readonly announcement: string }
  | {
      readonly status: "blocked";
      readonly reason: VoiceCartBlockedReason;
      readonly announcement: string;
      readonly candidates?: readonly VoiceCartCandidate[];
    };

export interface VoiceCartContext {
  readonly cart: Cart;
  readonly products: readonly Product[];
  readonly priceTier?: PriceTier;
  /** ตะกร้าถูกล็อก (สร้างออร์เดอร์แล้ว/กำลังชำระ) — เสียงห้ามแตะ */
  readonly locked?: boolean;
}

function blocked(
  reason: VoiceCartBlockedReason,
  announcement: string,
  candidates?: readonly VoiceCartCandidate[],
): VoiceCartResolution {
  return { status: "blocked", reason, announcement, candidates };
}

/** เทียบชื่อแบบ deterministic: ตัดช่องว่างและตัวพิมพ์ ไม่มี fuzzy ที่เดาผิดได้ */
function normalizeName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, "");
}

/**
 * หา "สินค้าเดียว" ที่ตรงกับคำพูด
 * ลำดับ: ตรงทั้งชื่อ → ขึ้นต้นด้วย → มีคำนั้นอยู่ ; เจอหลายตัวในชั้นเดียวกัน = คลุมเครือ
 */
export function matchVoiceProduct(
  phrase: string,
  products: readonly Product[],
): { readonly product: Product } | { readonly candidates: readonly Product[] } | null {
  const target = normalizeName(phrase);
  if (!target) return null;
  const sellable = products.filter((p) => p.isActive && p.availableForPos);

  const layers: ReadonlyArray<(name: string) => boolean> = [
    (name) => name === target,
    (name) => name.startsWith(target),
    (name) => name.includes(target),
  ];
  for (const test of layers) {
    const hits = sellable.filter((p) => test(normalizeName(p.name)));
    if (hits.length === 1) return { product: hits[0] };
    if (hits.length > 1) return { candidates: hits };
  }
  return null;
}

function requiresSelection(product: Product): boolean {
  if (product.variants.length > 0) return true;
  return product.modifierGroups.some((group) => group.isRequired);
}

function candidatesOf(products: readonly Product[]): readonly VoiceCartCandidate[] {
  return products.slice(0, 5).map((p) => ({ id: p.id, name: p.name }));
}

/** หา "บรรทัดเดียว" ในตะกร้าของสินค้านั้น — หลายบรรทัด (ต่างตัวเลือก) ต้องให้เลือกบนจอ */
function findSingleCartLine(cart: Cart, productId: string) {
  const lines = cart.items.filter((item) => item.productId === productId);
  if (lines.length === 1) return { line: lines[0] };
  if (lines.length === 0) return { missing: true as const };
  return { ambiguous: true as const };
}

function resolveProduct(phrase: string, context: VoiceCartContext) {
  const match = matchVoiceProduct(phrase, context.products);
  if (!match) {
    return blocked("product_not_found", "ไม่พบสินค้าที่พูด — เลือกจากเมนูบนหน้าจอได้");
  }
  if ("candidates" in match) {
    return blocked(
      "ambiguous_product",
      "มีสินค้าชื่อคล้ายกันหลายรายการ — เลือกจากหน้าจอ",
      candidatesOf(match.candidates),
    );
  }
  return match.product;
}

/**
 * แปลง intent เป็นตะกร้าใบใหม่ — คืน "blocked" เมื่อทำไม่ได้ โดยไม่แตะตะกร้าเดิม
 * ผู้เรียกต้อง snapshot ตะกร้าเดิมไว้ก่อนเสมอเพื่อรองรับ Undo
 */
export function applyVoiceCartIntent(intent: VoiceIntent, context: VoiceCartContext): VoiceCartResolution {
  if (!isVoiceCartIntent(intent)) {
    return blocked("not_cart_intent", "คำสั่งนี้ไม่ใช่คำสั่งตะกร้า");
  }
  if (context.locked) {
    return blocked("cart_locked", "สร้างออร์เดอร์แล้ว — แก้ตะกร้าด้วยเสียงไม่ได้ ต้องทำบนหน้าจอ");
  }

  if (intent.type === "pos.add_item") {
    const resolved = resolveProduct(intent.productPhrase, context);
    if ("status" in resolved) return resolved;
    if (resolved.outOfStock) {
      return blocked("product_unavailable", `${resolved.name} ของหมด — เลือกจากหน้าจอได้`);
    }
    if (requiresSelection(resolved)) {
      return blocked(
        "needs_selection",
        `${resolved.name} ต้องเลือกตัวเลือกก่อน — เลือกบนหน้าจอ`,
        candidatesOf([resolved]),
      );
    }
    if (intent.quantity < VOICE_MIN_QUANTITY || intent.quantity > VOICE_MAX_QUANTITY) {
      return blocked("invalid_quantity", "จำนวนไม่ถูกต้อง — ระบุจำนวนระหว่าง 1 ถึง 99");
    }
    const cart = addToCart(context.cart, {
      product: resolved,
      variant: null,
      modifiers: [],
      quantity: intent.quantity,
      priceTier: context.priceTier,
    });
    return { status: "applied", cart, announcement: `เพิ่ม ${resolved.name} ${intent.quantity} รายการแล้ว` };
  }

  // ที่เหลือทำงานกับ "บรรทัดที่มีอยู่แล้ว" ในตะกร้า
  const resolved = resolveProduct(intent.productPhrase, context);
  if ("status" in resolved) return resolved;

  const found = findSingleCartLine(context.cart, resolved.id);
  if ("missing" in found) {
    return blocked("item_not_in_cart", `ยังไม่มี ${resolved.name} ในตะกร้า`);
  }
  if ("ambiguous" in found) {
    return blocked("needs_selection", `${resolved.name} มีหลายตัวเลือกในตะกร้า — แก้บนหน้าจอ`);
  }
  const line = found.line;

  if (intent.type === "pos.remove_item") {
    return {
      status: "applied",
      cart: removeFromCart(context.cart, line.key),
      announcement: `เอา ${resolved.name} ออกจากตะกร้าแล้ว`,
    };
  }

  const nextQuantity =
    intent.type === "pos.set_quantity"
      ? intent.quantity
      : intent.type === "pos.increase_item"
        ? line.quantity + intent.delta
        : line.quantity - intent.delta;

  if (intent.type === "pos.set_quantity" && (nextQuantity < VOICE_MIN_QUANTITY || nextQuantity > VOICE_MAX_QUANTITY)) {
    return blocked("invalid_quantity", "จำนวนไม่ถูกต้อง — ระบุจำนวนระหว่าง 1 ถึง 99");
  }
  if (nextQuantity > VOICE_MAX_QUANTITY) {
    return blocked("invalid_quantity", `จำนวนเกิน ${VOICE_MAX_QUANTITY} — แก้บนหน้าจอ`);
  }
  if (nextQuantity <= 0) {
    return {
      status: "applied",
      cart: removeFromCart(context.cart, line.key),
      announcement: `เอา ${resolved.name} ออกจากตะกร้าแล้ว`,
    };
  }
  return {
    status: "applied",
    cart: updateQuantity(context.cart, line.key, nextQuantity),
    announcement: `ตั้ง ${resolved.name} เป็น ${nextQuantity} รายการแล้ว`,
  };
}
