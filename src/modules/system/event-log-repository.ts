/**
 * อ่านบันทึกการทำงานของระบบสำหรับหน้าซูเปอร์แอดมิน (/system/logs)
 * ใช้ service client เพราะตาราง system_event_logs ไม่เปิดให้ role ไหนอ่านตรง ๆ เลย
 * — หน้าที่เรียกต้องผ่าน requireSystemAccess() มาก่อนแล้วเท่านั้น
 */
import type { AppError } from "@/shared/utils/error";
import { mapError } from "@/shared/utils/error";
import { createSupabaseServiceClient } from "@/server/integrations/supabase/server";
import type { SystemLogLevel } from "./event-log";

export interface SystemLogEntry {
  readonly id: string;
  readonly occurredAt: string;
  readonly level: SystemLogLevel;
  readonly source: string;
  readonly action: string;
  readonly message: string;
  readonly errorCode: string | null;
  readonly storeId: string | null;
  readonly organizationId: string | null;
  readonly actorUserId: string | null;
  readonly requestId: string | null;
  readonly durationMs: number | null;
  readonly context: Record<string, unknown> | null;
  readonly fingerprint: string;
}

/** กลุ่มปัญหาของวันหนึ่ง — "อาการเดียวกัน" ถูกยุบเป็นแถวเดียวพร้อมจำนวนครั้ง */
export interface SystemLogGroup {
  readonly fingerprint: string;
  readonly level: SystemLogLevel;
  readonly source: string;
  readonly action: string;
  readonly errorCode: string | null;
  readonly message: string;
  readonly occurrences: number;
  readonly firstAt: string;
  readonly lastAt: string;
  readonly storeCount: number;
  readonly sampleContext: Record<string, unknown> | null;
}

export interface SystemLogDay {
  readonly day: string;
  readonly counts: { readonly error: number; readonly warn: number; readonly info: number };
  readonly groups: readonly SystemLogGroup[];
  readonly recent: readonly SystemLogEntry[];
}

function toEntry(row: Record<string, unknown>): SystemLogEntry {
  return {
    id: String(row.id ?? ""),
    occurredAt: String(row.occurred_at ?? ""),
    level: (row.level === "error" || row.level === "warn" ? row.level : "info") as SystemLogLevel,
    source: String(row.source ?? ""),
    action: String(row.action ?? ""),
    message: String(row.message ?? ""),
    errorCode: typeof row.error_code === "string" ? row.error_code : null,
    storeId: typeof row.store_id === "string" ? row.store_id : null,
    organizationId: typeof row.organization_id === "string" ? row.organization_id : null,
    actorUserId: typeof row.actor_user_id === "string" ? row.actor_user_id : null,
    requestId: typeof row.request_id === "string" ? row.request_id : null,
    durationMs: typeof row.duration_ms === "number" ? row.duration_ms : null,
    context: row.context && typeof row.context === "object" ? (row.context as Record<string, unknown>) : null,
    fingerprint: String(row.fingerprint ?? ""),
  };
}

