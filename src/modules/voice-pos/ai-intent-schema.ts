// P1 (v0.44.0) — สัญญาของสิ่งที่ AI ได้รับอนุญาตให้ "เสนอ" กลับมาเท่านั้น
//
// หลักการที่ล็อกไว้ทั้ง Phase 1:
//   - AI คืน "วลี" (phrase) ไม่เคยคืน productId / optionId / variantId
//     → id ทุกตัวมาจาก resolver ในระบบ ที่อ่านสินค้าจริงของร้าน ณ เวลานั้น
//   - schema เป็น .strict() ทุกชั้น: คีย์แปลกปลอมแม้แต่ตัวเดียว = reject ทั้งก้อน
//   - intent อยู่ใน allowlist ที่แคบกว่า VoiceIntentType เดิม (ไม่มี choose_option /
//     confirm_selection เพราะสองอันนั้นเป็นบริบทของ dialog ที่ deterministic จัดการเอง)
//   - ไม่มี tool, ไม่มี free-text ที่เอาไปสั่งงาน — ข้อความทวนสร้างจากข้อมูลในระบบ
//
// ไฟล์นี้ต้อง pure: ห้าม import React / server-only / env

import { z } from "zod";
import { VOICE_MAX_QUANTITY, VOICE_MIN_QUANTITY } from "./parser";

/** ยาวสุดของวลีที่รับจากโมเดล — กันไม่ให้ยัด payload ยาว ๆ กลับมา */
export const AI_VOICE_PHRASE_MAX = 120;
/** จำนวนคำสั่งสูงสุดต่อ 1 รอบพูด — เกินนี้คือความเสี่ยง ไม่ใช่ความสะดวก */
export const AI_VOICE_MAX_COMMANDS = 8;
/** ตัวเลือกต่อ 1 รายการ */
export const AI_VOICE_MAX_OPTIONS = 8;

/**
 * intent ที่ AI เสนอได้ — แคบกว่า deterministic parser โดยตั้งใจ
 * (เงิน/ส่วนลด/สต๊อก/สิทธิ์/ลูกค้า ไม่มีทางอยู่ในนี้ได้เลยตั้งแต่ระดับ type)
 */
export const AI_VOICE_INTENTS = [
  "pos.add_item",
  "pos.set_quantity",
  "pos.increase_item",
  "pos.decrease_item",
  "pos.remove_item",
  "pos.clear_search",
  "navigate",
] as const;

export type AiVoiceIntentName = (typeof AI_VOICE_INTENTS)[number];

const PhraseSchema = z.string().min(1).max(AI_VOICE_PHRASE_MAX);

export const AiVoiceCommandSchema = z
  .object({
    intent: z.enum(AI_VOICE_INTENTS),
    /** null = ไม่ได้พูดชื่อสินค้า → ต้องถาม ไม่ใช่เดา */
    productPhrase: PhraseSchema.nullable(),
    /**
     * null = ไม่ได้พูดจำนวน → ระบบเป็นผู้ตัดสินตาม contract ของ intent นั้น
     * (ห้ามให้โมเดลเดาเป็น 1 เอง — ดู normalizeAiCommandQuantity)
     */
    quantity: z.number().int().min(VOICE_MIN_QUANTITY).max(VOICE_MAX_QUANTITY).nullable(),
    optionPhrases: z.array(PhraseSchema).max(AI_VOICE_MAX_OPTIONS),
  })
  .strict();

export type AiVoiceCommand = z.infer<typeof AiVoiceCommandSchema>;

export const AI_VOICE_OUTCOMES = ["command_batch", "clarification", "unknown", "blocked"] as const;
export const AI_VOICE_REASON_CODES = [
  "matched",
  "missing_product",
  "missing_quantity",
  "ambiguous",
  "forbidden",
  "unsupported",
] as const;

export type AiVoiceOutcome = (typeof AI_VOICE_OUTCOMES)[number];
export type AiVoiceReasonCode = (typeof AI_VOICE_REASON_CODES)[number];

export const AiVoiceIntentEnvelopeSchema = z
  .object({
    version: z.literal(1),
    outcome: z.enum(AI_VOICE_OUTCOMES),
    commands: z.array(AiVoiceCommandSchema).max(AI_VOICE_MAX_COMMANDS),
    confidence: z.enum(["low", "medium", "high"]),
    reasonCode: z.enum(AI_VOICE_REASON_CODES),
  })
  .strict()
  .superRefine((envelope, ctx) => {
    // command_batch ที่ไม่มีคำสั่งเลย = โมเดลตอบขัดแย้งกับตัวเอง → ไม่รับ
    if (envelope.outcome === "command_batch" && envelope.commands.length === 0) {
      ctx.addIssue({ code: "custom", message: "command_batch ต้องมีอย่างน้อย 1 คำสั่ง" });
    }
    // ทุก outcome ที่ไม่ใช่ command_batch ห้ามแนบคำสั่งมาด้วย (กันสั่งงานแฝง)
    if (envelope.outcome !== "command_batch" && envelope.commands.length > 0) {
      ctx.addIssue({ code: "custom", message: "มีเฉพาะ command_batch เท่านั้นที่แนบคำสั่งได้" });
    }
    for (const [index, command] of envelope.commands.entries()) {
      const needsProduct = command.intent !== "pos.clear_search" && command.intent !== "navigate";
      if (needsProduct && !command.productPhrase) {
        ctx.addIssue({ code: "custom", path: ["commands", index], message: "คำสั่งนี้ต้องมีวลีสินค้า" });
      }
      if (!needsProduct && command.optionPhrases.length > 0) {
        ctx.addIssue({ code: "custom", path: ["commands", index], message: "คำสั่งนี้ไม่รับตัวเลือก" });
      }
    }
  });

export type AiVoiceIntentEnvelope = z.infer<typeof AiVoiceIntentEnvelopeSchema>;

/**
 * จำนวนสุดท้ายที่ระบบใช้จริง — ไม่ใช่ค่าที่โมเดลเดา
 *   add/set  : null = ต้องถาม (คืน null)
 *   inc/dec  : null = ทีละ 1 (ผู้ใช้พูดว่า "เพิ่มอีก" โดยไม่ระบุจำนวน = 1 ตามธรรมชาติ)
 *   remove   : ไม่ใช้จำนวน
 */
export function normalizeAiCommandQuantity(command: AiVoiceCommand): number | null {
  switch (command.intent) {
    case "pos.add_item":
    case "pos.set_quantity":
      return command.quantity;
    case "pos.increase_item":
    case "pos.decrease_item":
      return command.quantity ?? 1;
    default:
      return null;
  }
}

export type AiVoiceParseFailure = { readonly ok: false; readonly reason: "invalid_schema" };
export type AiVoiceParseSuccess = { readonly ok: true; readonly envelope: AiVoiceIntentEnvelope };

/** parse แบบไม่โยน — ผู้เรียกทุกคนต้องจัดการเคส invalid อย่างชัดเจน (fail closed) */
export function parseAiVoiceEnvelope(input: unknown): AiVoiceParseSuccess | AiVoiceParseFailure {
  const parsed = AiVoiceIntentEnvelopeSchema.safeParse(input);
  return parsed.success ? { ok: true, envelope: parsed.data } : { ok: false, reason: "invalid_schema" };
}
