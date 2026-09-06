// กฎความปลอดภัยที่ขึ้นกับ "ที่มาของการเปิดไมค์"
//
// ── ประวัติที่ต้องรู้ก่อนแก้ไฟล์นี้ ─────────────────────────────────────────────
// รอบแรก (W6) คำสั่งที่แตะตะกร้าและมาจากคำปลุก ต้องมีคนยืนยันก่อนเสมอ (การ์ด 8 วินาที)
// เหตุผลตอนนั้นคือ engine คำปลุกเดิม (System.Speech) ปลุกเองรัว ๆ — วัดได้ 14-20 ครั้ง
// ต่อ 4 นาทีโดยไม่มีใครพูดคำปลุกเลย เสียงคุยในร้านจึงกลายเป็นคำสั่งขึ้นบิลได้จริง
//
// สองอย่างเปลี่ยนไปแล้ว:
//   1) เปลี่ยน engine เป็น Vosk — วัดด้วยไมค์จริงในห้องจริงชุดละ 4 นาที ปลุกผิด 0 ครั้ง
//      สมมติฐานที่ทำให้ต้องมีการยืนยัน ("ไมค์เปิดเองโดยไม่มีใครตั้งใจ") จึงอ่อนลงมาก
//   2) หน้างานจริงใช้ไม่ได้: ระบบพูดข้อเสนอออกลำโพงก่อน แล้วค่อยเปิดไมค์ให้ตอบ
//      แต่นาฬิกา 8 วินาทีเริ่มเดินตั้งแต่ตอนสร้างข้อเสนอ — พอระบบพูดจบ เวลาก็เกือบหมด
//      คนที่มือไม่ว่างจึงยืนยันไม่ทันแทบทุกครั้ง
//
// ตอนนี้จึงตัดการยืนยันออก: คำปลุกลงมือได้ทันทีเหมือนกดปุ่มเอง
// สิ่งที่มาแทนคือ **การย้อนกลับ** ซึ่งใช้ได้ทั้งปุ่มบนจอและด้วยเสียง และหน้าต่างเวลา
// เริ่มนับใหม่ตอนไมค์เปิดอีกครั้ง (ดู refreshVoiceUndoToken) — แก้ที่ต้นเหตุของ
// ปัญหาข้อ 2 คือ "นาฬิกาเดินระหว่างที่ระบบยังพูดอยู่"
//
// กติกาที่ยังล็อกไว้เหมือนเดิม:
//   * tier C/D — ห้ามทั้งสองที่มา (เงิน/ส่วนลด/สต๊อก/สิทธิ์/ข้อมูลลูกค้า)
//   * parser ปฏิเสธมาแล้ว (block/preview) = ปฏิเสธต่อ ไม่ว่ามาจากทางไหน

import type { VoiceParseResult, VoiceResultCode } from "./types";

/** ไมค์รอบนี้เปิดขึ้นมาได้อย่างไร */
export type VoiceActivationOrigin = "push_to_talk" | "windows_standby";

export type StandbyDecision =
  | { readonly action: "execute"; readonly result: VoiceParseResult }
  | { readonly action: "block"; readonly reason: VoiceResultCode };

/**
 * ตัดสินว่าคำสั่งนี้ทำได้ หรือห้ามทำ
 *
 * ฟังก์ชันบริสุทธิ์ — ไม่แตะตะกร้า ไม่แตะ DOM ผู้เรียกเป็นคนลงมือตามผลเท่านั้น
 * ที่มาของไมค์ไม่เปลี่ยนคำตอบอีกต่อไป แต่ยังรับเป็นพารามิเตอร์ไว้ เพราะเป็นข้อมูล
 * ที่ผู้เรียกใช้ตัดสินเรื่องอื่นต่อ (เช่น จะเปิดไมค์ฟังต่อหรือไม่)
 */
export function decideStandbyAction(
  result: VoiceParseResult,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- ยังรับไว้เพื่อบังคับให้ผู้เรียกคิดถึงที่มาของไมค์
  origin: VoiceActivationOrigin,
): StandbyDecision {
  // parser ปฏิเสธมาแล้ว = ปฏิเสธต่อ
  if (result.decision === "block") return { action: "block", reason: result.resultCode };

  // preview = ยังขาดข้อมูล/จำนวนไม่ถูกต้อง/ความมั่นใจต่ำ — ห้ามแตะตะกร้า
  if (result.decision === "preview") return { action: "block", reason: result.resultCode };

  // tier C/D ห้ามเสมอ แม้ parser จะปล่อยผ่านมาเป็น execute (กันความไม่ตรงกันของสองชั้น)
  if (result.tier === "C" || result.tier === "D") {
    return { action: "block", reason: result.resultCode === "matched" ? "forbidden_command" : result.resultCode };
  }

  return { action: "execute", result };
}

export type VoiceUndoReply = "undo" | "none";

/**
 * คำที่นับว่าเป็นการสั่งย้อนกลับด้วยเสียง — <b>allowlist ตรงตัวเท่านั้น</b>
 *
 * ตั้งใจไม่ใช้การเดาความหมาย: ถ้ายอมรับคำใกล้เคียง บทสนทนาทั่วไปในร้าน
 * ("ยกเลิกโต๊ะ 3 ให้หน่อย") จะย้อนตะกร้าของอีกคนได้
 *
 * หมายเหตุ: "ยกเลิก" อยู่ใน denylist ของ parser (tier D) จึงไม่มีทางกลายเป็นคำสั่งอื่น
 * ผู้เรียกต้องอ่านคำตอบนี้ "ก่อน" ใช้ผลของ parser เสมอ
 */
const UNDO_PHRASES = new Set([
  "ยกเลิก",
  "ยกเลิกครับ",
  "ยกเลิกค่ะ",
  "ย้อนกลับ",
  "ย้อน",
  "ไม่เอา",
  "ไม่ใช่",
  "เอาคืน",
]);

/**
 * ตีความคำพูดสั้น ๆ ระหว่างที่ยังย้อนกลับได้
 * คำอื่นทั้งหมดคือ "none" — ผู้เรียกต้องปล่อยให้ไหลไปเป็นคำสั่งใหม่ตามปกติ
 */
export function readVoiceUndoReply(transcript: string): VoiceUndoReply {
  const phrase = transcript.trim().replace(/\s+/g, "");
  return UNDO_PHRASES.has(phrase) ? "undo" : "none";
}
