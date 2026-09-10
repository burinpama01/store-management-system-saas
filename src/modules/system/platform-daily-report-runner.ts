/**
 * โหลดข้อมูล + ส่งรายงานสรุปรายวันถึงผู้ดูแลแพลตฟอร์ม
 *
 * แยกจาก platform-daily-report.ts (ตรรกะบริสุทธิ์) เพราะไฟล์นี้แตะฐานข้อมูลด้วย service client
 * ใช้สองที่: cron รายวัน (ส่งอีเมล) และหน้า /system (แสดงตัวเลขชุดเดียวกันบนจอ)
 * เข้าถึงได้เฉพาะหลัง requireSystemAccess() เท่านั้น — ข้อมูลนี้ข้าม tenant ทั้งหมด
 */
import { createSupabaseServiceClient } from "@/server/integrations/supabase/server";
import { storeDateTimeToUtc } from "@/shared/utils/datetime";
import { loadAllRows } from "@/modules/reports/pagination";
import { notifyPlatformAdmin } from "./admin-alert";
import { logActionError, logSystemEvent } from "./event-log";
import {
  buildPlatformDailyDigest,
  type PlatformDailyReport,
  type PlatformDailyTenant,
} from "./platform-daily-report";

const SOURCE = "system.daily-report";
const TIME_ZONE = "Asia/Bangkok";
const ACTIVE_WINDOW_DAYS = 7;
const DORMANT_WINDOW_DAYS = 14;
const RECENT_TENANT_LIMIT = 5;
const QUERY_PAGE_SIZE = 1000;

