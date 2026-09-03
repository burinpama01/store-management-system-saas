/**
 * บันทึกการทำงานของระบบ — ทางเดียวที่ควรใช้บันทึกเหตุการณ์/ข้อผิดพลาดของแอป
 * ดูผลที่ /system/logs (ซูเปอร์แอดมินเท่านั้น)
 *
 * หลักที่ยึด:
 *   1. บันทึกต้อง "ไม่ทำให้งานหลักพัง" — ทุกเส้นทางกลืน error ของตัวเองเสมอ
 *   2. ห้ามเก็บความลับ — ตัดคีย์อ่อนไหวและตัดข้อความยาวก่อนบันทึกทุกครั้ง
 *   3. ต้องอ่านออกทั้งคนและ AI — แยกฟิลด์ชัด (level/source/action/message/context)
 *      และมี fingerprint ให้จัดกลุ่ม "ปัญหาเดียวกัน" ได้โดยไม่ต้องเดา
 */
import { createSupabaseServiceClient } from "@/server/integrations/supabase/server";

export type SystemLogLevel = "error" | "warn" | "info";

export interface SystemLogInput {
  readonly level: SystemLogLevel;
  /** ส่วนของระบบ เช่น "pos.payment", "qr-order.submit", "loyalty.claim" */
  readonly source: string;
  /** ชื่อการทำงาน เช่น "collectPaymentAction" */
  readonly action: string;
  /** ข้อความสั้นภาษาคน */
  readonly message: string;
  readonly errorCode?: string | null;
  readonly organizationId?: string | null;
  readonly storeId?: string | null;
  readonly actorUserId?: string | null;
  readonly requestId?: string | null;
  readonly durationMs?: number | null;
  /** รายละเอียดเพิ่มเติมแบบมีโครงสร้าง (จะถูกตัดข้อมูลอ่อนไหวออกให้) */
  readonly context?: Record<string, unknown> | null;
}

/** คีย์ที่ห้ามบันทึกเด็ดขาด — ตัดทิ้งทุกชั้นของ context */
const SECRET_KEY_PATTERN = /(token|secret|password|passwd|api[-_]?key|authorization|cookie|session|otp|pin)/i;

/** ค่าที่ยาวเกินนี้จะถูกตัด (log ไม่ใช่ที่เก็บ payload) */
const MAX_STRING = 300;
const MAX_MESSAGE = 500;
const MAX_KEYS = 25;
const MAX_DEPTH = 3;

function redactValue(value: unknown, depth: number): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (depth >= MAX_DEPTH) return "[ลึกเกินไป]";
  if (Array.isArray(value)) {
    return value.slice(0, 10).map((item) => redactValue(item, depth + 1));
  }
  if (typeof value === "object") {
    return redactObject(value as Record<string, unknown>, depth + 1);
  }
  return String(value);
}

function redactObject(input: Record<string, unknown>, depth = 0): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let count = 0;
  for (const [key, value] of Object.entries(input)) {
    if (count >= MAX_KEYS) {
      out["…"] = "ตัดคีย์ที่เหลือออก";
      break;
    }
    count += 1;
    if (SECRET_KEY_PATTERN.test(key)) {
      out[key] = "[ปกปิด]";
      continue;
    }
    out[key] = redactValue(value, depth);
  }
  return out;
}

