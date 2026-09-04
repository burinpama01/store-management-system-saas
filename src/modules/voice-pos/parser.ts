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
  // U15 — "ลบ" ย้ายออกจาก denylist: ลบรายการในตะกร้าเป็น local + ย้อนกลับได้ด้วย Undo 6 วินาที
  // (ล้างตะกร้าทั้งใบยังห้าม เพราะย้อนกลับทีละรายการไม่ได้และเสี่ยงกว่ามาก)
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

/**
 * U21 — คำเติมรอบชื่อสินค้าที่ตัดทิ้งได้ (แต่ละร้านพูดไม่เหมือนกัน)
 *   นำหน้า: "เพิ่ม[เมนู]ลาเต้"
 *   ต่อท้าย: "เพิ่มลาเต้[ลงตะกร้า|ลงออเดอร์|เข้าบิล]"
 * "ตะกร้า" กับ "ออเดอร์/ออร์เดอร์" ถือเป็นคำเดียวกันทั้งระบบ
 */
const PRODUCT_LEAD_FILLERS: readonly string[] = ["เมนู", "รายการ", "สินค้า"];

const PRODUCT_TAIL_FILLERS: readonly string[] = [
  "ลงตะกร้า",
  "ใส่ตะกร้า",
  "เข้าตะกร้า",
  "ในตะกร้า",
  "ลงออเดอร์",
  "ลงออร์เดอร์",
  "ใส่ออเดอร์",
  "ใส่ออร์เดอร์",
  "เข้าออเดอร์",
  "เข้าออร์เดอร์",
  "ในออเดอร์",
  "ในออร์เดอร์",
  "ลงบิล",
  "เข้าบิล",
];

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

/**
 * ตัดคำเติมรอบชื่อสินค้าออก — วนซ้ำจนไม่เหลือ (deterministic ไม่เดา)
 * ทำก่อนตัดหน่วยนับเสมอ เพราะ "ลงตะกร้า" อาจตามหลังหน่วยนับ ("2 แก้วลงตะกร้า")
 */
export function stripProductFillers(phrase: string): string {
  let out = phrase.trim();
  let changed = true;
  while (changed) {
    changed = false;
    for (const lead of PRODUCT_LEAD_FILLERS) {
      if (out.startsWith(lead) && out.length > lead.length) {
        out = out.slice(lead.length).trim();
        changed = true;
      }
    }
    for (const tail of PRODUCT_TAIL_FILLERS) {
      if (out.endsWith(tail) && out.length > tail.length) {
        out = out.slice(0, -tail.length).trim();
        changed = true;
      }
    }
  }
  return out;
}

function stripTrailingUnit(phrase: string): string {
  let out = stripProductFillers(phrase);
  for (const unit of TRAILING_UNITS) {
    if (out.endsWith(unit)) {
      out = out.slice(0, -unit.length).trim();
      break;
    }
  }
  return stripProductFillers(out);
}

function parseQuantity(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  if (!/^\d+$/.test(raw)) return null;
  return Number.parseInt(raw, 10);
}

function isQuantityInRange(quantity: number): boolean {
  return Number.isInteger(quantity) && quantity >= VOICE_MIN_QUANTITY && quantity <= VOICE_MAX_QUANTITY;
}

/**
 * Tier D — เจอคำต้องห้ามที่ใดก็ตามในข้อความ = block
 * export ไว้เพราะ P5 ต้องรันด่านนี้ "สองรอบ": ก่อนส่งคำพูดให้ AI และหลังได้คำตอบกลับมา
 * (วลีที่ AI เสนอกลับมาต้องผ่านด่านเดียวกัน — AI ไม่มีสิทธิ์ override)
 * รับได้ทั้งข้อความดิบและข้อความที่ normalize แล้ว
 */
