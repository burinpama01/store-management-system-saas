// U13 — Voice foundation (R2) · สัญญาชนิดข้อมูลกลางของ voice POS
// ห้าม import React / server-only module ที่ไฟล์นี้ — ใช้ร่วมกันทั้ง adapter, parser และ UI
//
// หลักที่ล็อกไว้ (แผน v2 · Voice privacy):
//   เก็บได้: intent_type, result_code, locale, confidence_bucket, time
//   ห้ามเก็บ: audio, raw transcript, normalized phrase, voiceprint

/** สถานะของ 1 รอบ push-to-talk (มีได้ครั้งละ 1 session เท่านั้น) */
export type VoiceRecognitionState =
  | "idle"
  | "requesting"
  | "listening"
  | "resolving"
  | "success"
  | "error";

/** สาเหตุความล้มเหลวที่กู้คืนได้ — เป็น enum ล้วน (ปลอดภัยต่อ log) */
export type VoiceErrorCode =
  | "unsupported_browser"
  | "permission_denied"
  | "no_speech"
  | "network"
  | "aborted"
  | "timeout"
  | "service_error";

/**
 * Safety tier ตามแผน:
 *   A = navigate (เปิดหน้าที่มองเห็นได้อยู่แล้ว)
 *   B = แก้ตะกร้าแบบย้อนกลับได้ (add/set quantity)
 *   C = ต้องการข้อมูลเพิ่ม/ข้อมูลไม่ถูกต้อง — ห้ามแตะตะกร้า
 *   D = คำสั่งต้องห้าม (เงิน/สต๊อก/สิทธิ์/ข้อมูลลูกค้า) — block เสมอ
 */
export type VoiceSafetyTier = "A" | "B" | "C" | "D";

/** ผลตัดสินของ safety policy — UI ห้ามลงมือทำเมื่อไม่ใช่ "execute" */
export type VoiceDecision = "execute" | "preview" | "block";

/** bucket ของความมั่นใจ — telemetry เก็บได้แค่ระดับนี้ ห้ามเก็บค่า raw ต่อคำสั่ง */
export type VoiceConfidenceBucket = "low" | "medium" | "high";

/** ค่าที่อนุญาตแบบ runtime — server ใช้ตรวจก่อนบันทึก telemetry (fail closed) */
export const VOICE_CONFIDENCE_BUCKETS = ["low", "medium", "high"] as const;

/** intent ที่อนุญาต (allowlist) — นอกเหนือจากนี้คือ "unknown" เสมอ */
export type VoiceIntentType =
  | "navigate"
  | "pos.add_item"
  | "pos.set_quantity"
  | "pos.increase_item"
  | "pos.decrease_item"
  | "pos.remove_item"
  | "pos.clear_search"
  | "pos.choose_option"
  | "pos.change_option"
  | "pos.confirm_selection"
  | "unknown";

export const VOICE_INTENT_TYPES = [
  "navigate",
  "pos.add_item",
  "pos.set_quantity",
  "pos.increase_item",
  "pos.decrease_item",
  "pos.remove_item",
  "pos.clear_search",
  "pos.choose_option",
  "pos.change_option",
  "pos.confirm_selection",
  "unknown",
] as const;

/** เหตุผลของผลลัพธ์ — ใช้เลือกข้อความ UI และเป็นค่าเดียวที่ log ได้ */
export type VoiceResultCode =
  | "matched"
  | "empty_transcript"
  | "no_match"
  | "forbidden_command"
  | "invalid_quantity"
  | "low_confidence";

export const VOICE_RESULT_CODES = [
  "matched",
  "empty_transcript",
  "no_match",
  "forbidden_command",
  "invalid_quantity",
  "low_confidence",
] as const;

export interface VoiceNavigateIntent {
  readonly type: "navigate";
  /** ข้อความค้นหาหน้า — U14 จะ resolve กับ visible command list เท่านั้น */
  readonly query: string;
}

export interface VoiceAddItemIntent {
  readonly type: "pos.add_item";
  readonly productPhrase: string;
  readonly quantity: number;
}

export interface VoiceSetQuantityIntent {
  readonly type: "pos.set_quantity";
  readonly productPhrase: string;
  readonly quantity: number;
}

/** U15 — เพิ่ม/ลดจำนวนจากของเดิมในตะกร้า (ย้อนกลับได้ด้วย Undo 6 วินาที) */
export interface VoiceIncreaseItemIntent {
  readonly type: "pos.increase_item";
  readonly productPhrase: string;
  readonly delta: number;
}

