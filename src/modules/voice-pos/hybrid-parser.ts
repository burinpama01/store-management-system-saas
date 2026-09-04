// P5 (v0.44.4) — ตัวจัดเส้นทาง: deterministic ก่อนเสมอ, AI เป็นทางสำรองที่แคบมาก
//
// กติกาที่ห้ามละเมิด:
//   1. คำสั่งที่ parser เดิมเข้าใจแล้ว ("ลาเต้สองแก้ว") ต้องไม่ออก network เลย
//      — เร็วกว่า, ไม่เสียโควตา, และไม่ส่งคำพูดออกนอกเครื่องโดยไม่จำเป็น
//   2. คำต้องห้าม (Tier D) block ทั้ง "ก่อนส่ง" และ "หลังรับ" — AI ไม่มีสิทธิ์ override
//   3. ความล้มเหลวทุกชนิดของ AI = ไม่มีอะไรเกิดกับตะกร้า และบอกทางออกด้วยมือ
//
// ไฟล์นี้ pure: client ถูกฉีดเข้ามา จึงทดสอบได้โดยไม่ต้องมี network

import { containsForbiddenVoicePhrase, parseVoiceCommand, type ParseVoiceCommandOptions } from "./parser";
import type { VoiceParseResult } from "./types";
import type { AiVoiceIntentEnvelope } from "./ai-intent-schema";
import type { VoiceIntentClientResult } from "./ai-intent-client";

export type VoiceHybridOutcome =
  /** parser เดิมเข้าใจแล้ว — ไม่มีการเรียก AI */
  | { readonly source: "deterministic"; readonly result: VoiceParseResult }
  /** AI เสนอคำสั่งกลับมาและผ่านด่านความปลอดภัยแล้ว */
  | { readonly source: "ai"; readonly envelope: AiVoiceIntentEnvelope }
  /** AI ตอบว่าไม่เข้าใจ/ต้องถามเพิ่ม — ไม่มีคำสั่งให้ทำ */
  | { readonly source: "ai_no_command"; readonly envelope: AiVoiceIntentEnvelope }
  /** เรียก AI ไม่ได้/ไม่ทัน/คำตอบผิดรูป — ตะกร้าต้องไม่เปลี่ยน */
  | { readonly source: "ai_unavailable"; readonly reason: string }
  /** คำต้องห้าม — ตัดจบ ไม่ว่าจะมาจากคำพูดหรือจากคำตอบของ AI */
  | { readonly source: "blocked"; readonly at: "utterance" | "ai_response" };

export const AI_UNAVAILABLE_MESSAGE = "ยังแปลคำสั่งนี้ไม่ได้ — ใช้ปุ่มหรือพูดแบบสั้นได้";

/**
 * ด่านหลังรับคำตอบ: วลีทุกตัวที่ AI เสนอต้องผ่าน denylist เดียวกับคำพูดดิบ
 * ("เพิ่มส่วนลด 50 บาท" ที่หลุดมาเป็น productPhrase ต้องตายตรงนี้)
 */
export function validateAiProposalAgainstAllowlist(
  envelope: AiVoiceIntentEnvelope,
): VoiceHybridOutcome {
  if (envelope.outcome === "blocked") return { source: "blocked", at: "ai_response" };

  for (const command of envelope.commands) {
    const phrases = [command.productPhrase ?? "", ...command.optionPhrases];
    if (phrases.some((phrase) => containsForbiddenVoicePhrase(phrase))) {
      return { source: "blocked", at: "ai_response" };
    }
  }

  if (envelope.outcome !== "command_batch" || envelope.commands.length === 0) {
    return { source: "ai_no_command", envelope };
  }
  return { source: "ai", envelope };
}

export interface HybridParseOptions extends ParseVoiceCommandOptions {
  /** ผู้เรียกฉีดเข้ามา — คืน null เมื่อ AI ถูกปิดจากฝั่ง UI (flag/ผู้ใช้ไม่เปิด) */
  readonly requestAiVoiceIntent?: (transcript: string) => Promise<VoiceIntentClientResult>;
}

/**
 * เส้นทางเดียวที่ UI ควรเรียก
 * ส่ง AI เฉพาะกรณี resultCode === "no_match" และมีข้อความจริงเท่านั้น
 */
export async function parseVoiceCommandHybrid(
  transcript: string,
  options: HybridParseOptions = {},
): Promise<VoiceHybridOutcome> {
  const fast = parseVoiceCommand(transcript, options);

  // matched / forbidden / invalid_quantity / low_confidence / empty → จบที่ deterministic
  if (fast.resultCode !== "no_match") return { source: "deterministic", result: fast };

  const text = transcript.trim();
  if (!text) return { source: "deterministic", result: fast };

  // ด่านที่ 1: ไม่ส่งคำต้องห้ามออกนอกเครื่องตั้งแต่แรก
  if (containsForbiddenVoicePhrase(text)) return { source: "blocked", at: "utterance" };

  if (!options.requestAiVoiceIntent) return { source: "deterministic", result: fast };

  const response = await options.requestAiVoiceIntent(text);
  if (!response.ok) return { source: "ai_unavailable", reason: response.reason };

  // ด่านที่ 2: ตรวจคำตอบด้วยกติกาเดิม
  return validateAiProposalAgainstAllowlist(response.envelope);
}
