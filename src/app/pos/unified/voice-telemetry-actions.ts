"use server";

// v0.44.10 — ส่ง voice telemetry ขึ้น server เพื่อวัดผลการใช้งานจริง
//
// เดิม telemetry อยู่ในหน่วยความจำแท็บอย่างเดียว ปิดแท็บคือหาย จึงตอบไม่ได้เลยว่า
// "พนักงานพูดไปกี่ครั้ง ระบบเข้าใจกี่ครั้ง" ซึ่งเป็นตัวเลขที่ต้องใช้ตัดสินใจเรื่อง pilot
//
// สัญญาความเป็นส่วนตัวไม่เปลี่ยน: เก็บได้แค่ 5 ฟิลด์ที่ allowlist อนุญาต
//   intentType, resultCode, locale, confidenceBucket, at
// ห้ามเก็บ: audio, transcript, normalized phrase, ชื่อสินค้า, voiceprint
// ตัว action นี้ "ไม่รับ" คำพูดเลยตั้งแต่ระดับ signature — ต่อให้ client อยากส่งก็ส่งไม่ได้
//
// ปลายทางคือ system_event_logs ซึ่งมี purge 30 วันอยู่แล้ว
// (purge_old_system_event_logs) ตรงกับ retention ที่แผน voice กำหนดพอดี

import { getOptionalResolvedCurrentPermissions } from "@/modules/auth/guards";
import { logSystemEvent } from "@/modules/system/event-log";
import {
  VOICE_CONFIDENCE_BUCKETS,
  VOICE_INTENT_TYPES,
  VOICE_RESULT_CODES,
  type VoiceConfidenceBucket,
  type VoiceIntentType,
  type VoiceResultCode,
} from "@/modules/voice-pos/types";

/** ที่มาของคำสั่ง — deterministic = parser เดิม, ai = ผ่านทางสำรอง AI */
const SOURCES = ["deterministic", "ai"] as const;
type VoiceTelemetrySource = (typeof SOURCES)[number];

const LOCALE_MAX = 16;

function isIntentType(value: unknown): value is VoiceIntentType {
  return typeof value === "string" && (VOICE_INTENT_TYPES as readonly string[]).includes(value);
}
function isResultCode(value: unknown): value is VoiceResultCode {
  return typeof value === "string" && (VOICE_RESULT_CODES as readonly string[]).includes(value);
}
function isBucket(value: unknown): value is VoiceConfidenceBucket {
  return typeof value === "string" && (VOICE_CONFIDENCE_BUCKETS as readonly string[]).includes(value);
}

export interface RecordVoiceTelemetryInput {
  readonly intentType: string;
  readonly resultCode: string;
  readonly locale: string;
  readonly confidenceBucket: string;
  readonly source: string;
}

/**
 * บันทึก 1 เหตุการณ์ของการสั่งงานด้วยเสียง
 * ทุกค่าต้องอยู่ใน allowlist มิฉะนั้นทิ้งทั้ง event (fail closed — ไม่บันทึกของที่ไม่รู้จัก)
 * ไม่คืน error ให้ UI: การวัดผลต้องไม่ทำให้การขายสะดุด
 */
export async function recordVoiceTelemetryAction(input: RecordVoiceTelemetryInput): Promise<void> {
  try {
    const authz = await getOptionalResolvedCurrentPermissions();
    if (!authz) return;
    const { ctx, user, resolved } = authz;
    if (!resolved.can("pos.use")) return;

    if (!isIntentType(input.intentType) || !isResultCode(input.resultCode) || !isBucket(input.confidenceBucket)) {
      return;
    }
    const source: VoiceTelemetrySource = input.source === "ai" ? "ai" : "deterministic";
    const locale = typeof input.locale === "string" ? input.locale.slice(0, LOCALE_MAX) : "";

    await logSystemEvent({
      // ผลลัพธ์ที่ระบบ "ไม่เข้าใจ" ไม่ใช่ error ของระบบ แต่เป็นสัญญาณที่ต้องเห็น
      level: input.resultCode === "matched" ? "info" : "warn",
      source: "voice.command",
      action: "recognize",
      message: `คำสั่งเสียง: ${input.intentType} · ${input.resultCode} (${source})`,
      organizationId: ctx.organizationId,
      storeId: ctx.storeId,
      actorUserId: user.id,
      // ครบ 5 ฟิลด์ของ allowlist + ที่มา — ไม่มีคำพูดอยู่ในนี้
      context: {
        intentType: input.intentType,
        resultCode: input.resultCode,
        locale,
        confidenceBucket: input.confidenceBucket,
        source,
      },
    });
  } catch {
    // best-effort — การวัดผลพังต้องไม่ทำให้พนักงานขายของไม่ได้
  }
}
