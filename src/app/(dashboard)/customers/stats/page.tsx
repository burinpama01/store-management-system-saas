import { redirect } from "next/navigation";
import Link from "next/link";
import { getResolvedCurrentPermissions } from "@/modules/auth/guards";
import { DEFAULT_BILLING_STATE, getPlanFeatures } from "@/modules/billing/types";
import { getOrganizationBillingState } from "@/modules/billing/billing-service";
import { getStoreLocalDate } from "@/modules/attendance/date";
import {
  getLoyaltyPointsOutstanding,
  getLoyaltyPointsSummary,
  isLoyaltyLedgerType,
  listLoyaltyPointsDaily,
  listLoyaltyTopCustomers,
  listStoreLoyaltyLedger,
} from "@/modules/loyalty/stats-repository";
import { logSystemEvent } from "@/modules/system/event-log";
import { LoyaltyPointsStatsView } from "./LoyaltyPointsStatsView";

export const dynamic = "force-dynamic";

const FEED_PAGE_SIZE = 50;
const MAX_RANGE_DAYS = 366;
const MS_PER_DAY = 86_400_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isValidDate(value: string): boolean {
  if (!DATE_RE.test(value) || Number.isNaN(Date.parse(value))) return false;
  // กันวันที่ที่ JS เลื่อนให้เอง (31 ก.พ. กลายเป็น 3 มี.ค.)
  return new Date(value).toISOString().startsWith(value);
}

export default async function LoyaltyStatsPage({
  searchParams,
}: {
  searchParams: Promise<{ dateFrom?: string; dateTo?: string; type?: string; offset?: string }>;
}) {
  const { ctx, resolved } = await getResolvedCurrentPermissions();
  // สิทธิ์เท่ากับหน้าลูกค้า — ผู้จัดการที่ดูแลลูกค้าอยู่แล้วต้องดูสถิติแต้มได้ด้วย
  if (!resolved.can("catalog.manage")) redirect("/dashboard");

  const billingState = (await getOrganizationBillingState(ctx.organizationId)) ?? DEFAULT_BILLING_STATE;
  const features = getPlanFeatures(billingState);

  const params = await searchParams;
  const today = getStoreLocalDate(ctx.storeTimezone);
  const monthStart = `${today.slice(0, 7)}-01`;
  let dateFrom = isValidDate(params.dateFrom ?? "") ? (params.dateFrom as string) : monthStart;
  let dateTo = isValidDate(params.dateTo ?? "") ? (params.dateTo as string) : today;
  if (dateFrom > dateTo) [dateFrom, dateTo] = [dateTo, dateFrom];
  if ((Date.parse(dateTo) - Date.parse(dateFrom)) / MS_PER_DAY > MAX_RANGE_DAYS) {
    dateTo = new Date(Date.parse(dateFrom) + MAX_RANGE_DAYS * MS_PER_DAY).toISOString().split("T")[0];
  }
  const typeFilter = isLoyaltyLedgerType(params.type) ? params.type : null;
  const parsedOffset = Number(params.offset ?? "0");
  const offset = Number.isFinite(parsedOffset) ? Math.min(Math.max(Math.floor(parsedOffset), 0), 10_000) : 0;

  if (!features.loyaltyPoints) {
    return (
      <div className="page-shell">
        <div className="page-header">
          <div>
            <h1 className="page-title">สถิติแต้มลูกค้า</h1>
            <p className="page-kicker">ภาพรวมแต้มที่แจก แต้มที่ลูกค้าใช้ และแต้มคงค้างของร้าน</p>
          </div>
        </div>
        <div className="panel p-6">
          <p className="text-sm text-[var(--muted)]">
            แพ็กเกจปัจจุบันยังไม่รองรับระบบสะสมแต้ม จึงยังไม่มีสถิติแต้มให้ดู
          </p>
          <Link className="btn-secondary mt-3 inline-flex" href="/settings/billing">
            ดูแพ็กเกจ
          </Link>
        </div>
      </div>
    );
  }

  const range = { dateFrom, dateTo, timezone: ctx.storeTimezone };
  const [summaryRes, dailyRes, topRes, outstandingRes, feedRes] = await Promise.all([
    getLoyaltyPointsSummary(ctx.storeId, range),
    listLoyaltyPointsDaily(ctx.storeId, range),
    listLoyaltyTopCustomers(ctx.storeId, range, { limit: 10 }),
    getLoyaltyPointsOutstanding(ctx.storeId),
    listStoreLoyaltyLedger(ctx.storeId, range, { limit: FEED_PAGE_SIZE, offset, type: typeFilter }),
  ]);

  const errors = [
    summaryRes.error?.userMessage,
    dailyRes.error?.userMessage,
    topRes.error?.userMessage,
    outstandingRes.error?.userMessage,
    feedRes.error?.userMessage,
  ].filter((message): message is string => Boolean(message));

  // กฎประจำโปรเจกต์: ฟีเจอร์ใหม่ห้าม "สำเร็จแบบเงียบ" — บันทึกทุกครั้งที่เปิดดู
  // จะได้ย้อนได้ว่าใครดูสถิติแต้มช่วงไหน และ RPC ตัวไหนพังตอนไหน
  await logSystemEvent({
    level: errors.length ? "warn" : "info",
    source: "loyalty.stats",
    action: "loyaltyPointsStatsPage",
    message: errors.length ? "เปิดสถิติแต้มลูกค้าแล้วมีบางส่วนโหลดไม่สำเร็จ" : "เปิดสถิติแต้มลูกค้า",
    organizationId: ctx.organizationId,
    storeId: ctx.storeId,
    actorUserId: ctx.userId,
    context: {
      dateFrom,
      dateTo,
      type: typeFilter,
      offset,
      entryCount: summaryRes.data?.entryCount ?? 0,
      feedTotal: feedRes.total,
      errors: errors.length ? errors : undefined,
    },
  });

  return (
    <LoyaltyPointsStatsView
      summary={summaryRes.data}
      daily={dailyRes.data ?? []}
      topCustomers={topRes.data ?? []}
      outstanding={outstandingRes.data}
      entries={feedRes.data ?? []}
      entryTotal={feedRes.total}
      pageSize={FEED_PAGE_SIZE}
      offset={offset}
      dateFrom={dateFrom}
      dateTo={dateTo}
      typeFilter={typeFilter}
      storeTimezone={ctx.storeTimezone}
      errors={errors}
    />
  );
}