export function containsForbiddenVoicePhrase(value: string): boolean {
  const text = normalizeThaiTranscript(value);
  if (!text) return false;
  return FORBIDDEN_PHRASES.some((phrase) => text.includes(phrase));
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
  if (containsForbiddenVoicePhrase(text)) {
    return result(UNKNOWN, "D", "block", 1 * engine, "forbidden_command");
  }

  // Tier B (U21) — ยืนยันตัวเลือกที่เลือกไว้ใน dialog ("ยืนยัน"/"ตกลง")
  if (/^(?:ยืนยัน|ตกลง|โอเค|ok|เพิ่มเลย|ใช่)$/.test(text)) {
    return result({ type: "pos.confirm_selection" }, "B", "execute", 0.95 * engine, "matched");
  }

  // Tier B (U21) — เลือกตัวเลือกของสินค้า ("เลือกเล็ก" / "ขอหวานน้อย")
  // ต้องมาก่อน "เอา...ออก" ไม่ได้ เพราะ remove ใช้รูป "เอา X ออก" — จึงกันด้วยการเช็ค "ออก" ท้ายประโยค
  const chooseOption = /^(?:เลือก|ขอ|เอา)\s*(.+)$/.exec(text);
  if (chooseOption && !/ออก$/.test(text)) {
    const optionPhrase = stripProductFillers(chooseOption[1]);
    if (optionPhrase) {
      return result({ type: "pos.choose_option", optionPhrase }, "B", "execute", 0.9 * engine, "matched");
    }
  }

  // Tier B (U15) — "ล้างการค้นหา" (ไม่ใช่ล้างตะกร้า ซึ่งยังต้องห้าม)
  if (/^(?:ล้าง|ลบ)\s*(?:การค้นหา|คำค้นหา|คำค้น|ค้นหา)$/.test(text)) {
    return result({ type: "pos.clear_search" }, "B", "execute", 0.95 * engine, "matched");
  }

  // Tier B (U15) — "เพิ่มอีก <จำนวน> <สินค้า>" / "<สินค้า> อีก <จำนวน>"
  const increase =
    /^(?:เพิ่มอีก|อีก)\s*(\d+)?\s*(.+)$/.exec(text) ?? /^(.+?)\s*อีก\s*(\d+)?$/.exec(text);
  if (increase && /อีก/.test(text)) {
    const isPrefixForm = /^(?:เพิ่มอีก|อีก)/.test(text);
    const rawPhrase = isPrefixForm ? increase[2] : increase[1];
    const rawDelta = isPrefixForm ? increase[1] : increase[2];
    const productPhrase = stripTrailingUnit((rawPhrase ?? "").trim());
    const parsedDelta = parseQuantity(rawDelta);
    if (!productPhrase) return result(UNKNOWN, "C", "block", 0.5 * engine, "no_match");
    if (rawDelta !== undefined && (parsedDelta === null || !isQuantityInRange(parsedDelta))) {
      return result(UNKNOWN, "C", "preview", 0.9 * engine, "invalid_quantity");
    }
    return result(
      { type: "pos.increase_item", productPhrase, delta: parsedDelta ?? 1 },
      "B",
      "execute",
      0.9 * engine,
      "matched",
    );
  }

  // Tier B (U15) — "ลด <สินค้า> [จำนวน]"
  const decrease = /^(?:ลด|ลดจำนวน|เอาออก)\s*(.+)$/.exec(text);
  if (decrease) {
    const rest = stripProductFillers(decrease[1]);
    const tail = /^(.*?)\s*(\d+)\s*([^\d\s%]{1,8})?$/.exec(rest);
    const productPhrase = stripTrailingUnit(tail ? tail[1] : rest);
    const parsedDelta = tail ? parseQuantity(tail[2]) : null;
    if (!productPhrase) return result(UNKNOWN, "C", "block", 0.5 * engine, "no_match");
    if (tail && (parsedDelta === null || !isQuantityInRange(parsedDelta))) {
      return result(UNKNOWN, "C", "preview", 0.9 * engine, "invalid_quantity");
    }
    return result(
      { type: "pos.decrease_item", productPhrase, delta: parsedDelta ?? 1 },
      "B",
      "execute",
      0.9 * engine,
      "matched",
    );
  }

  // Tier B (U15) — "ลบ <สินค้า>" / "เอา <สินค้า> ออก"
  const removeSuffix = /^(?:เอา|เอารายการ)\s*(.+?)\s*ออก$/.exec(text);
  const removePrefix = /^(?:ลบ|ลบรายการ|ตัด)\s*(.+)$/.exec(text);
  const removeMatch = removeSuffix ?? removePrefix;
  if (removeMatch) {
    const productPhrase = stripTrailingUnit(removeMatch[1].trim());
    if (!productPhrase) return result(UNKNOWN, "C", "block", 0.5 * engine, "no_match");
    return result({ type: "pos.remove_item", productPhrase }, "B", "execute", 0.9 * engine, "matched");
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
    // ตัดคำเติม ("เมนู…", "…ลงออเดอร์") ออกก่อนแยกจำนวน ไม่งั้นคำต่อท้ายจะบังตัวเลข
    const rest = stripProductFillers(addItem[1]);
    if (!rest) return result(UNKNOWN, "C", "block", 0.5 * engine, "no_match");

    // แยก "จำนวน + หน่วยนับ" ที่ท้ายประโยคออกจากชื่อสินค้า
    // U21: กันเลขที่เป็นส่วนหนึ่งของ "ชื่อตัวเลือก" เช่น "หวาน 0%" ไม่ให้ถูกอ่านเป็นจำนวน
    // หน่วยนับรับได้ทั้งที่อยู่ใน allowlist และคำสั้นทั่วไป (เช่น "กระป๋อง") — ตัดทิ้งเหมือนกัน
    const tail = /^(.*?)\s*(\d+)\s*([^\d\s%]{1,8})?$/.exec(rest);
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

/** หลักหน่วยของเลขไทย (ใช้ประกอบเลขหลักสิบ/ร้อย) */
const THAI_UNIT_DIGITS: ReadonlyArray<readonly [string, number]> = [
  ["ศูนย์", 0],
  ["เอ็ด", 1],
  ["หนึ่ง", 1],
  ["สอง", 2],
  ["ยี่", 2],
  ["สาม", 3],
  ["สี่", 4],
  ["ห้า", 5],
  ["หก", 6],
  ["เจ็ด", 7],
  ["แปด", 8],
  ["เก้า", 9],
];

function readThaiUnit(text: string): { value: number; rest: string } | null {
  for (const [word, value] of THAI_UNIT_DIGITS) {
    if (text.startsWith(word)) return { value, rest: text.slice(word.length) };
  }
  return null;
}

/**
 * อ่านเลขไทยแบบประกอบคำ 0–999 จาก "ต้นข้อความ" คืนค่าและส่วนที่เหลือ
 *
 * ต้องประกอบจริง ไม่ใช่แทนที่คำทีละคำ — วิธีแทนที่ทีละคำทำให้ "ยี่สิบห้า" กลายเป็น
 * "205" (แทน "ยี่สิบ"→20 แล้ว "ห้า"→5 ต่อท้าย) ซึ่งพาไปเลือกตัวเลือกผิดเงียบ ๆ
 */
function readThaiNumber(text: string): { value: number; rest: string } | null {
  let rest = text;
  let total = 0;
  let matched = false;

  const hundredIndex = rest.indexOf("ร้อย");
  if (hundredIndex >= 0 && hundredIndex <= 6) {
    const head = rest.slice(0, hundredIndex);
    const digit = head ? readThaiUnit(head) : null;
    // "ร้อย" ลอย ๆ = 100 ("หนึ่งร้อย" ก็ได้เหมือนกัน)
    if (!head || (digit && digit.rest === "")) {
      total += (digit?.value ?? 1) * 100;
      rest = rest.slice(hundredIndex + "ร้อย".length);
      matched = true;
    }
  }

  const tenIndex = rest.indexOf("สิบ");
  if (tenIndex >= 0 && tenIndex <= 4) {
    const head = rest.slice(0, tenIndex);
    const digit = head ? readThaiUnit(head) : null;
    if (!head || (digit && digit.rest === "")) {
      total += (digit?.value ?? 1) * 10;
      rest = rest.slice(tenIndex + "สิบ".length);
      matched = true;
    }
  }

  const unit = readThaiUnit(rest);
  if (unit) {
    total += unit.value;
    rest = unit.rest;
    matched = true;
  }

  return matched ? { value: total, rest } : null;
}

/** แปลงคำจำนวนไทยที่ประกอบกันเป็นตัวเลขทั้งข้อความ (ใช้กับวลีสั้น ๆ ของตัวเลือกเท่านั้น) */
function convertThaiNumbersInPhrase(text: string): string {
  let out = "";
  let rest = text;
  while (rest.length > 0) {
    const read = readThaiNumber(rest);
    if (read && read.rest !== rest) {
      out += String(read.value);
      rest = read.rest;
      continue;
    }
    out += rest[0];
    rest = rest.slice(1);
  }
  return out;
}

/**
 * ทำให้ชื่อตัวเลือกกับคำที่พูด "เทียบกันได้" — ใช้ทั้งสองฝั่งของการจับคู่
 *
 * เจตนา: แคชเชียร์ต้องเปลี่ยนทับค่าเริ่มต้นด้วยเสียงได้ เช่น ความหวานตั้งไว้ 100%
 * แล้วพูด "เลือกศูนย์เปอร์เซ็นต์" ต้องได้ 0% — เดิมเทียบสตริงตรง ๆ จึงไม่ตรงเลย
 * เพราะเสียงให้คำว่า "เปอร์เซ็นต์" ส่วนชื่อตัวเลือกเป็นสัญลักษณ์ "%"
 *
 * แปลง: เลขไทย → อารบิก, คำจำนวนไทยแบบประกอบ → ตัวเลข, คำว่าเปอร์เซ็นต์ทุกแบบ → "%"
 * แล้วตัดช่องว่าง/วงเล็บทิ้ง (ตัวเลือกที่มีวงเล็บกำกับราคาไม่ควรทำให้จับคู่พลาด)
 */
export function normalizeVoiceChoicePhrase(value: string): string {
  let text = value.trim().toLowerCase();
  text = text.replace(/[๐-๙]/g, (ch) => String(THAI_DIGITS.indexOf(ch)));
  text = text.replace(/เปอร์เซ็นต์|เปอร์เซ็น|เปอร์เซนต์|เปอร์เซน|percent|pct/g, "%");
  text = convertThaiNumbersInPhrase(text);
  return text.replace(/[()\s]/g, "");
}

/** วลีที่เป็น "ตัวเลขล้วน" (มี % ต่อท้ายได้) — ตัวเลือกพวกนี้ห้ามจับคู่แบบบางส่วน */
const NUMERIC_CHOICE_RE = /^\d+%?$/;

/**
 * ชื่อตัวเลือกนี้ตรงกับคำที่พูดไหม (เทียบหลัง normalize ทั้งสองฝั่ง)
 *
 * ยอมให้ตรงแบบขึ้นต้น/มีอยู่ในชื่อ เพราะเสียงมักได้คำสั้นกว่าชื่อเต็ม เช่น พูด
 * "คั่วเข้ม" กับตัวเลือกชื่อ "คั่วเข้ม (+0)" — ยกเว้นตัวเลือกที่เป็นตัวเลขล้วน
 * ซึ่งต้องตรงเป๊ะ ไม่งั้น "100%" จะถูกจับคู่กับคำพูด "0%" เพราะเป็นสตริงย่อย
 * (พูดว่าไม่หวานแล้วได้หวานสุด = ผิดแบบที่ลูกค้าเห็นตอนได้แก้วแล้วเท่านั้น)
 */
export function matchesVoiceChoicePhrase(optionName: string, spokenTarget: string): boolean {
  const name = normalizeVoiceChoicePhrase(optionName);
  const target = normalizeVoiceChoicePhrase(spokenTarget);
  if (!target) return false;
  if (NUMERIC_CHOICE_RE.test(name) || NUMERIC_CHOICE_RE.test(target)) {
    if (name === target) return true;
    // แคชเชียร์มักพูดชื่อกลุ่มนำหน้าค่า เช่น "หวาน 0%" / "ความหวาน 25%" — รับได้เมื่อ
    // ค่าที่ตามมาตรงเป๊ะและตัวอักษรก่อนหน้าไม่ใช่ตัวเลข (กัน "150%" ไปตรงกับ "50%")
    if (NUMERIC_CHOICE_RE.test(name) && target.endsWith(name)) {
      const before = target.slice(0, target.length - name.length);
      return before.length > 0 && !/\d$/.test(before);
    }
    return false;
  }
  return name === target || name.startsWith(target) || name.includes(target);
}
