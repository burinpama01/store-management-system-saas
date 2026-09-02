// U16 — Voice telemetry adapter (R2) · ทางออกเดียวของ "ข้อมูลการใช้เสียง"
// pure ล้วน ไม่มี network/DB/console — ผู้เรียกเป็นคนตัดสินใจว่าจะส่งต่อที่ไหน
//
// สัญญาความเป็นส่วนตัว (แผน v2 · Voice privacy):
//   เก็บได้:  intent_type, result_code, locale, confidence_bucket, time
//   ห้ามเก็บ: audio, raw transcript, normalized phrase, voiceprint
// ทุก event ถูก "สร้างใหม่จากฟิลด์ที่อนุญาต" เสมอ — ไม่ spread object ที่รับเข้ามา
// เพื่อไม่ให้ฟิลด์แปลกปลอมรอดเข้าไปได้แม้ผู้เรียกจะเผลอส่งมา

import type { VoiceTelemetryEvent } from "./types";

/** อายุข้อมูลสูงสุด 30 วันตามแผน — เกินกว่านี้ต้องถูกล้างทิ้ง */
export const VOICE_TELEMETRY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** ฟิลด์เดียวที่อนุญาตให้มีใน event (ใช้ในเทสต์สแกนด้วย) */
export const VOICE_TELEMETRY_ALLOWED_KEYS = [
  "at",
  "confidenceBucket",
  "intentType",
  "locale",
  "resultCode",
] as const;

/** ตัดทุกอย่างที่ไม่อยู่ใน allowlist ออกโดยการประกอบใหม่ */
export function sanitizeVoiceTelemetry(event: VoiceTelemetryEvent): VoiceTelemetryEvent {
  return {
    intentType: event.intentType,
    resultCode: event.resultCode,
    locale: event.locale,
    confidenceBucket: event.confidenceBucket,
    at: event.at,
  };
}

export interface VoiceTelemetrySink {
  /** บันทึก 1 เหตุการณ์ (sanitize + purge ของเก่าทุกครั้ง) */
  record: (event: VoiceTelemetryEvent, now?: Date) => void;
  /** อ่านเหตุการณ์ที่ยังอยู่ในช่วงเก็บ */
  list: (now?: Date) => readonly VoiceTelemetryEvent[];
  /** ล้างของที่พ้นอายุ — คืนจำนวนที่ถูกลบ */
  purge: (now?: Date) => number;
  clear: () => void;
}

export interface VoiceTelemetrySinkOptions {
  readonly retentionMs?: number;
  /** จำกัดจำนวนสูงสุดในหน่วยความจำ กันโตไม่จำกัดในเครื่องที่เปิดค้างทั้งวัน */
  readonly maxEntries?: number;
}

/**
 * sink ในหน่วยความจำของ session นี้เท่านั้น — ไม่เขียนลง localStorage/DB
 * (ถ้าอนาคตจะส่งขึ้น server ต้องส่งผ่าน sanitizeVoiceTelemetry เท่านั้น)
 */
export function createInMemoryVoiceTelemetrySink(
  options: VoiceTelemetrySinkOptions = {},
): VoiceTelemetrySink {
  const retentionMs = options.retentionMs ?? VOICE_TELEMETRY_RETENTION_MS;
  const maxEntries = options.maxEntries ?? 500;
  let entries: VoiceTelemetryEvent[] = [];

  const purge = (now: Date = new Date()): number => {
    const cutoff = now.getTime() - retentionMs;
    const before = entries.length;
    entries = entries.filter((event) => {
      const at = Date.parse(event.at);
      // เวลาที่อ่านไม่ออก = ทิ้ง (ไม่เก็บข้อมูลที่ตรวจสอบอายุไม่ได้)
      return Number.isFinite(at) && at > cutoff;
    });
    return before - entries.length;
  };

  return {
    record: (event, now = new Date()) => {
      entries.push(sanitizeVoiceTelemetry(event));
      purge(now);
      if (entries.length > maxEntries) {
        entries = entries.slice(entries.length - maxEntries);
      }
    },
    list: (now = new Date()) => {
      purge(now);
      return [...entries];
    },
    purge,
    clear: () => {
      entries = [];
    },
  };
}
