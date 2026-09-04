// P6 (v0.44.5) — แปลง "วลี" ที่ AI เสนอ → คำสั่งที่ระบบทำได้จริง
//
// หัวใจของ Phase 1: AI ไม่เคยเลือกสินค้าให้ — มันแค่บอกว่าได้ยินว่าอะไร
// ไฟล์นี้คือคนที่จับคู่กับสินค้าจริงของร้าน ณ วินาทีที่จะลงมือ (re-read snapshot)
// และถ้าจับคู่ไม่ได้แบบชัดเจน ต้อง "ถาม" ไม่ใช่ "เดา"
//
// กติกา:
//   - ชื่อสินค้าที่ตรงและยาวที่สุดชนะ; ตรงหลายตัวในชั้นเดียวกัน = คลุมเครือ ต้องถาม
//   - ตัวเลือกต้องตรงชื่อจริง หรือตรง alias ที่ผู้จัดการอนุมัติเท่านั้น
//     "หวานน้อย" ห้ามกลายเป็น 25% เอง ตราบใดที่ร้านยังไม่ได้บอกว่ามันคือ 25%
//   - จำนวนที่ไม่ได้พูด (null) ของ add/set = ต้องถาม ไม่ใช่เดาเป็น 1
//   - สินค้าปิดขาย/ของหมด = บอกตามจริง ไม่ใส่ลงตะกร้า

import type { Product } from "@/modules/catalog/types";
import { normalizeAiCommandQuantity, type AiVoiceCommand } from "./ai-intent-schema";
import { resolveVoiceProductPhrase, type VoiceProductAlias } from "./cart";
import type { VoiceIntent } from "./types";

/** ตัวเลือกที่จับคู่ได้ — รับเป็นสตริงเปล่าได้ (ชื่อคือ id ในตัวมันเอง) */
export type VoiceResolvableOption = { readonly id: string; readonly name: string };

export interface VoiceOptionAlias {
  readonly aliasText: string;
  readonly optionId: string;
}

export interface ResolveOptionContext {
  readonly options: ReadonlyArray<string | VoiceResolvableOption>;
  readonly aliases: readonly VoiceOptionAlias[];
}

export type ResolveOptionResult =
  | { readonly status: "matched"; readonly optionId: string }
  /** ไม่ตรงอะไรชัด ๆ — ต้องให้คนเลือกบนจอ ห้ามเดาแทน */
  | { readonly status: "needs_selection" };

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, "").replace(/[่-๋์]/g, "");
}

function toOption(option: string | VoiceResolvableOption): VoiceResolvableOption {
  return typeof option === "string" ? { id: option, name: option } : option;
}

/**
 * จับคู่คำพูดกับตัวเลือกหนึ่งค่า
 * ลำดับ: alias ที่ร้านอนุมัติ → ชื่อตรงตัว ; นอกนั้นคือ needs_selection เสมอ
 */
export function resolveOptionPhrase(
  phrase: string,
  context: ResolveOptionContext,
): ResolveOptionResult {
  const target = normalize(phrase);
  if (!target) return { status: "needs_selection" };

  const options = context.options.map(toOption);

  // alias ของร้านมาก่อน — เป็นการตัดสินใจที่ "คน" อนุมัติไว้แล้ว
  const alias = context.aliases.find((item) => normalize(item.aliasText) === target);
  if (alias && options.some((option) => option.id === alias.optionId)) {
    return { status: "matched", optionId: alias.optionId };
  }

  const exact = options.filter((option) => normalize(option.name) === target);
  if (exact.length === 1) return { status: "matched", optionId: exact[0].id };

  return { status: "needs_selection" };
}

export interface ResolveCommandContext {
  /** สินค้าที่อ่านสด ๆ ตอนจะลงมือ (ไม่ใช่ค่าที่แคชไว้ตอนเริ่มพูด) */
  readonly products: readonly Product[];
  readonly productAliases?: readonly VoiceProductAlias[];
}

