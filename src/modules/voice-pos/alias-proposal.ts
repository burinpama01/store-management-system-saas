// P9 (v0.44.7) — ข้อเสนอ alias ของ "ตัวเลือกสินค้า" (modifier option)
//
// เรื่องนี้ละเอียดอ่อนกว่า alias ทั่วไป เพราะมันเกิดจาก "คำที่ระบบได้ยิน"
// กติกาที่ห้ามละเมิด (แผน P9 + สัญญา privacy เดิมของ voice):
//   - ไม่มี auto-learning: ข้อเสนอเกิดได้ก็ต่อเมื่อ "คนเลือกตัวเลือกจริงบนจอ" แล้วเท่านั้น
//   - ข้อเสนออยู่ในหน่วยความจำของ session ปัจจุบัน ไม่มีตาราง pending ไม่มีการนับความถี่
//   - คนที่ไม่มีสิทธิ์ settings.manage_store ต้องไม่เห็นปุ่มบันทึก และคำที่ได้ยินต้องไม่ถูก
//     เขียนลงที่ใดเลย (แม้แต่ในหน่วยความจำของฝั่ง server)
//   - alias ผูกกับ (สินค้า, กลุ่มตัวเลือก, ตัวเลือก) ของร้านเดียวเท่านั้น ห้ามข้ามร้าน
//
// ไฟล์นี้ pure — ตัดสินใจอย่างเดียว ไม่แตะ DB

import { z } from "zod";
import { normalizeAliasText } from "./alias-repository";

export const MAX_OPTION_ALIAS_LENGTH = 60;

const UUID = z.string().uuid();

/** slots ของ intent_type = "modifier_option" (เก็บใน voice_aliases.slots เดิม) */
export const ModifierOptionSlotsSchema = z
  .object({
    productId: UUID,
    modifierGroupId: UUID,
    optionId: UUID,
  })
  .strict();

export type ModifierOptionSlots = z.infer<typeof ModifierOptionSlotsSchema>;

export interface VoiceOptionAliasProposal {
  /** คำที่ผู้ใช้พูดแล้วระบบจับคู่ไม่ได้ (อยู่ในหน่วยความจำรอบนี้เท่านั้น) */
  readonly phrase: string;
  readonly productId: string;
  readonly productName: string;
  readonly modifierGroupId: string;
  readonly optionId: string;
  readonly optionName: string;
}

export interface ProposalCandidate {
  readonly phrase: string;
  readonly productId: string;
  readonly productName: string;
  readonly modifierGroupId: string;
  readonly optionId: string;
  readonly optionName: string;
  /** ผู้ใช้เป็นคนเลือกตัวเลือกนี้เองบนจอหรือไม่ — false = ห้ามเสนอ */
  readonly chosenByHuman: boolean;
  /** สิทธิ์ settings.manage_store ของผู้ใช้ปัจจุบัน */
  readonly canManageStore: boolean;
  /** alias ที่ร้านมีอยู่แล้ว (เทียบแบบ normalize) */
  readonly existingAliases: readonly string[];
}

export type ProposalDecision =
  | { readonly status: "propose"; readonly proposal: VoiceOptionAliasProposal }
  /** ไม่เสนอ และ (สำคัญ) ไม่เก็บคำที่ได้ยินไว้ที่ไหนเลย */
  | { readonly status: "skip"; readonly reason: "not_human_choice" | "no_permission" | "duplicate" | "invalid" };

/**
 * ตัดสินว่าจะ "เสนอ" ให้ผู้จัดการบันทึก alias นี้หรือไม่
 * ทุกทางที่ไม่ใช่ propose ต้องทิ้งคำพูดทันที
 */
export function decideOptionAliasProposal(input: ProposalCandidate): ProposalDecision {
  // ต้องเป็นการเลือกของคนเท่านั้น — ระบบเดาเองแล้วเสนอ = auto-learning
  if (!input.chosenByHuman) return { status: "skip", reason: "not_human_choice" };
  // ไม่มีสิทธิ์ = ไม่ต้องเก็บคำที่ได้ยินไว้เลย (ไม่ใช่แค่ซ่อนปุ่ม)
  if (!input.canManageStore) return { status: "skip", reason: "no_permission" };

  const phrase = normalizeAliasText(input.phrase);
  if (!phrase || phrase.length > MAX_OPTION_ALIAS_LENGTH) return { status: "skip", reason: "invalid" };

  const slots = ModifierOptionSlotsSchema.safeParse({
    productId: input.productId,
    modifierGroupId: input.modifierGroupId,
    optionId: input.optionId,
  });
  if (!slots.success) return { status: "skip", reason: "invalid" };

  // คำเดียวกับชื่อตัวเลือกอยู่แล้ว = ไม่มีประโยชน์ที่จะบันทึก
  if (normalizeAliasText(input.optionName).toLowerCase() === phrase.toLowerCase()) {
    return { status: "skip", reason: "duplicate" };
  }
  const taken = input.existingAliases.some(
    (alias) => normalizeAliasText(alias).toLowerCase() === phrase.toLowerCase(),
  );
  if (taken) return { status: "skip", reason: "duplicate" };

  return {
    status: "propose",
    proposal: {
      phrase,
      productId: input.productId,
      productName: input.productName,
      modifierGroupId: input.modifierGroupId,
      optionId: input.optionId,
      optionName: input.optionName,
    },
  };
}

/** ตรวจว่า option ที่จะผูกเป็นของร้าน/สินค้า/กลุ่มนั้นจริง (เรียกฝั่ง server ก่อนบันทึก) */
export function isOptionOwnedByStore(
  slots: ModifierOptionSlots,
  catalog: ReadonlyArray<{
    readonly id: string;
    readonly modifierGroups: ReadonlyArray<{
      readonly id: string;
      readonly options: ReadonlyArray<{ readonly id: string }>;
    }>;
  }>,
): boolean {
  const product = catalog.find((item) => item.id === slots.productId);
  if (!product) return false;
  const group = product.modifierGroups.find((item) => item.id === slots.modifierGroupId);
  if (!group) return false;
  return group.options.some((option) => option.id === slots.optionId);
}
