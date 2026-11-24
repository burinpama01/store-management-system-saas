// ส่งสรุปยอดของสาขาที่เลยเวลาปิดร้าน 1 ชม. แล้วยังไม่มีสรุป — เรียกจาก pg_cron ผ่าน API
// service client เท่านั้น ผู้เรียกต้องตรวจกุญแจมาก่อนแล้ว
import { createSupabaseServiceClient } from "@/server/integrations/supabase/server";
import { notifyOwnerNow } from "@/modules/notifications/dispatcher";
import { completeDailySummaryNotification } from "@/modules/attendance/shift-status-repository";
import { logActionError, logSystemEvent } from "@/modules/system/event-log";
import { loadStoreDailySummary } from "./daily-summary-repository";
import { buildDailySummaryMessage } from "./daily-summary";
import { buildClosingSummaryTrigger, closingSummaryDueAtMs, shouldWaitForOtStaff } from "./closing-summary";

const SOURCE = "reports.closing-summary";

type DueStore = {
  organization_id: string;
  store_id: string;
  store_name: string | null;
  summary_date: string;
  timezone: string;
  closing_time: string;
};

export interface ClosingSummaryResult {
  due: number;
  sent: number;
  failed: number;
  skippedNoOrders: number;
  alreadyClaimed: number;
  /** วันให้ OT ที่คน OT ยังไม่ออกงาน — ยังไม่จอง รอรอบ pg_cron ถัดไป */
  waitingOt: number;
}

// ฟังก์ชัน/คอลัมน์ใหม่ยังไม่อยู่ใน database.types (เหมือน daily_summary_notification_log)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Untyped = any;

export async function runClosingSummaries(now: Date = new Date()): Promise<ClosingSummaryResult> {
  const db: Untyped = await createSupabaseServiceClient();
  const result: ClosingSummaryResult = { due: 0, sent: 0, failed: 0, skippedNoOrders: 0, alreadyClaimed: 0, waitingOt: 0 };

  // ตัวตัดสินเดียวกับที่ pg_cron ใช้ก่อนเรียก API — ไม่คิดเวลาซ้ำฝั่งนี้
  const { data, error } = await db.rpc("closing_summary_due_stores", { p_now: now.toISOString() });
  if (error) throw error;
  const due = (data ?? []) as DueStore[];
  result.due = due.length;

  // ทีละสาขา: จำนวนที่ถึงเวลาในรอบ 30 นาทีมีน้อย และไม่อยากยิง LINE/Telegram พร้อมกันจนโดน rate limit
  for (const store of due) {
    try {
      const outcome = await sendOne(db, store, now);
      result[outcome] += 1;
    } catch (error) {
      result.failed += 1;
      logActionError({
        source: SOURCE,
        action: "sendClosingSummary",
        error,
        organizationId: store.organization_id,
        storeId: store.store_id,
      });
    }
  }

  void logSystemEvent({
    level: result.failed > 0 ? "warn" : "info",
    source: SOURCE,
    action: "runClosingSummaries",
    message: `สรุปจากเวลาปิดร้าน · ถึงเวลา ${result.due} สาขา · ส่ง ${result.sent} · ไม่มีบิล ${result.skippedNoOrders} · รอคน OT ${result.waitingOt} · ล้ม ${result.failed}`,
    context: { ...result },
  });
  return result;
}

/** วันให้ OT ของสาขา/วันนั้น (เฉพาะโหมด OT เฉพาะวัน) — อ่านไม่ได้ = ไม่รอ (ส่งตามเดิม ดีกว่าไม่มีสรุป) */
// อ่าน 2 query แยกกัน (ไม่ atomic) โดยตั้งใจ — ผลเพี้ยนชั่วคราวแย่สุดคือ "ไม่รอ" = ส่งสรุปตามเดิม (fail-open)
async function loadOtDayForSummary(
  db: Untyped,
  store: DueStore,
): Promise<{ capHours: number; userIds: string[] } | null> {
  try {
    const { data: hr, error: hrError } = await db
      .from("store_hr_settings")
      .select("ot_mode")
      .eq("store_id", store.store_id)
      .maybeSingle();
    if (hrError) throw hrError;
    if (hr?.ot_mode !== "scheduled") return null;
    const { data: day, error: dayError } = await db
      .from("store_ot_days")
      .select("cap_hours, user_ids")
      .eq("store_id", store.store_id)
      .eq("date", store.summary_date)
      .maybeSingle();
    if (dayError) throw dayError;
    if (!day) return null;
    return { capHours: Number(day.cap_hours) || 0, userIds: (day.user_ids ?? []) as string[] };
  } catch (error) {
    logActionError({
      source: SOURCE,
      action: "loadOtDayForSummary",
      error,
      organizationId: store.organization_id,
      storeId: store.store_id,
    });
    return null;
  }
}

