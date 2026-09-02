// U13 — Voice foundation (R2) · parser แบบ deterministic ล้วน (ไม่มี AI, ไม่มี network)
// สัญญา: รับ final transcript → คืน allowlisted intent + slots + confidence
//        คำที่ไม่เข้า allowlist ต้องไม่ถูก execute เด็ดขาด
//
// ไฟล์นี้ต้อง pure 100% — ห้าม import React/router/supabase/env

import type {
  VoiceConfidenceBucket,
  VoiceDecision,
  VoiceIntent,
  VoiceParseResult,
  VoiceResultCode,
  VoiceSafetyTier,
} from "./types";

/** จำนวนที่ยอมรับสำหรับคำสั่งตะกร้า — นอกช่วงนี้ห้ามแตะตะกร้า */
export const VOICE_MIN_QUANTITY = 1;
export const VOICE_MAX_QUANTITY = 99;

/** ต่ำกว่านี้ห้าม execute (ลดโอกาสสั่งผิดจากการฟังเพี้ยน) */
const EXECUTE_CONFIDENCE_FLOOR = 0.5;

/**
 * Tier D denylist — คำสั่งที่เสียงห้ามทำแทนผู้ใช้ (เงิน/สต๊อก/สิทธิ์/ข้อมูลลูกค้า)
 * เจอที่ใดก็ตามในประโยค = block ทันที ก่อนพิจารณา pattern อื่น
 */
const FORBIDDEN_PHRASES: readonly string[] = [
  "ชำระ",
  "จ่ายเงิน",
  "รับเงิน",
  "เก็บเงิน",
  "เช็คบิล",
  "ปิดบิล",
  "checkout",
  "payment",
  "pay",
  "ยกเลิก",
  "ลบ",
  "ล้างตะกร้า",
  "เคลียร์",
  "clear",
  "void",
  "คืนเงิน",
  "refund",
  "ส่วนลด",
  "discount",
  "คูปอง",
  "coupon",
  "เปิดกะ",
  "ปิดกะ",
  "ลิ้นชัก",
  "ลูกค้า",
  "สมาชิก",
  "แต้ม",
  "loyalty",
];

/** เลขไทย → อารบิก */
const THAI_DIGITS = "๐๑๒๓๔๕๖๗๘๙";

/** คำจำนวนภาษาไทยที่รองรับ (allowlist — ไม่เดาเกินตาราง) */
const THAI_NUMBER_WORDS: ReadonlyArray<readonly [string, number]> = [
  ["ยี่สิบเอ็ด", 21],
  ["ยี่สิบ", 20],
  ["สิบเอ็ด", 11],
  ["สิบสอง", 12],
  ["สิบสาม", 13],
  ["สิบสี่", 14],
  ["สิบห้า", 15],
  ["สิบหก", 16],
  ["สิบเจ็ด", 17],
  ["สิบแปด", 18],
  ["สิบเก้า", 19],
  ["สามสิบ", 30],
  ["สี่สิบ", 40],
  ["ห้าสิบ", 50],
  ["สิบ", 10],
  ["ศูนย์", 0],
  ["หนึ่ง", 1],
  ["สอง", 2],
  ["สาม", 3],
  ["สี่", 4],
  ["ห้า", 5],
  ["หก", 6],
  ["เจ็ด", 7],
  ["แปด", 8],
  ["เก้า", 9],
];

/** คำลงท้ายสุภาพที่ตัดได้อย่างปลอดภัย (ตัดเฉพาะท้ายประโยค) */
const TRAILING_POLITENESS: readonly string[] = ["นะครับ", "นะคะ", "ครับผม", "ครับ", "ค่ะ", "คะ", "จ้า", "นะ"];

/** หน่วยนับที่ตัดออกได้ท้ายคำสั่ง (ไม่เปลี่ยนความหมาย) */
const TRAILING_UNITS: readonly string[] = ["ชิ้น", "อัน", "แก้ว", "จาน", "ที่", "ขวด", "ถ้วย", "กล่อง"];

/** หน่วยนับสำหรับ regex — ผูกกับ TRAILING_UNITS ตัวเดียว ไม่ให้ drift */
const UNIT_ALTERNATION = TRAILING_UNITS.join("|");

const NUMBER_WORD_ALTERNATION = THAI_NUMBER_WORDS.map(([word]) => word).join("|");