/** วันที่ของ "วันนี้" ตามเวลาไทย (ให้ตรงกับคอลัมน์ occurred_on ที่คิดด้วย Asia/Bangkok) */
export function todayInBangkok(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** เลื่อนวัน (ใช้กับปุ่มย้อนหลัง/ถัดไป) — ทำงานบนสตริง YYYY-MM-DD ล้วน ไม่แตะ timezone */
export function shiftDay(day: string, deltaDays: number): string {
  const [y, m, d] = day.split("-").map((part) => Number.parseInt(part, 10));
  if (!y || !m || !d) return day;
  const base = new Date(Date.UTC(y, m - 1, d));
  base.setUTCDate(base.getUTCDate() + deltaDays);
  return base.toISOString().slice(0, 10);
}

export async function getSystemLogDay(
  day: string,
  options: { readonly level?: SystemLogLevel | "all"; readonly recentLimit?: number } = {},
): Promise<{ data: SystemLogDay | null; error: AppError | null }> {
  const supabase = await createSupabaseServiceClient();
  const level = options.level ?? "all";
  const recentLimit = Math.min(300, Math.max(20, options.recentLimit ?? 120));

  const summary = await supabase.rpc("get_system_log_day_summary", { p_day: day });
  if (summary.error) return { data: null, error: mapError(summary.error) };

  let recentQuery = supabase
    .from("system_event_logs")
    .select("*")
    .eq("occurred_on", day)
    .order("occurred_at", { ascending: false })
    .limit(recentLimit);
  if (level !== "all") recentQuery = recentQuery.eq("level", level);

  const recent = await recentQuery;
  if (recent.error) return { data: null, error: mapError(recent.error) };

  const groups: SystemLogGroup[] = ((summary.data ?? []) as Record<string, unknown>[])
    .map((row) => ({
      fingerprint: String(row.fingerprint ?? ""),
      level: (row.level === "error" || row.level === "warn" ? row.level : "info") as SystemLogLevel,
      source: String(row.source ?? ""),
      action: String(row.action ?? ""),
      errorCode: typeof row.error_code === "string" ? row.error_code : null,
      message: String(row.message ?? ""),
      occurrences: Number(row.occurrences ?? 0),
      firstAt: String(row.first_at ?? ""),
      lastAt: String(row.last_at ?? ""),
      storeCount: Number(row.store_count ?? 0),
      sampleContext:
        row.sample_context && typeof row.sample_context === "object"
          ? (row.sample_context as Record<string, unknown>)
          : null,
    }))
    .filter((group) => level === "all" || group.level === level);

  const counts = { error: 0, warn: 0, info: 0 };
  for (const row of (summary.data ?? []) as Record<string, unknown>[]) {
    const groupLevel = String(row.level ?? "info");
    const occurrences = Number(row.occurrences ?? 0);
    if (groupLevel === "error") counts.error += occurrences;
    else if (groupLevel === "warn") counts.warn += occurrences;
    else counts.info += occurrences;
  }

  return {
    data: {
      day,
      counts,
      groups,
      recent: ((recent.data ?? []) as Record<string, unknown>[]).map(toEntry),
    },
    error: null,
  };
}

/**
 * สรุปวันหนึ่งเป็นข้อความสำหรับให้ AI อ่าน — จงใจให้เป็นโครงสร้างคงที่
 * เพื่อให้ตอบได้ทันทีว่า "พังตรงไหน ที่ไหน บ่อยแค่ไหน" โดยไม่ต้องเดาจาก log ดิบ
 */
export function buildAiLogReport(data: SystemLogDay): string {
  const lines: string[] = [];
  lines.push(`# StoreOS system log — ${data.day} (Asia/Bangkok)`);
  lines.push(`errors=${data.counts.error} warns=${data.counts.warn} infos=${data.counts.info}`);
  lines.push("");

  if (data.groups.length === 0) {
    lines.push("ไม่มีเหตุการณ์ในวันนี้");
    return lines.join("\n");
  }

  lines.push("## ปัญหาที่พบ (เรียงตามความรุนแรงและจำนวนครั้ง)");
  for (const [index, group] of data.groups.entries()) {
    lines.push(
      [
        `${index + 1}. [${group.level.toUpperCase()}] ${group.source} → ${group.action}`,
        `   ครั้ง: ${group.occurrences} | ร้านที่กระทบ: ${group.storeCount} | รหัส: ${group.errorCode ?? "-"}`,
        `   ข้อความ: ${group.message}`,
        `   ช่วงเวลา: ${group.firstAt} → ${group.lastAt}`,
        group.sampleContext ? `   context: ${JSON.stringify(group.sampleContext)}` : "   context: -",
      ].join("\n"),
    );
  }
  return lines.join("\n");
}
