// W6 — กฎความปลอดภัยที่ขึ้นกับ "ที่มาของการเปิดไมค์"
//
// ทำไมต้องแยกตามที่มา: การกดปุ่มพูดคือเจตนาที่ชัดเจนของคนหน้าเคาน์เตอร์ —
// มีคนตั้งใจกด แล้วพูดใส่ไมค์ทันที ส่วนคำปลุกเปิดไมค์ขึ้นมาเองโดยไม่มีใครกดอะไร
// เสียงที่เข้ามาหลังจากนั้นจึงอาจเป็นลูกค้าที่ยืนอยู่หน้าร้าน เสียงทีวี หรือคนคุยกันข้าง ๆ
// ถ้าปฏิบัติกับสองที่มานี้เหมือนกัน "เพิ่มกาแฟเย็นสองแก้ว" ที่ลอยมาจากโต๊ะข้าง ๆ
// จะขึ้นบิลจริงโดยไม่มีใครสั่ง
//
// กติกาที่ล็อกไว้:
//   * คำสั่งที่ไม่แตะตะกร้า (tier A เช่นเปิดหน้า) — ทำได้เลยทั้งสองที่มา
//   * คำสั่งที่แก้ตะกร้า (tier B) — กดปุ่มเอง = ทำเลย, คำปลุก = ต้องยืนยันก่อน
//   * tier C/D — ห้ามทั้งคู่ (เหมือนเดิม ไม่มีอะไรเปลี่ยน)
//   * ข้อเสนอที่รอยืนยันมีอายุ 8 วินาที อยู่ในหน่วยความจำเท่านั้น และผูกกับรอบคำปลุกนั้น

import type { AiVoiceCommand } from "./ai-intent-schema";
import type { VoiceParseResult, VoiceResultCode } from "./types";

/** ไมค์รอบนี้เปิดขึ้นมาได้อย่างไร */
export type VoiceActivationOrigin = "push_to_talk" | "windows_standby";

/** ข้อเสนอที่รอยืนยันอยู่ได้นานแค่ไหน — สั้นพอที่บริบทบนจอยังเป็นชุดเดิม */
export const STANDBY_PROPOSAL_WINDOW_MS = 8_000;

export type StandbyDecision =
  | { readonly action: "execute"; readonly result: VoiceParseResult }
  | { readonly action: "confirm"; readonly result: VoiceParseResult; readonly expiresAt: number }
  | { readonly action: "block"; readonly reason: VoiceResultCode };

/** intent ที่แตะตะกร้า — ชุดนี้คือสิ่งที่ต้องยืนยันเมื่อมาจากคำปลุก */
const CART_MUTATING_INTENTS = new Set([
  "pos.add_item",
  "pos.set_quantity",
  "pos.increase_item",
  "pos.decrease_item",
  "pos.remove_item",
  "pos.confirm_selection",
]);

/**
 * ตัดสินว่าคำสั่งนี้ทำได้เลย ต้องยืนยันก่อน หรือห้ามทำ
 *
 * ฟังก์ชันบริสุทธิ์ — ไม่แตะตะกร้า ไม่แตะ DOM ผู้เรียกเป็นคนลงมือตามผลเท่านั้น
 */
export function decideStandbyAction(
  result: VoiceParseResult,
  origin: VoiceActivationOrigin,
  now: number,
): StandbyDecision {
  // parser ปฏิเสธมาแล้ว = ปฏิเสธต่อ ไม่ว่ามาจากทางไหน
  if (result.decision === "block") return { action: "block", reason: result.resultCode };

  // preview = ยังขาดข้อมูล/จำนวนไม่ถูกต้อง/ความมั่นใจต่ำ — ห้ามแตะตะกร้าอยู่แล้วเดิม
  if (result.decision === "preview") return { action: "block", reason: result.resultCode };

  // tier C/D ห้ามเสมอ แม้ parser จะปล่อยผ่านมาเป็น execute (กันความไม่ตรงกันของสองชั้น)
  if (result.tier === "C" || result.tier === "D") {
    return { action: "block", reason: result.resultCode === "matched" ? "forbidden_command" : result.resultCode };
  }

  // กดปุ่มเอง = พฤติกรรมเดิมทุกประการ ห้ามเพิ่มขั้นตอนให้คนที่ตั้งใจกด
  if (origin === "push_to_talk") return { action: "execute", result };

  // คำปลุก + คำสั่งที่แตะตะกร้า = ต้องมีคนยืนยันก่อน
  if (CART_MUTATING_INTENTS.has(result.intent.type)) {
    return { action: "confirm", result, expiresAt: now + STANDBY_PROPOSAL_WINDOW_MS };
  }

  // คำปลุก + คำสั่งที่ไม่แตะตะกร้า (เปิดหน้า/ล้างคำค้น/เลือกตัวเลือก) = ทำได้เลย
  return { action: "execute", result };
}