export interface VoiceDecreaseItemIntent {
  readonly type: "pos.decrease_item";
  readonly productPhrase: string;
  readonly delta: number;
}

/** U15 — เอารายการออกจากตะกร้า (local เท่านั้น ยังไม่แตะ order/สต๊อก) */
export interface VoiceRemoveItemIntent {
  readonly type: "pos.remove_item";
  readonly productPhrase: string;
}

/** U15 — ล้างคำค้นหาในหน้าขาย (ไม่ใช่ล้างตะกร้า ซึ่งยังต้องห้าม) */
export interface VoiceClearSearchIntent {
  readonly type: "pos.clear_search";
}

/**
 * U21 — เลือกตัวเลือกของสินค้าด้วยเสียง (ตอน dialog ตัวเลือกเปิดอยู่)
 * เช่น "เลือกเล็ก" / "เอาหวานน้อย" — ผู้เรียกเป็นคนจับคู่กับตัวเลือกจริงบนจอ
 */
export interface VoiceChooseOptionIntent {
  readonly type: "pos.choose_option";
  readonly optionPhrase: string;
}

/**
 * แก้ตัวเลือกของรายการที่ "อยู่ในตะกร้าแล้ว" ("เปลี่ยนลาเต้เป็นหวานน้อย")
 *
 * ต่างจาก pos.choose_option ตรงที่อันนั้นใช้ตอน dialog เลือกตัวเลือกเปิดอยู่ระหว่างเพิ่มของ
 * ส่วนอันนี้คือกลับไปแก้บรรทัดที่ขึ้นตะกร้าไปแล้ว ซึ่งเดิมทำด้วยเสียงไม่ได้เลย
 * ต้องเอามือแตะจอ — ขัดกับเหตุผลของฟีเจอร์ที่มีไว้ให้คนมือไม่ว่าง
 */
export interface VoiceChangeOptionIntent {
  readonly type: "pos.change_option";
  readonly productPhrase: string;
  readonly optionPhrase: string;
}

/** U21 — ยืนยันเพิ่มลงตะกร้าหลังเลือกตัวเลือกครบ ("ยืนยัน" / "ตกลง") */
export interface VoiceConfirmSelectionIntent {
  readonly type: "pos.confirm_selection";
}

export interface VoiceUnknownIntent {
  readonly type: "unknown";
}

export type VoiceIntent =
  | VoiceNavigateIntent
  | VoiceAddItemIntent
  | VoiceSetQuantityIntent
  | VoiceIncreaseItemIntent
  | VoiceDecreaseItemIntent
  | VoiceRemoveItemIntent
  | VoiceClearSearchIntent
  | VoiceChooseOptionIntent
  | VoiceChangeOptionIntent
  | VoiceConfirmSelectionIntent
  | VoiceUnknownIntent;

/** ผลของ parser — pure ทั้งหมด ไม่มี side effect และไม่แนบ transcript กลับมา */
export interface VoiceParseResult {
  readonly intent: VoiceIntent;
  readonly tier: VoiceSafetyTier;
  readonly decision: VoiceDecision;
  /** 0..1 — ใช้ภายในรอบเดียว ห้ามส่งเข้า telemetry เป็นค่า raw */
  readonly confidence: number;
  readonly confidenceBucket: VoiceConfidenceBucket;
  readonly resultCode: VoiceResultCode;
}

/**
 * เหตุการณ์เดียวที่อนุญาตให้บันทึก/ส่งออกได้ — ไม่มี transcript, ไม่มีชื่อสินค้า
 * (privacy contract ของแผน v2; U16 จะต่อ purge 30 วัน)
 */
export interface VoiceTelemetryEvent {
  readonly intentType: VoiceIntentType;
  readonly resultCode: VoiceResultCode;
  readonly locale: string;
  readonly confidenceBucket: VoiceConfidenceBucket;
  readonly at: string;
}

/** ตัวช่วยเดียวที่ควรใช้สร้าง telemetry — ตัดฟิลด์ต้องห้ามออกโดยโครงสร้าง */
export function buildVoiceTelemetry(
  result: VoiceParseResult,
  locale: string,
  at: Date = new Date(),
): VoiceTelemetryEvent {
  return {
    intentType: result.intent.type,
    resultCode: result.resultCode,
    locale,
    confidenceBucket: result.confidenceBucket,
    at: at.toISOString(),
  };
}
