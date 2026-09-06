// U15 — Voice Tier B cart (R2) · ตัวแปลง intent → ตะกร้าใบใหม่ (pure ล้วน)
// ห้าม import React/router/server action — ใช้สัญญาเดิมของ src/modules/pos/cart.ts เท่านั้น
//
// กฎที่ล็อกไว้:
//   - แตะได้เฉพาะตะกร้าในเครื่อง (local) และย้อนกลับได้ทุกครั้ง (Undo 6 วินาที ทำที่ชั้น UI)
//   - ต้องตรงสินค้า "รายการเดียว" เท่านั้น — คลุมเครือ/ไม่พบ/ต้องเลือกตัวเลือก = ไม่แตะตะกร้า
//   - สินค้าที่ต้องเลือก variant หรือ modifier บังคับ ต้องให้ผู้ใช้เลือกบนจอ (Tier C)
//   - transcript ไม่เข้ามาถึงไฟล์นี้ — รับเฉพาะ intent ที่ parse แล้ว

import { addToCart, removeFromCart, updateQuantity } from "@/modules/pos/cart";
import { buildDefaultModifierSelections } from "@/modules/pos/default-modifiers";
import type { Cart } from "@/modules/pos/types";
import type { PriceTier } from "@/modules/pos/pricing";
import type { ModifierOption, Product, ProductVariant } from "@/modules/catalog/types";
import { VOICE_MAX_QUANTITY, VOICE_MIN_QUANTITY } from "./parser";
import type {
  VoiceAddItemIntent,
  VoiceChangeOptionIntent,
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
  | VoiceRemoveItemIntent
  | VoiceChangeOptionIntent;

export function isVoiceCartIntent(intent: VoiceIntent): intent is VoiceCartIntent {
  return (
    intent.type === "pos.add_item" ||
    intent.type === "pos.set_quantity" ||
    intent.type === "pos.increase_item" ||
    intent.type === "pos.decrease_item" ||
    intent.type === "pos.remove_item" ||
    intent.type === "pos.change_option"
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
  | "invalid_quantity"
  | "option_not_found"
  | "option_not_applicable";

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

/** U22 — คำเรียกเมนูที่ร้านบันทึกไว้ ("มัจฉะลาเต้" → สินค้า Matcha latte) */
export interface VoiceProductAlias {
  readonly aliasText: string;
  readonly productId: string;
}

export interface VoiceCartContext {
  readonly cart: Cart;
  readonly products: readonly Product[];
  /** คำเรียกเมนูของร้าน (เฉพาะที่เปิดใช้งาน) */
  readonly productAliases?: readonly VoiceProductAlias[];
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
 * U21 — ตัดวรรณยุกต์/ทัณฑฆาตออก เพื่อให้เสียงที่ถอดมาสะกดต่างเล็กน้อยยังจับคู่ได้
 * (เช่น "ลาเต้" กับ "ลาเต", "อเมริกาโน่" กับ "อเมริกาโน") — ยังเป็นการเทียบตรงตัว ไม่ใช่การเดา
 */
function looseName(value: string): string {
  return normalizeName(value).replace(/[่-๋์]/g, "");
}

/** คำเชื่อมเล็ก ๆ ที่พูดคั่นตัวเลือกได้ โดยไม่ถือว่าเป็น "ตัวเลือกที่ไม่รู้จัก" */
const OPTION_CONNECTORS: readonly string[] = ["แบบ", "เอา", "ขอ", "และ", "กับ", "ใส่", "เป็น"];

/**
 * หา "สินค้าเดียว" ที่ตรงกับคำพูด
 * ลำดับ: ตรงทั้งชื่อ → ขึ้นต้นด้วย → มีคำนั้นอยู่ ; เจอหลายตัวในชั้นเดียวกัน = คลุมเครือ
 */
export function matchVoiceProduct(
  phrase: string,
  products: readonly Product[],
): { readonly product: Product } | { readonly candidates: readonly Product[] } | null {
  const target = looseName(phrase);
  if (!target) return null;
  const sellable = products.filter((p) => p.isActive && p.availableForPos);

  const layers: ReadonlyArray<(name: string) => boolean> = [
    (name) => name === target,
    (name) => name.startsWith(target),
    (name) => name.includes(target),
  ];
  for (const test of layers) {
    const hits = sellable.filter((p) => test(looseName(p.name)));
    if (hits.length === 1) return { product: hits[0] };
    if (hits.length > 1) return { candidates: hits };
  }
  return null;
}

/** ตัวเลือกที่ "พูดมาพร้อมชื่อสินค้า" ถูกแปลงเป็นสิ่งที่ตะกร้าใช้ได้แล้ว */
export interface VoiceProductSelection {
  readonly product: Product;
  readonly variant: ProductVariant | null;
  /** ค่าเริ่มต้นของสินค้า + ตัวเลือกที่พูดทับลงไป */
  readonly modifiers: Record<string, ModifierOption[]>;
  /** ชื่อตัวเลือกที่จับได้จากคำพูด (ไว้บอกผู้ใช้) */
  readonly spokenOptionNames: readonly string[];
  /** กลุ่มตัวเลือกที่ "ผู้ใช้พูดมาเอง" (ค่าเริ่มต้นไม่นับ) */
  readonly spokenGroupIds: readonly string[];
  /** ส่วนที่พูดมาแต่ไม่ตรงตัวเลือกใดเลย — ไม่ว่างเมื่อไรห้ามเดา ต้องให้เลือกบนจอ */
  readonly unknownPhrase: string;
  readonly missingRequiredGroups: readonly string[];
  readonly needsVariant: boolean;
}

export type VoiceProductResolution =
  | { readonly status: "matched"; readonly selection: VoiceProductSelection }
  | { readonly status: "ambiguous"; readonly candidates: readonly Product[] }
  | { readonly status: "not_found" };

/**
 * U21 — รองรับคำสั่งยาว: "อเมริกาโน่คั่วเข้ม", "ลาเต้หวาน 0% นมโอ๊ต คั่วกลาง", "อเมริกาโน่ร้อน"
 *
 * วิธี: หา "ชื่อสินค้าที่ยาวที่สุดซึ่งเป็นคำขึ้นต้นของสิ่งที่พูด" แล้วถือว่าส่วนที่เหลือคือตัวเลือก
 * จากนั้นเริ่มจาก "ค่าเริ่มต้นของสินค้า" แล้วเอาตัวเลือกที่พูดทับลงไปทีละกลุ่ม
 * (ดังนั้น "อเมริกาโน่ร้อน" จะแทนที่ค่าเริ่มต้น "เย็น" และราคาคิดตามที่พูดจริง)
 */
export function resolveVoiceProductPhrase(
  phrase: string,
  products: readonly Product[],
  productAliases: readonly VoiceProductAlias[] = [],
): VoiceProductResolution {
  const spoken = looseName(phrase);
  if (!spoken) return { status: "not_found" };
  const sellable = products.filter((p) => p.isActive && p.availableForPos);

  // 1) ชื่อสินค้า "และคำเรียกที่ร้านบันทึกไว้" ที่เป็นคำขึ้นต้น — ยาวที่สุดชนะ
  //    ("อเมริกาโน่น้ำส้ม" ชนะ "อเมริกาโน่" / "มัจฉะลาเต้" ชี้ไปสินค้า Matcha latte)
  const byId = new Map(sellable.map((product) => [product.id, product]));
  const namedEntries: Array<{ name: string; product: Product }> = [
    ...sellable.map((product) => ({ name: looseName(product.name), product })),
    ...productAliases
      .map((alias) => {
        const product = byId.get(alias.productId);
        return product ? { name: looseName(alias.aliasText), product } : null;
      })
      .filter((entry): entry is { name: string; product: Product } => entry !== null),
  ];

  let best: { product: Product; rest: string; length: number } | null = null;
  let tied: Product[] = [];
  for (const { name, product } of namedEntries) {
    if (!name || !spoken.startsWith(name)) continue;
    if (!best || name.length > best.length) {
      best = { product, rest: spoken.slice(name.length), length: name.length };
      tied = [product];
    } else if (name.length === best.length && !tied.some((item) => item.id === product.id)) {
      tied.push(product);
    }
  }
  if (best && tied.length > 1) return { status: "ambiguous", candidates: tied };

  // 2) ไม่มีคำขึ้นต้นตรง → กลับไปใช้การจับคู่ทั้งประโยคแบบเดิม (ไม่มีตัวเลือกต่อท้าย)
  if (!best) {
    const fallback = matchVoiceProduct(phrase, products);
    if (!fallback) return { status: "not_found" };
    if ("candidates" in fallback) return { status: "ambiguous", candidates: fallback.candidates };
    best = { product: fallback.product, rest: "", length: 0 };
  }

  return { status: "matched", selection: applySpokenOptions(best.product, best.rest) };
}

type OptionCandidate =
  | { readonly kind: "variant"; readonly name: string; readonly variant: ProductVariant }
  | {
      readonly kind: "option";
      readonly name: string;
      readonly groupId: string;
      readonly single: boolean;
      readonly option: ModifierOption;
    };

/** เอาคำที่เหลือหลังชื่อสินค้ามาจับกับตัวเลือกจริงของสินค้านั้น (ยาวก่อนสั้น กันชื่อซ้อนกัน) */
function applySpokenOptions(product: Product, restRaw: string): VoiceProductSelection {
  const modifiers: Record<string, ModifierOption[]> = {
    ...buildDefaultModifierSelections(product.modifierGroups),
  };
  const spokenOptionNames: string[] = [];
  const spokenGroupIds = new Set<string>();
  let variant: ProductVariant | null = null;
  let remaining = restRaw;

  const candidates: OptionCandidate[] = [
    ...product.variants
      .filter((item) => item.isActive)
      .map((item) => ({ kind: "variant" as const, name: looseName(item.name), variant: item })),
    ...product.modifierGroups.flatMap((group) =>
      group.options
        .filter((option) => option.isActive)
        .map((option) => ({
          kind: "option" as const,
          name: looseName(option.name),
          groupId: group.id,
          single: group.selectionType === "single",
          option,
        })),
    ),
  ]
    .filter((item) => item.name.length > 0)
    .sort((a, b) => b.name.length - a.name.length);

  for (const candidate of candidates) {
    const index = remaining.indexOf(candidate.name);
    if (index < 0) continue;
    remaining = remaining.slice(0, index) + remaining.slice(index + candidate.name.length);
    if (candidate.kind === "variant") {
      if (!variant) {
        variant = candidate.variant;
        spokenOptionNames.push(candidate.variant.name);
      }
      continue;
    }
    const current = modifiers[candidate.groupId] ?? [];
    modifiers[candidate.groupId] = candidate.single
      ? [candidate.option]
      : [...current.filter((item) => item.id !== candidate.option.id), candidate.option];
    spokenGroupIds.add(candidate.groupId);
    spokenOptionNames.push(candidate.option.name);
  }

  for (const connector of OPTION_CONNECTORS) {
    remaining = remaining.split(looseName(connector)).join("");
  }

  // กฎที่หน้าร้านกำหนด: "มีค่าเริ่มต้นอยู่แล้ว = เพิ่มได้เลย ไม่ต้องเด้งหน้าต่าง"
  // จะเด้งเฉพาะตัวเลือกบังคับที่ยังไม่มีค่าเริ่มต้นและผู้ใช้ยังไม่ได้พูดมา
  const missingRequiredGroups = product.modifierGroups
    .filter(
      (group) => group.isRequired && (modifiers[group.id]?.length ?? 0) < Math.max(1, group.minSelections),
    )
    .map((group) => group.name);

  return {
    product,
    variant,
    modifiers,
    spokenOptionNames,
    spokenGroupIds: [...spokenGroupIds],
    unknownPhrase: remaining.trim(),
    missingRequiredGroups,
    needsVariant: product.variants.length > 0 && !variant,
  };
}

type SpokenOptionMatch =
  | { readonly kind: "variant"; readonly variant: ProductVariant }
  | {
      readonly kind: "option";
      readonly groupId: string;
      readonly groupName: string;
      readonly option: ModifierOption;
      readonly single: boolean;
    };

/**
 * จับคู่ "ตัวเลือกที่พูดมาคำเดียว" กับตัวเลือกจริงของสินค้านั้น
 *
 * ต่างจาก applySpokenOptions ตรงที่อันนี้ไม่แตะค่าอื่นเลย — ใช้ตอนแก้ของที่อยู่ในตะกร้าแล้ว
 * ซึ่งต้องรักษาตัวเลือกอื่นที่เลือกไว้ก่อนหน้าไว้ทั้งหมด (เปลี่ยนความหวานต้องไม่ทำให้นมโอ๊ตหาย)
 * เทียบชื่อยาวสุดก่อน เพื่อให้ "หวานน้อย" ชนะ "หวาน"
 */
function matchSpokenOption(product: Product, phrase: string): SpokenOptionMatch | null {
  const target = looseName(phrase);
  if (!target) return null;

  const candidates: Array<{ name: string; match: SpokenOptionMatch }> = [
    ...product.variants
      .filter((variant) => variant.isActive)
      .map((variant) => ({
        name: looseName(variant.name),
        match: { kind: "variant" as const, variant },
      })),
    ...product.modifierGroups.flatMap((group) =>
      group.options
        .filter((option) => option.isActive)
        .map((option) => ({
          name: looseName(option.name),
          match: {
            kind: "option" as const,
            groupId: group.id,
            groupName: group.name,
            option,
            single: group.selectionType === "single",
          },
        })),
    ),
  ]
    .filter((entry) => entry.name.length > 0)
    .sort((a, b) => b.name.length - a.name.length);

  return candidates.find((entry) => entry.name === target)?.match
    ?? candidates.find((entry) => target.includes(entry.name))?.match
    ?? null;
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

/** แปลงผลจับคู่เป็น selection หรือ blocked ที่พร้อมส่งกลับ */
function resolveSelection(phrase: string, context: VoiceCartContext) {
  const resolution = resolveVoiceProductPhrase(phrase, context.products, context.productAliases);
  if (resolution.status === "not_found") {
    return blocked("product_not_found", "ไม่พบสินค้าที่พูด — เลือกจากเมนูบนหน้าจอได้");
  }
  if (resolution.status === "ambiguous") {
    return blocked(
      "ambiguous_product",
      "มีสินค้าชื่อคล้ายกันหลายรายการ — เลือกจากหน้าจอ",
      candidatesOf(resolution.candidates),
    );
  }
  return resolution.selection;
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
    const resolved = resolveSelection(intent.productPhrase, context);
    if ("status" in resolved) return resolved;
    const { product, variant, modifiers, spokenOptionNames, unknownPhrase, missingRequiredGroups, needsVariant } =
      resolved;

    if (product.outOfStock) {
      return blocked("product_unavailable", `${product.name} ของหมด — เลือกจากหน้าจอได้`);
    }
    if (intent.quantity < VOICE_MIN_QUANTITY || intent.quantity > VOICE_MAX_QUANTITY) {
      return blocked("invalid_quantity", "จำนวนไม่ถูกต้อง — ระบุจำนวนระหว่าง 1 ถึง 99");
    }
    // พูดตัวเลือกมาแต่จับไม่ได้ → ห้ามเดา ให้เลือกบนจอ (เปิด dialog ที่ชั้น UI)
    if (unknownPhrase.length > 1) {
      return blocked(
        "needs_selection",
        `${product.name}: ยังไม่รู้จักตัวเลือกที่พูด — เลือกบนหน้าจอ`,
        candidatesOf([product]),
      );
    }
    if (needsVariant || missingRequiredGroups.length > 0) {
      const missing = [...(needsVariant ? ["ตัวเลือกสินค้า"] : []), ...missingRequiredGroups];
      return blocked(
        "needs_selection",
        `${product.name} ต้องเลือก ${missing.join(" และ ")} ก่อน`,
        candidatesOf([product]),
      );
    }

    const cart = addToCart(context.cart, {
      product,
      variant,
      modifiers: Object.entries(modifiers).flatMap(([groupId, options]) => {
        const group = product.modifierGroups.find((item) => item.id === groupId);
        if (!group) return [];
        return options.map((option) => ({ groupId, groupName: group.name, option }));
      }),
      quantity: intent.quantity,
      priceTier: context.priceTier,
    });
    const optionSuffix = spokenOptionNames.length > 0 ? ` (${spokenOptionNames.join(", ")})` : "";
    return {
      status: "applied",
      cart,
      announcement: `เพิ่ม ${product.name}${optionSuffix} ${intent.quantity} รายการแล้ว`,
    };
  }

  // ที่เหลือทำงานกับ "บรรทัดที่มีอยู่แล้ว" ในตะกร้า — ตัวเลือกที่พูดต่อท้ายไม่มีผลตรงนี้
  const resolved = resolveSelection(intent.productPhrase, context);
  if ("status" in resolved) return resolved;
  const product = resolved.product;

  const found = findSingleCartLine(context.cart, product.id);
  if ("missing" in found) {
    return blocked("item_not_in_cart", `ยังไม่มี ${product.name} ในตะกร้า`);
  }
  if ("ambiguous" in found) {
    return blocked("needs_selection", `${product.name} มีหลายตัวเลือกในตะกร้า — แก้บนหน้าจอ`);
  }
  const line = found.line;

  if (intent.type === "pos.remove_item") {
    return {
      status: "applied",
      cart: removeFromCart(context.cart, line.key),
      announcement: `เอา ${product.name} ออกจากตะกร้าแล้ว`,
    };
  }

  // แก้ตัวเลือกของบรรทัดที่อยู่ในตะกร้าแล้ว ("เปลี่ยนลาเต้เป็นหวานน้อย")
  if (intent.type === "pos.change_option") {
    // หน่วยแพ็ค (โหล/ลัง) เป็นราคาเหมา ไม่มีตัวเลือกให้แก้ — บอกตรง ๆ ดีกว่าแก้เงียบ ๆ
    if (line.unit) {
      return blocked("option_not_applicable", `${product.name} ขายเป็นแพ็ค ไม่มีตัวเลือกให้แก้`);
    }

    const match = matchSpokenOption(product, intent.optionPhrase);
    if (!match) {
      return blocked("option_not_found", `${product.name} ไม่มีตัวเลือกที่พูด — แก้บนหน้าจอได้`);
    }

    // ตั้งต้นจาก "ตัวเลือกที่บรรทัดนี้เลือกไว้จริง" ไม่ใช่ค่าเริ่มต้นของสินค้า
    // ไม่งั้นการเปลี่ยนความหวานจะล้างตัวเลือกอื่นที่เคยเลือกไว้ทิ้งไปด้วย
    let variant: ProductVariant | null =
      product.variants.find((item) => item.id === line.variant?.id) ?? null;
    const current: Array<{ groupId: string; groupName: string; option: ModifierOption }> = [];
    for (const selected of line.modifiers) {
      const group = product.modifierGroups.find((item) => item.id === selected.modifierGroupId);
      const option = group?.options.find((item) => item.id === selected.option.id);
      if (group && option) current.push({ groupId: group.id, groupName: group.name, option });
    }

    let modifiers = current;
    if (match.kind === "variant") {
      if (variant?.id === match.variant.id) {
        return blocked("option_not_applicable", `${product.name} เป็น ${match.variant.name} อยู่แล้ว`);
      }
      variant = match.variant;
    } else {
      if (current.some((item) => item.option.id === match.option.id)) {
        return blocked("option_not_applicable", `${product.name} เป็น ${match.option.name} อยู่แล้ว`);
      }
      // กลุ่มเลือกได้อย่างเดียว = แทนที่ของเดิมในกลุ่มนั้น; เลือกได้หลายอย่าง = เพิ่มเข้าไป
      const kept = match.single ? current.filter((item) => item.groupId !== match.groupId) : current;
      modifiers = [...kept, { groupId: match.groupId, groupName: match.groupName, option: match.option }];
    }

    const withoutOld = removeFromCart(context.cart, line.key);
    const cart = addToCart(withoutOld, {
      product,
      variant,
      modifiers,
      quantity: line.quantity,
      priceTier: context.priceTier,
      note: line.note,
    });
    const optionName = match.kind === "variant" ? match.variant.name : match.option.name;
    return {
      status: "applied",
      cart,
      announcement: `เปลี่ยน ${product.name} เป็น ${optionName} แล้ว`,
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
      announcement: `เอา ${product.name} ออกจากตะกร้าแล้ว`,
    };
  }
  return {
    status: "applied",
    cart: updateQuantity(context.cart, line.key, nextQuantity),
    announcement: `ตั้ง ${product.name} เป็น ${nextQuantity} รายการแล้ว`,
  };
}