/** วันตามเวลาไทยในรูป YYYY-MM-DD */
export function bangkokDay(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function addDays(day: string, delta: number): string {
  const value = new Date(`${day}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + delta);
  return value.toISOString().slice(0, 10);
}

/** ต้นวันตามเวลาไทยในรูป UTC ISO — ใช้เป็นค่ากรองที่ส่งให้ PostgREST */
function startOfBangkokDay(day: string): string {
  return storeDateTimeToUtc(`${day}T00:00`, TIME_ZONE) ?? `${day}T00:00:00.000Z`;
}

/**
 * เทียบเวลาด้วยตัวเลขเสมอ ห้ามเทียบสตริง ISO ตรง ๆ:
 * Postgres คืน "…+00:00" แต่ค่าที่เราสร้างเองลงท้าย "Z" — เทียบสตริงจะเพี้ยนที่ขอบวินาที
 */
function ms(iso: string | null | undefined): number {
  if (!iso) return Number.NaN;
  return Date.parse(iso);
}

interface OrderAggregate {
  orderCount7d: number;
  revenue7d: number;
  lastOrderAt: string | null;
  yesterdayCount: number;
  yesterdayRevenue: number;
}

async function loadOrderAggregates(input: {
  since: string;
  activeSince: string;
  yesterdayStart: string;
  yesterdayEnd: string;
}): Promise<Map<string, OrderAggregate>> {
  const supabase = await createSupabaseServiceClient();
  const byOrg = new Map<string, OrderAggregate>();

  const rows = await loadAllRows<{
    id: string;
    organization_id: string;
    paid_at: string | null;
    total: number | string | null;
  }>((from, to) =>
    supabase
      .from("orders")
      .select("id, organization_id, paid_at, total")
      .eq("status", "paid")
      .gte("paid_at", input.since)
      .order("paid_at", { ascending: false })
      .order("id", { ascending: false })
      .range(from, to),
  QUERY_PAGE_SIZE);

  for (const row of rows) {
    const paidAt = row.paid_at;
    if (!paidAt) continue;
    const current = byOrg.get(row.organization_id) ?? {
      orderCount7d: 0,
      revenue7d: 0,
      lastOrderAt: null,
      yesterdayCount: 0,
      yesterdayRevenue: 0,
    };
    const total = Number(row.total ?? 0);
    const paidAtMs = ms(paidAt);
    if (Number.isNaN(paidAtMs)) continue;
    if (!current.lastOrderAt || paidAtMs > ms(current.lastOrderAt)) current.lastOrderAt = paidAt;
    if (paidAtMs >= ms(input.activeSince)) {
      current.orderCount7d += 1;
      current.revenue7d = Math.round((current.revenue7d + total) * 100) / 100;
    }
    if (paidAtMs >= ms(input.yesterdayStart) && paidAtMs < ms(input.yesterdayEnd)) {
      current.yesterdayCount += 1;
      current.yesterdayRevenue = Math.round((current.yesterdayRevenue + total) * 100) / 100;
    }
    byOrg.set(row.organization_id, current);
  }

  return byOrg;
}

async function resolveOwnerEmails(ownerIds: string[]): Promise<Map<string, string | null>> {
  const supabase = await createSupabaseServiceClient();
  const emails = new Map<string, string | null>();
  await Promise.all(
    Array.from(new Set(ownerIds)).map(async (ownerId) => {
      try {
        const { data } = await supabase.auth.admin.getUserById(ownerId);
        emails.set(ownerId, data.user?.email ?? null);
      } catch {
        emails.set(ownerId, null);
      }
    }),
  );
  return emails;
}

/** รวมตัวเลขทั้งแพลตฟอร์มของวัน — ไม่ส่งอะไรออก ใช้ได้ทั้ง cron และหน้าจอ */
export async function loadPlatformDailyReport(now: Date = new Date()): Promise<PlatformDailyReport> {
  const supabase = await createSupabaseServiceClient();
  const today = bangkokDay(now);
  const yesterday = addDays(today, -1);
  const yesterdayStart = startOfBangkokDay(yesterday);
  const yesterdayEnd = startOfBangkokDay(today);
  const activeSince = startOfBangkokDay(addDays(today, -ACTIVE_WINDOW_DAYS));
  const dormantSince = startOfBangkokDay(addDays(today, -DORMANT_WINDOW_DAYS));

  const [orgs, subscriptions, membersRes] = await Promise.all([
    loadAllRows<{
      id: string;
      name: string;
      owner_id: string;
      created_at: string;
      suspended_at: string | null;
    }>((from, to) =>
      supabase
        .from("organizations")
        .select("id, name, owner_id, created_at, suspended_at")
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .range(from, to),
    QUERY_PAGE_SIZE),
    loadAllRows<{ organization_id: string; plan: string }>((from, to) =>
      supabase
        .from("subscriptions")
        .select("organization_id, plan")
        .order("organization_id", { ascending: true })
        .range(from, to),
    QUERY_PAGE_SIZE),
    supabase.from("memberships").select("id", { count: "exact", head: true }).gte("joined_at", activeSince),
  ]);
  if (membersRes.error) throw membersRes.error;

  const planByOrg = new Map(subscriptions.map((row) => [row.organization_id, row.plan]));
  const aggregates = await loadOrderAggregates({
    since: dormantSince,
    activeSince,
    yesterdayStart,
    yesterdayEnd,
  });

  const tenants: PlatformDailyTenant[] = orgs.map((org) => {
    const aggregate = aggregates.get(org.id);
    return {
      organizationId: org.id,
      name: org.name,
      plan: planByOrg.get(org.id) ?? "free",
      createdAt: org.created_at,
      orderCount7d: aggregate?.orderCount7d ?? 0,
      revenue7d: aggregate?.revenue7d ?? 0,
      lastOrderAt: aggregate?.lastOrderAt ?? null,
    };
  });
  const tenantById = new Map(tenants.map((tenant) => [tenant.organizationId, tenant]));

  const newTenants = tenants.filter(
    (tenant) => ms(tenant.createdAt) >= ms(yesterdayStart) && ms(tenant.createdAt) < ms(yesterdayEnd),
  );
  const newTenants7d = tenants.filter((tenant) => ms(tenant.createdAt) >= ms(activeSince)).length;
  const recentTenants = tenants.slice(0, RECENT_TENANT_LIMIT);
  const activeTenants = tenants
    .filter((tenant) => tenant.orderCount7d > 0)
    .sort((a, b) => b.revenue7d - a.revenue7d);
  // ร้านที่เพิ่งสมัครยังไม่ถือว่า "เงียบ" — ยังไม่ทันได้เริ่มขายด้วยซ้ำ
  const dormantTenants = tenants
    .filter((tenant) => tenant.lastOrderAt === null && ms(tenant.createdAt) < ms(dormantSince))
    .sort((a, b) => ms(a.createdAt) - ms(b.createdAt));

  const ownerIdByOrg = new Map(orgs.map((org) => [org.id, org.owner_id]));
  const ownerEmails = await resolveOwnerEmails(
    [...newTenants, ...recentTenants]
      .map((tenant) => ownerIdByOrg.get(tenant.organizationId))
      .filter((ownerId): ownerId is string => Boolean(ownerId)),
  );
  const withEmail = (tenant: PlatformDailyTenant): PlatformDailyTenant => {
    const ownerId = ownerIdByOrg.get(tenant.organizationId);
    return { ...tenant, ownerEmail: ownerId ? ownerEmails.get(ownerId) ?? null : null };
  };

  let yesterdayOrderCount = 0;
  let yesterdayRevenue = 0;
  let yesterdaySellingTenants = 0;
  for (const [organizationId, aggregate] of aggregates) {
    if (!tenantById.has(organizationId) || aggregate.yesterdayCount === 0) continue;
    yesterdayOrderCount += aggregate.yesterdayCount;
    yesterdayRevenue = Math.round((yesterdayRevenue + aggregate.yesterdayRevenue) * 100) / 100;
    yesterdaySellingTenants += 1;
  }

  return {
    today,
    yesterday,
    totalTenants: tenants.length,
    suspendedTenants: orgs.filter((org) => Boolean(org.suspended_at)).length,
    newTenants: newTenants.map(withEmail),
    newTenants7d,
    newMembers7d: membersRes.count ?? 0,
    recentTenants: recentTenants.map(withEmail),
    activeTenants,
    dormantTenants,
    yesterdayOrderCount,
    yesterdayRevenue,
    yesterdaySellingTenants,
  };
}

export interface PlatformDailyReportRunResult {
  readonly day: string;
  readonly emailed: boolean;
  readonly newTenants: number;
  readonly activeTenants: number;
  readonly dormantTenants: number;
}

/**
 * ส่งรายงานให้ผู้ดูแล — ส่งทุกวัน (ไม่ใช่เฉพาะวันที่มีร้านใกล้หมดอายุเหมือนของเดิม)
 * เพราะตอนนี้มันคือ "รายงานประจำวัน" จริง ๆ ไม่ใช่แค่ใบเตือนแพ็กเกจ
 */
export async function runPlatformDailyReport(
  now: Date = new Date(),
  subscriptionSection?: string | null,
): Promise<PlatformDailyReportRunResult> {
  const startedAt = Date.now();
  let report: PlatformDailyReport;
  try {
    report = await loadPlatformDailyReport(now);
  } catch (error) {
    logActionError({ source: SOURCE, action: "loadPlatformDailyReport", error });
    return { day: bangkokDay(now), emailed: false, newTenants: 0, activeTenants: 0, dormantTenants: 0 };
  }

  const result = await notifyPlatformAdmin({
    source: SOURCE,
    action: "dailyReport",
    level: "info",
    subject: `สรุปแพลตฟอร์มประจำวัน ${report.today}`,
    body: buildPlatformDailyDigest(report, subscriptionSection, now),
    context: {
      newTenants: report.newTenants.length,
      activeTenants: report.activeTenants.length,
      dormantTenants: report.dormantTenants.length,
      yesterdayRevenue: report.yesterdayRevenue,
    },
  });

  await logSystemEvent({
    level: "info",
    source: SOURCE,
    action: "runPlatformDailyReport",
    message: `รายงานผู้ดูแล: ใหม่ ${report.newTenants.length} · แอคทีฟ ${report.activeTenants.length} · เงียบ ${report.dormantTenants.length}`,
    durationMs: Date.now() - startedAt,
    context: { day: report.today, emailed: result.emailed },
  });

  return {
    day: report.today,
    emailed: result.emailed,
    newTenants: report.newTenants.length,
    activeTenants: report.activeTenants.length,
    dormantTenants: report.dormantTenants.length,
  };
}
