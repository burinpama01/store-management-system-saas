/**
 * งานส่งอีเมลสรุปยอดรายวันถึงเจ้าขององค์กร — เรียกวันละครั้งจาก cron
 *
 * กติกาที่ผู้ใช้สั่งไว้: **ส่งเฉพาะผู้ใช้ที่มีออเดอร์ของวันนั้น** ร้านที่เงียบทั้งวันต้องไม่ได้อีเมล
 * (อีเมลที่ส่งทุกวันไม่ว่าจะขายได้หรือไม่ = อีเมลที่ไม่มีใครเปิด)
 *
 * กันส่งซ้ำด้วยการ insert ลง daily_summary_email_log ก่อนส่ง — ชน unique index เมื่อไหร่
 * แปลว่ามีรอบก่อนหน้าส่งไปแล้ว ให้ข้าม (cron รันซ้ำ/สองอินสแตนซ์พร้อมกันก็ปลอดภัย)
 * เจตนา: ยอมพลาดอีเมล 1 วันเมื่อผู้ให้บริการล่ม ดีกว่าส่งซ้ำหลายฉบับ — ทุกเส้นทางมี log เสมอ
 */
import { createSupabaseServiceClient } from "@/server/integrations/supabase/server";
import { isEmailConfigured, sendTransactionalEmail } from "@/modules/notifications/email";
import { logActionError, logSystemEvent } from "@/modules/system/event-log";
import { loadStoreDailySummary } from "./daily-summary-repository";
import { loadAllRows } from "./pagination";
import {
  buildDailySummaryEmail,
  totalsOfStores,
  type OrganizationDailySummary,
  type StoreDailySummary,
} from "./daily-summary";

const SOURCE = "reports.daily-summary";

export interface DailySummaryEmailResult {
  /** วันของยอดที่สรุป (เมื่อวานตามเวลาไทย) */
  readonly day: string;
  readonly scannedOrganizations: number;
  readonly sent: number;
  /** ข้ามเพราะไม่มีออเดอร์ / ส่งไปแล้ว / ไม่มีอีเมลเจ้าของ */
  readonly skipped: number;
  readonly failed: number;
}

interface StoreRow {
  id: string;
  organization_id: string;
  name: string;
  timezone: string | null;
  daily_summary_email_enabled?: boolean | null;
}

interface OrganizationRow {
  id: string;
  name: string;
  owner_id: string;
  suspended_at: string | null;
}

const QUERY_PAGE_SIZE = 1000;

/** วันก่อนหน้าตามนาฬิกาของ timezone ที่ให้มา — cron รัน 09:00 ไทย จึงสรุป "เมื่อวาน" ที่ปิดวันแล้ว */
export function previousLocalDate(now: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone || "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const today = new Date(`${get("year")}-${get("month")}-${get("day")}T00:00:00.000Z`);
  today.setUTCDate(today.getUTCDate() - 1);
  return today.toISOString().slice(0, 10);
}

async function resolveOwnerEmail(ownerId: string): Promise<string | null> {
  try {
    const supabase = await createSupabaseServiceClient();
    const { data } = await supabase.auth.admin.getUserById(ownerId);
    return data.user?.email ?? null;
  } catch {
    return null;
  }
}

/**
 * จองสิทธิ์ส่งของวันนี้ — true = จองได้, false = มีคนส่งไปแล้ว
 * insert ธรรมดาแล้วดูว่าชน unique index ไหม เพื่อให้เป็น atomic จริง (แบบเดียวกับ subscription_alert_log)
 */
async function claimDailySummary(
  organizationId: string,
  day: string,
  stats: { storeCount: number; orderCount: number; revenue: number },
): Promise<boolean> {
  const supabase = await createSupabaseServiceClient();
  const rpc = supabase.rpc.bind(supabase) as unknown as (
    name: string,
    args: Record<string, unknown>,
  ) => Promise<{ data: boolean | null; error: { code?: string; message?: string } | null }>;
  const { data, error } = await rpc("claim_daily_summary_email", {
    p_organization_id: organizationId,
    p_summary_date: day,
    p_store_count: stats.storeCount,
    p_order_count: stats.orderCount,
    p_revenue: stats.revenue,
  });
  if (error) throw error;
  return data === true;
}