/** ข้อเสนอที่กำลังรอการยืนยัน — อยู่ในหน่วยความจำของหน้าจอเท่านั้น */
export interface StandbyProposal {
  readonly result: VoiceParseResult;
  /**
   * มีค่าเมื่อรอบนั้นเป็นการสั่งหลายเมนูรวดเดียว — ยืนยันครั้งเดียวได้ทั้งชุด
   * (ถามทีละรายการหลังคำปลุกคือการทำลายเหตุผลของฟีเจอร์นี้ ซึ่งมีไว้ให้คนมือไม่ว่าง)
   * ผู้เรียกต้อง resolve ใหม่ตอนยืนยันเสมอ ไม่ใช่เล่นซ้ำผลที่คำนวณไว้ตอนพูด
   */
  readonly commands?: readonly AiVoiceCommand[];
  readonly expiresAt: number;
  /** รอบคำปลุกที่เป็นต้นเรื่อง — ใช้ผูกให้ยืนยันได้เฉพาะรอบเดียวกัน */
  readonly sessionId: string | null;
  /** ป้ายที่ผู้ใช้ต้องเห็นก่อนกดยืนยัน เช่น "เพิ่ม กาแฟเย็น 2" */
  readonly label: string;
}

export function isProposalValid(proposal: StandbyProposal | null, now: number): proposal is StandbyProposal {
  return proposal !== null && proposal.expiresAt > now;
}

/**
 * คำที่นับว่าเป็นการยืนยันด้วยเสียง — <b>allowlist ตรงตัวเท่านั้น</b>
 *
 * ตั้งใจไม่ใช้การเดาความหมาย: ถ้ายอมรับคำใกล้เคียง เสียงพูดคุยทั่วไปในร้าน
 * ("ตกลงว่าจะไปไหนดี") จะกลายเป็นการยืนยันบิลได้
 */
const CONFIRM_PHRASES = new Set(["ยืนยัน", "ตกลง", "ใช่", "เอาเลย", "ยืนยันครับ", "ยืนยันค่ะ", "ตกลงครับ", "ตกลงค่ะ"]);
const CANCEL_PHRASES = new Set(["ยกเลิก", "ไม่ใช่", "ไม่เอา", "ยกเลิกครับ", "ยกเลิกค่ะ"]);

export type StandbyVoiceReply = "confirm" | "cancel" | "none";

/**
 * ตีความคำพูดสั้น ๆ ระหว่างที่มีข้อเสนอค้างอยู่
 * คำอื่นทั้งหมดคือ "none" — ผู้เรียกต้องไม่ทำอะไรกับข้อเสนอ ไม่ใช่ตีความเป็นคำสั่งใหม่
 */
export function readStandbyVoiceReply(transcript: string): StandbyVoiceReply {
  const phrase = transcript.trim().replace(/\s+/g, "");
  if (CONFIRM_PHRASES.has(phrase)) return "confirm";
  if (CANCEL_PHRASES.has(phrase)) return "cancel";
  return "none";
}

/** ป้ายสั้น ๆ ของข้อเสนอ ไม่มีคำพูดดิบของผู้ใช้อยู่ในนั้น */
export function describeProposal(result: VoiceParseResult): string {
  const intent = result.intent;
  switch (intent.type) {
    case "pos.add_item":
      return `เพิ่ม ${intent.productPhrase} ${intent.quantity}`;
    case "pos.set_quantity":
      return `ตั้งจำนวน ${intent.productPhrase} เป็น ${intent.quantity}`;
    case "pos.increase_item":
      return `เพิ่ม ${intent.productPhrase} อีก ${intent.delta}`;
    case "pos.decrease_item":
      return `ลด ${intent.productPhrase} ลง ${intent.delta}`;
    case "pos.remove_item":
      return `เอา ${intent.productPhrase} ออก`;
    case "pos.confirm_selection":
      return "ยืนยันตัวเลือกที่เลือกไว้";
    default:
      return "คำสั่งที่รอการยืนยัน";
  }
}