export type ResolvedVoiceCommand =
  /** พร้อมส่งต่อให้ applyVoiceCartIntent ของเดิม */
  | { readonly status: "apply"; readonly intent: VoiceIntent; readonly productName: string }
  /** ต้องเปิด dialog ให้เลือกตัวเลือก/ตัวเลือกสินค้า */
  | { readonly status: "needs_option"; readonly productId: string; readonly productName: string; readonly note: string }
  /** ได้ยินชื่อสินค้าแต่ไม่ได้ยินจำนวน */
  | { readonly status: "needs_quantity"; readonly productName: string }
  | { readonly status: "ambiguous"; readonly candidates: readonly { id: string; name: string }[] }
  | { readonly status: "not_found"; readonly note: string }
  | { readonly status: "unavailable"; readonly productName: string }
  | { readonly status: "unsupported" };

const UNSUPPORTED: ResolvedVoiceCommand = { status: "unsupported" };

/**
 * แปลง 1 คำสั่งของ AI → ผลลัพธ์ที่ queue processor ใช้ตัดสินใจได้
 * ไม่มี side effect: ผู้เรียกเป็นคนลงมือ (และ re-read snapshot ก่อนเรียกทุกครั้ง)
 */
export function resolveAiVoiceCommand(
  command: AiVoiceCommand,
  context: ResolveCommandContext,
): ResolvedVoiceCommand {
  if (command.intent === "pos.clear_search") {
    return { status: "apply", intent: { type: "pos.clear_search" }, productName: "" };
  }
  if (command.intent === "navigate") {
    // นำทางยังเป็นหน้าที่ของ deterministic parser + command index เท่านั้น
    return UNSUPPORTED;
  }

  const phrase = command.productPhrase?.trim() ?? "";
  if (!phrase) return { status: "not_found", note: "ไม่ได้ยินชื่อสินค้า" };

  const spoken = [phrase, ...command.optionPhrases].join(" ").trim();
  const resolution = resolveVoiceProductPhrase(spoken, context.products, context.productAliases ?? []);

  if (resolution.status === "not_found") {
    // ลองอีกครั้งด้วยชื่อสินค้าล้วน — ตัวเลือกที่ฟังเพี้ยนไม่ควรทำให้หาสินค้าไม่เจอ
    const fallback = resolveVoiceProductPhrase(phrase, context.products, context.productAliases ?? []);
    if (fallback.status === "not_found") return { status: "not_found", note: "ไม่พบสินค้านี้ในเมนู" };
    if (fallback.status === "ambiguous") {
      return { status: "ambiguous", candidates: fallback.candidates.map((p) => ({ id: p.id, name: p.name })) };
    }
    return {
      status: "needs_option",
      productId: fallback.selection.product.id,
      productName: fallback.selection.product.name,
      note: "ตัวเลือกที่พูดไม่ตรงกับที่มีอยู่ — เลือกบนหน้าจอ",
    };
  }

  if (resolution.status === "ambiguous") {
    return { status: "ambiguous", candidates: resolution.candidates.map((p) => ({ id: p.id, name: p.name })) };
  }

  const { selection } = resolution;
  const product = selection.product;
  if (product.outOfStock === true) {
    return { status: "unavailable", productName: product.name };
  }

  // ยังเลือกไม่ครบ หรือมีคำที่ไม่ตรงตัวเลือกใดเลย → ต้องให้คนเลือก ห้ามเดา
  if (selection.needsVariant || selection.missingRequiredGroups.length > 0 || selection.unknownPhrase) {
    const missing = selection.missingRequiredGroups.join(" / ");
    return {
      status: "needs_option",
      productId: product.id,
      productName: product.name,
      note: missing ? `ยังต้องเลือก ${missing}` : "ยังต้องเลือกตัวเลือกสินค้า",
    };
  }

  const quantity = normalizeAiCommandQuantity(command);
  if (quantity === null) return { status: "needs_quantity", productName: product.name };

  switch (command.intent) {
    case "pos.add_item":
      return { status: "apply", intent: { type: "pos.add_item", productPhrase: spoken, quantity }, productName: product.name };
    case "pos.set_quantity":
      return { status: "apply", intent: { type: "pos.set_quantity", productPhrase: spoken, quantity }, productName: product.name };
    case "pos.increase_item":
      return { status: "apply", intent: { type: "pos.increase_item", productPhrase: spoken, delta: quantity }, productName: product.name };
    case "pos.decrease_item":
      return { status: "apply", intent: { type: "pos.decrease_item", productPhrase: spoken, delta: quantity }, productName: product.name };
    case "pos.remove_item":
      return { status: "apply", intent: { type: "pos.remove_item", productPhrase: spoken }, productName: product.name };
    default:
      return UNSUPPORTED;
  }
}