/**
 * แปลงคำจำนวนไทยเป็นตัวเลข "เฉพาะตำแหน่งที่เป็นจำนวนจริง" เท่านั้น คือ
 *   1) ท้ายประโยค เช่น "เพิ่มลาเต้สอง"
 *   2) ท้ายประโยคตามด้วยหน่วยนับ เช่น "เพิ่มลาเต้สองแก้ว"
 *   3) ตามหลัง "เป็น" เช่น "ตั้งจำนวนลาเต้เป็นสาม"
 * เจตนา: ห้ามแปลงคำที่อยู่กลางชื่อสินค้า (เช่น "หมูสามชั้น" ต้องไม่กลายเป็น "หมู 3 ชั้น")
 */
function convertThaiNumberWords(text: string): string {
  const lookup = new Map<string, number>(THAI_NUMBER_WORDS.map(([w, v]) => [w, v]));
  let out = text;
  out = out.replace(
    new RegExp(`(${NUMBER_WORD_ALTERNATION})\s*(${UNIT_ALTERNATION})?$`),
    (match, word: string, unit: string | undefined) => {
      const value = lookup.get(word);
      if (value === undefined) return match;
      return unit ? ` ${value} ${unit}` : ` ${value}`;
    },
  );
  out = out.replace(new RegExp(`เป็น\s*(${NUMBER_WORD_ALTERNATION})`), (match, word: string) => {
    const value = lookup.get(word);
    return value === undefined ? match : `เป็น ${value}`;
  });
  return out;
}

/**
 * normalize transcript ก่อน parse — deterministic ล้วน
 * trim → lowercase → เลขไทยเป็นอารบิก → คำจำนวน (เฉพาะตำแหน่งจำนวน) → ตัดคำลงท้าย → collapse whitespace
 * ⚠️ ผลลัพธ์เป็นข้อมูลชั่วคราวในหน่วยความจำ ห้าม log/ส่งออก
 */
export function normalizeThaiTranscript(raw: string): string {
  let text = (raw ?? "").normalize("NFC").trim().toLowerCase();
  if (!text) return "";

  // เลขไทย → อารบิก
  text = text.replace(/[๐-๙]/g, (ch) => String(THAI_DIGITS.indexOf(ch)));

  // ตัดคำลงท้ายสุภาพก่อน เพื่อให้คำจำนวนกลับมาอยู่ท้ายประโยคจริง
  text = stripTrailingPoliteness(text.replace(/\s+/g, " ").trim());

  text = convertThaiNumberWords(text);

  return stripTrailingPoliteness(text.replace(/\s+/g, " ").trim());
}

function stripTrailingPoliteness(input: string): string {
  let text = input;
  let trimmed = true;
  while (trimmed) {
    trimmed = false;
    for (const word of TRAILING_POLITENESS) {
      if (text.endsWith(word)) {
        text = text.slice(0, -word.length).trim();
        trimmed = true;
      }
    }
  }
  return text;
}

function bucketOf(confidence: number): VoiceConfidenceBucket {
  if (confidence >= 0.8) return "high";
  if (confidence >= EXECUTE_CONFIDENCE_FLOOR) return "medium";
  return "low";
}

function result(
  intent: VoiceIntent,
  tier: VoiceSafetyTier,
  decision: VoiceDecision,
  confidence: number,
  resultCode: VoiceResultCode,
): VoiceParseResult {
  const bounded = Math.max(0, Math.min(1, confidence));
  const bucket = bucketOf(bounded);
  // ความมั่นใจต่ำ = ไม่ execute แต่ยังให้ผู้ใช้ยืนยันเองบนจอได้
  if (decision === "execute" && bucket === "low") {
    return { intent, tier, decision: "preview", confidence: bounded, confidenceBucket: bucket, resultCode: "low_confidence" };
  }
  return { intent, tier, decision, confidence: bounded, confidenceBucket: bucket, resultCode };
}

function stripTrailingUnit(phrase: string): string {
  let out = phrase.trim();
  for (const unit of TRAILING_UNITS) {
    if (out.endsWith(unit)) {
      out = out.slice(0, -unit.length).trim();
      break;
    }
  }
  return out;
}

function parseQuantity(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  if (!/^\d+$/.test(raw)) return null;
  return Number.parseInt(raw, 10);
}

function isQuantityInRange(quantity: number): boolean {
  return Number.isInteger(quantity) && quantity >= VOICE_MIN_QUANTITY && quantity <= VOICE_MAX_QUANTITY;
}