/** ตัดส่วนที่ต่างกันทุกครั้ง (id/ตัวเลข/เวลา) ออก เพื่อให้ปัญหาเดียวกันได้ fingerprint เดียวกัน */
function normalizeForFingerprint(message: string): string {
  return message
    .toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<id>")
    .replace(/\d{4}-\d{2}-\d{2}t[\d:.]+z?/g, "<time>")
    .replace(/\b\d+([.,]\d+)?\b/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

/** fingerprint แบบ deterministic (ไม่ใช้ crypto เพื่อให้ทดสอบง่ายและเสถียรข้ามรุ่น) */
export function buildLogFingerprint(input: {
  readonly level: SystemLogLevel;
  readonly source: string;
  readonly action: string;
  readonly errorCode?: string | null;
  readonly message: string;
}): string {
  const base = [
    input.level,
    input.source,
    input.action,
    input.errorCode ?? "-",
    normalizeForFingerprint(input.message),
  ].join("|");

  let hash = 5381;
  for (let i = 0; i < base.length; i += 1) {
    hash = ((hash << 5) + hash + base.charCodeAt(i)) >>> 0;
  }
  return `${input.source}:${input.action}:${hash.toString(36)}`;
}

/** แปลง error อะไรก็ได้เป็นข้อความ + รหัสที่บันทึกได้ */
export function describeError(error: unknown): { message: string; errorCode: string | null } {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return {
      message: error.message.slice(0, MAX_MESSAGE),
      errorCode: typeof code === "string" ? code : null,
    };
  }
  if (error && typeof error === "object") {
    const row = error as Record<string, unknown>;
    const message = typeof row.message === "string" ? row.message : JSON.stringify(row).slice(0, MAX_MESSAGE);
    return {
      message: message.slice(0, MAX_MESSAGE),
      errorCode: typeof row.code === "string" ? row.code : null,
    };
  }
  return { message: String(error).slice(0, MAX_MESSAGE), errorCode: null };
}

/** สร้างแถวที่พร้อมบันทึก (แยกออกมาเพื่อทดสอบได้โดยไม่ต้องแตะฐานข้อมูล) */
export function buildSystemLogRow(input: SystemLogInput) {
  const message = input.message.slice(0, MAX_MESSAGE);
  return {
    level: input.level,
    source: input.source.slice(0, 80),
    action: input.action.slice(0, 120),
    message,
    error_code: input.errorCode ? input.errorCode.slice(0, 80) : null,
    organization_id: input.organizationId ?? null,
    store_id: input.storeId ?? null,
    actor_user_id: input.actorUserId ?? null,
    request_id: input.requestId ? input.requestId.slice(0, 120) : null,
    duration_ms:
      typeof input.durationMs === "number" && Number.isFinite(input.durationMs)
        ? Math.max(0, Math.round(input.durationMs))
        : null,
    context: input.context ? redactObject(input.context) : null,
    fingerprint: buildLogFingerprint({
      level: input.level,
      source: input.source,
      action: input.action,
      errorCode: input.errorCode,
      message,
    }),
  };
}

/**
 * บันทึกเหตุการณ์ — ไม่ throw และไม่ทำให้ผู้เรียกช้า (ไม่ต้อง await ก็ได้)
 * ถ้าบันทึกไม่ได้จะตกไปที่ console เพื่อไม่ให้ข้อมูลหายเงียบ ๆ
 */
export async function logSystemEvent(input: SystemLogInput): Promise<void> {
  try {
    const supabase = await createSupabaseServiceClient();
    const row = buildSystemLogRow(input);
    // context ผ่านการ redact แล้วจึงเป็น JSON ที่ปลอดภัย — cast เพื่อให้ตรงกับชนิด Json ของ client
    const { error } = await supabase.from("system_event_logs").insert({
      ...row,
      context: (row.context ?? null) as never,
    });
    if (error) {
      console.warn("[system-log] บันทึกไม่สำเร็จ", { action: input.action, error: error.message });
    }
  } catch (e) {
    console.warn("[system-log] บันทึกไม่สำเร็จ", {
      action: input.action,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/** ทางลัดสำหรับ catch block ของ server action */
export function logActionError(input: {
  readonly source: string;
  readonly action: string;
  readonly error: unknown;
  readonly storeId?: string | null;
  readonly organizationId?: string | null;
  readonly actorUserId?: string | null;
  readonly context?: Record<string, unknown> | null;
}): void {
  const { message, errorCode } = describeError(input.error);
  void logSystemEvent({
    level: "error",
    source: input.source,
    action: input.action,
    message,
    errorCode,
    storeId: input.storeId,
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    context: input.context,
  });
}

/**
 * ล้างบันทึกที่เก่ากว่าที่กำหนด — เรียกจากงานประจำวัน
 *
 * ตารางนี้โตทุกวันและไม่มีใครลบ ถ้าปล่อยไว้จะกินพื้นที่ฐานข้อมูลจริงของร้าน
 * (Vercel Hobby ต่อ cron เพิ่มไม่ได้ จึงพ่วงไปกับงานประจำวันที่มีอยู่แล้ว)
 */
export async function purgeOldSystemEventLogs(keepDays = 30): Promise<number> {
  try {
    const supabase = await createSupabaseServiceClient();
    const { data, error } = await supabase.rpc("purge_old_system_event_logs", { p_keep_days: keepDays });
    if (error) {
      console.warn("[system-log] ล้างบันทึกเก่าไม่สำเร็จ", error.message);
      return 0;
    }
    return typeof data === "number" ? data : 0;
  } catch (e) {
    console.warn("[system-log] ล้างบันทึกเก่าไม่สำเร็จ", e instanceof Error ? e.message : String(e));
    return 0;
  }
}