async function completeDailySummaryEmail(input: {
  organizationId: string;
  day: string;
  delivered: boolean;
  errorMessage?: string;
}): Promise<void> {
  const supabase = await createSupabaseServiceClient();
  // ตารางใหม่ยังไม่อยู่ใน database.types — cast เฉพาะจุดที่บันทึก delivery state
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const table = supabase.from("daily_summary_email_log") as any;
  const { error } = await table
    .update({
      delivery_status: input.delivered ? "sent" : "failed",
      last_error: input.errorMessage ?? null,
      completed_at: new Date().toISOString(),
    })
    .eq("organization_id", input.organizationId)
    .eq("summary_date", input.day)
    .eq("delivery_status", "claimed");
  if (error) throw error;
}

/** ส่งอีเมลสรุปให้ทุกองค์กรที่มีออเดอร์เมื่อวาน — ไม่ throw: องค์กรหนึ่งพังต้องไม่ล้มทั้งงาน */
export async function runDailySummaryEmails(now: Date = new Date()): Promise<DailySummaryEmailResult> {
  const startedAt = Date.now();
  const day = previousLocalDate(now, "Asia/Bangkok");

  if (!isEmailConfigured()) {
    // เส้นทาง "สำเร็จแบบเงียบ" — ต้องมีร่องรอย ไม่งั้นเข้าใจว่าส่งแล้วทั้งที่ไม่มีอีเมลออกเลย
    await logSystemEvent({
      level: "warn",
      source: SOURCE,
      action: "runDailySummaryEmails",
      message: "ข้ามการส่งสรุปรายวัน: ยังไม่ได้ตั้งค่าอีเมล (Resend)",
      context: { day },
    });
    return { day, scannedOrganizations: 0, sent: 0, skipped: 0, failed: 0 };
  }

  const supabase = await createSupabaseServiceClient();
  let stores: StoreRow[];
  let organizations: OrganizationRow[];
  try {
    [stores, organizations] = await Promise.all([
      loadAllRows<StoreRow>((from, to) =>
        supabase
          .from("stores")
          .select("id, organization_id, name, timezone, daily_summary_email_enabled")
          .eq("is_active", true)
          .order("id", { ascending: true })
          .range(from, to),
      QUERY_PAGE_SIZE),
      loadAllRows<OrganizationRow>((from, to) =>
        supabase
          .from("organizations")
          .select("id, name, owner_id, suspended_at")
          .order("id", { ascending: true })
          .range(from, to),
      QUERY_PAGE_SIZE),
    ]);
  } catch (error) {
    logActionError({
      source: SOURCE,
      action: "loadStores",
      error,
    });
    return { day, scannedOrganizations: 0, sent: 0, skipped: 0, failed: 1 };
  }

  const storesByOrg = new Map<string, StoreRow[]>();
  for (const row of stores) {
    // ร้านที่เจ้าของปิดสวิตช์อีเมลสรุปไว้ ไม่ต้องนับเข้าไปตั้งแต่ต้น
    if (row.daily_summary_email_enabled === false) continue;
    const list = storesByOrg.get(row.organization_id) ?? [];
    list.push(row);
    storesByOrg.set(row.organization_id, list);
  }

  let sent = 0;
  let skipped = 0;
  let failed = 0;
  let scanned = 0;

  for (const org of organizations) {
    const stores = storesByOrg.get(org.id) ?? [];
    if (stores.length === 0) continue;
    if (org.suspended_at) {
      skipped += 1;
      continue;
    }
    scanned += 1;

    let claimAcquired = false;
    let deliveryFinalized = false;
    let providerOutcome: "unknown" | "sent" | "failed" = "unknown";
    try {
      const summaries: StoreDailySummary[] = [];
      for (const store of stores) {
        const timezone = store.timezone || "Asia/Bangkok";
        const storeDay = previousLocalDate(now, timezone);
        const summary = await loadStoreDailySummary({
          storeId: store.id,
          organizationId: org.id,
          storeName: store.name,
          date: storeDay,
          timezone,
        });
        if (summary) {
          summaries.push(summary);
        }
      }

      // หัวใจของโจทย์: ไม่มีออเดอร์เมื่อวาน = ไม่ส่งอีเมล
      if (summaries.length === 0) {
        skipped += 1;
        continue;
      }

      const totals = totalsOfStores(summaries);
      const email = await resolveOwnerEmail(org.owner_id);
      if (!email) {
        skipped += 1;
        await logSystemEvent({
          level: "warn",
          source: SOURCE,
          action: "resolveOwnerEmail",
          message: "ข้ามอีเมลสรุปรายวัน: หาอีเมลเจ้าขององค์กรไม่เจอ",
          organizationId: org.id,
          context: { day },
        });
        continue;
      }

      const claimed = await claimDailySummary(org.id, day, {
        storeCount: summaries.length,
        orderCount: totals.orderCount,
        revenue: totals.revenue,
      });
      if (!claimed) {
        skipped += 1;
        continue;
      }
      claimAcquired = true;

      const summary: OrganizationDailySummary = {
        organizationId: org.id,
        organizationName: org.name,
        date: day,
        stores: summaries,
        orderCount: totals.orderCount,
        revenue: totals.revenue,
      };
      const content = buildDailySummaryEmail(summary);
      const result = await sendTransactionalEmail({
        to: email,
        subject: content.subject,
        html: content.html,
        text: content.text,
      });

      if (result.ok && !result.skipped) {
        providerOutcome = "sent";
        sent += 1;
        try {
          await completeDailySummaryEmail({ organizationId: org.id, day, delivered: true });
          deliveryFinalized = true;
        } catch (stateError) {
          // ผู้ให้บริการตอบว่าส่งแล้ว ห้าม downgrade เป็น failed เพราะจะเปิดทางให้ส่งซ้ำ
          logActionError({ source: SOURCE, action: "completeDailySummaryEmail", error: stateError, organizationId: org.id });
        }
        await logSystemEvent({
          level: "info",
          source: SOURCE,
          action: "sendDailySummary",
          message: `ส่งอีเมลสรุปรายวันแล้ว · ${totals.orderCount} บิล · ${totals.revenue} บาท`,
          organizationId: org.id,
          context: { day, stores: summaries.length },
        });
      } else {
        providerOutcome = "failed";
        failed += 1;
        try {
          await completeDailySummaryEmail({ organizationId: org.id, day, delivered: false, errorMessage: result.message });
          deliveryFinalized = true;
        } catch (stateError) {
          logActionError({ source: SOURCE, action: "completeDailySummaryEmail", error: stateError, organizationId: org.id });
        }
        await logSystemEvent({
          level: "error",
          source: SOURCE,
          action: "sendDailySummary",
          message: `ส่งอีเมลสรุปรายวันไม่สำเร็จ: ${result.message}`,
          organizationId: org.id,
          context: { day, detail: result.detail ?? null },
        });
      }
    } catch (error) {
      if (providerOutcome === "sent" && !deliveryFinalized) {
        logActionError({ source: SOURCE, action: "dailySummaryDeliveryStatePending", error, organizationId: org.id });
      }
      if (claimAcquired && providerOutcome === "unknown") {
        // timeout/exception หลัง claim = provider outcome ไม่แน่ใจ จึงค้าง claimed เพื่อไม่เสี่ยงส่งซ้ำ
        logActionError({ source: SOURCE, action: "dailySummaryDeliveryOutcomeUnknown", error, organizationId: org.id });
      }
      if (providerOutcome !== "sent") failed += 1;
      logActionError({ source: SOURCE, action: "runDailySummaryEmails", error, organizationId: org.id });
    }
  }

  await logSystemEvent({
    level: failed > 0 ? "warn" : "info",
    source: SOURCE,
    action: "runDailySummaryEmails",
    message: `สรุปรายวัน: ส่ง ${sent} องค์กร · ข้าม ${skipped} · ล้มเหลว ${failed}`,
    durationMs: Date.now() - startedAt,
    context: { day },
  });

  return { day, scannedOrganizations: scanned, sent, skipped, failed };
}