export interface ParseVoiceCommandOptions {
  /** ค่าความมั่นใจจาก speech engine (0..1) — ไม่ส่งมา = ถือว่าเชื่อได้เท่า pattern */
  readonly recognitionConfidence?: number | null;
}

const UNKNOWN: VoiceIntent = { type: "unknown" };

/**
 * แปลง final transcript → intent ใน allowlist
 * ลำดับสำคัญ: denylist (Tier D) → ตะกร้า (Tier B) → นำทาง (Tier A) → unknown
 */
export function parseVoiceCommand(
  rawTranscript: string,
  options: ParseVoiceCommandOptions = {},
): VoiceParseResult {
  const engine =
    options.recognitionConfidence === null || options.recognitionConfidence === undefined
      ? 1
      : Math.max(0, Math.min(1, options.recognitionConfidence));

  const text = normalizeThaiTranscript(rawTranscript);
  if (!text) return result(UNKNOWN, "C", "block", 0, "empty_transcript");

  // Tier D — คำสั่งต้องห้าม ตัดจบก่อนเสมอ
  if (FORBIDDEN_PHRASES.some((phrase) => text.includes(phrase))) {
    return result(UNKNOWN, "D", "block", 1 * engine, "forbidden_command");
  }

  // Tier B — "ตั้งจำนวน <สินค้า> เป็น <จำนวน>"
  const setQuantity = /^(?:ตั้งจำนวน|ตั้ง จำนวน|เปลี่ยนจำนวน|แก้จำนวน)\s*(.+?)\s*(?:เป็น|=)\s*(\d+)(?:\s*\S+)?$/.exec(text);
  if (setQuantity) {
    const productPhrase = stripTrailingUnit(setQuantity[1]);
    const quantity = parseQuantity(setQuantity[2]);
    if (!productPhrase) return result(UNKNOWN, "C", "block", 0.5 * engine, "no_match");
    if (quantity === null || !isQuantityInRange(quantity)) {
      return result(UNKNOWN, "C", "preview", 0.9 * engine, "invalid_quantity");
    }
    return result({ type: "pos.set_quantity", productPhrase, quantity }, "B", "execute", 0.95 * engine, "matched");
  }

  // Tier B — "เพิ่ม <สินค้า> [จำนวน] [หน่วยนับ]" (ไม่ระบุจำนวน = 1)
  const addItem = /^(?:เพิ่ม|ใส่|สั่ง)\s*(.+)$/.exec(text);
  if (addItem) {
    const rest = addItem[1].trim();
    if (!rest) return result(UNKNOWN, "C", "block", 0.5 * engine, "no_match");

    // แยก "จำนวน + หน่วยนับ" ที่ท้ายประโยคออกจากชื่อสินค้า
    // หน่วยนับรับได้ทั้งที่อยู่ใน allowlist และคำสั้นทั่วไป (เช่น "กระป๋อง") — ตัดทิ้งเหมือนกัน
    const tail = /^(.*?)\s*(\d+)\s*([^\d\s]{1,8})?$/.exec(rest);
    const productPhrase = stripTrailingUnit(tail ? tail[1] : rest);
    const parsed = tail ? parseQuantity(tail[2]) : null;
    if (!productPhrase) return result(UNKNOWN, "C", "block", 0.5 * engine, "no_match");
    if (tail && (parsed === null || !isQuantityInRange(parsed))) {
      return result(UNKNOWN, "C", "preview", 0.9 * engine, "invalid_quantity");
    }
    const quantity = parsed ?? 1;
    return result({ type: "pos.add_item", productPhrase, quantity }, "B", "execute", 0.9 * engine, "matched");
  }

  // Tier A — "เปิด/ไปที่/ไป/แสดง <หน้า>" (U14 จะจับคู่กับ visible command list เท่านั้น)
  const navigate = /^(?:เปิดหน้า|ไปที่หน้า|ไปหน้า|เปิด|ไปที่|ไป|แสดง)\s*(.+)$/.exec(text);
  if (navigate) {
    const query = navigate[1].trim();
    if (!query) return result(UNKNOWN, "C", "block", 0.5 * engine, "no_match");
    return result({ type: "navigate", query }, "A", "execute", 0.9 * engine, "matched");
  }

  return result(UNKNOWN, "C", "block", 0, "no_match");
}