async function sendOne(
  db: Untyped,
  store: DueStore,
  now: Date,
): Promise<"sent" | "failed" | "skippedNoOrders" | "alreadyClaimed" | "waitingOt"> {
  const { data: openRows, error: openError } = await db
    .from("attendance_records")
    .select("employee_name, user_id")
    .eq("organization_id", store.organization_id)
    .eq("store_id", store.store_id)
    .eq("date", store.summary_date)
    .eq("status", "active");
  if (openError) throw openError;
  const open = (openRows ?? []) as { employee_name: string | null; user_id: string | null }[];

  // วันให้ OT: คน OT ยังไม่ออกงาน = ยังไม่จอง → สรุปไปส่งตอนคน OT คนสุดท้ายกดออก (หรือรอบ pg_cron ถัดไป)
  if (open.length > 0) {
    const otDay = await loadOtDayForSummary(db, store);
    const wait = shouldWaitForOtStaff({
      otDay,
      openUserIds: open.map((r) => r.user_id).filter((id): id is string => Boolean(id)),
      dueAtMs: closingSummaryDueAtMs(store.summary_date, store.closing_time, store.timezone),
      nowMs: now.getTime(),
    });
    if (wait) {
      void logSystemEvent({
        level: "info",
        source: SOURCE,
        action: "waitForOtStaff",
        message: "วันให้ OT · คน OT ยังไม่ออกงาน — เลื่อนสรุปยอดไปจนคน OT ออกงาน",
        organizationId: store.organization_id,
        storeId: store.store_id,
        context: { date: store.summary_date, openCount: open.length, capHours: otDay?.capHours ?? null },
      });
      return "waitingOt";
    }
  }

  const summary = await loadStoreDailySummary({
    storeId: store.store_id,
    organizationId: store.organization_id,
    storeName: store.store_name ?? "",
    date: store.summary_date,
    timezone: store.timezone,
  });

  // จองก่อนส่งเสมอ — แถวนี้คือสิ่งที่ทำให้ pg_cron หยุดเรียกซ้ำ และกันชนกับการกดออกงานพร้อมกัน
  const { error: claimError } = await db.from("daily_summary_notification_log").insert({
    organization_id: store.organization_id,
    store_id: store.store_id,
    summary_date: store.summary_date,
    attendance_record_id: null,
    trigger_source: "closing_time",
    delivery_status: summary ? "claimed" : "skipped",
  });
  if (claimError) {
    if ((claimError as { code?: string }).code === "23505") return "alreadyClaimed";
    throw claimError;
  }
  if (!summary) return "skippedNoOrders";

  const openNames = open
    .map((r) => r.employee_name?.trim())
    .filter((n): n is string => Boolean(n));

  const trigger = buildClosingSummaryTrigger(store.closing_time, openNames);
  const delivered = await notifyOwnerNow({
    type: "daily_summary",
    destination: "owner",
    title: "สรุปยอดประจำวัน",
    message: buildDailySummaryMessage(summary, store.summary_date, { trigger }),
    organizationId: store.organization_id,
    storeId: store.store_id,
    metadata: {
      date: store.summary_date,
      orderCount: summary.orderCount,
      revenue: summary.revenue,
      trigger,
      triggerSource: "closing_time",
      openShiftCount: openNames.length,
    },
  });
  await completeDailySummaryNotification({
    storeId: store.store_id,
    organizationId: store.organization_id,
    date: store.summary_date,
    delivered,
  });
  // ส่งไม่ครบ = ไม่ retry วันนั้นโดยตั้งใจ (claim ยังอยู่) เพราะบางช่องทางอาจส่งไปแล้ว
  // กู้ด้วยมือ: ลบแถวใน daily_summary_notification_log ของสาขา/วันนั้น แล้วรอรอบ pg_cron ถัดไป
  if (!delivered) {
    void logSystemEvent({
      level: "warn",
      source: SOURCE,
      action: "notifyOwnerNow",
      message: "ส่งสรุปจากเวลาปิดร้านไม่ครบทุกช่องทาง — เก็บ claim ไว้กันข้อความซ้ำ",
      organizationId: store.organization_id,
      storeId: store.store_id,
      context: { date: store.summary_date },
    });
    return "failed";
  }
  return "sent";
}
