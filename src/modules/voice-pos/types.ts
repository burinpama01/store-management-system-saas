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

/** intent ที่อนุญาต (allowlist) — นอกเหนือจากนี้คือ "unknown" เสมอ */
export type VoiceIntentType = "navigate" | "pos.add_item" | "pos.set_quantity" | "unknown";

/** เหตุผลของผลลัพธ์ — ใช้เลือกข้อความ UI และเป็นค่าเดียวที่ log ได้ */
export type VoiceResultCode =
  | "matched"
  | "empty_transcript"
  | "no_match"
  | "forbidden_command"
  | "invalid_quantity"
  | "low_confidence";

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

export interface VoiceUnknownIntent {
  readonly type: "unknown";
}

export type VoiceIntent =
  | VoiceNavigateIntent
  | VoiceAddItemIntent
  | VoiceSetQuantityIntent
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
