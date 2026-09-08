import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isLoyaltyLedgerType, LOYALTY_LEDGER_TYPES } from "@/modules/loyalty/stats-repository";

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");
const section = (source: string, start: string, end?: string) => {
  const startIndex = source.indexOf(start);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  const endIndex = end ? source.indexOf(end, startIndex + start.length) : -1;
  return source.slice(startIndex, endIndex >= 0 ? endIndex : undefined);
};

describe("loyalty ledger type guard", () => {
  it("accepts only the four ledger types the database writes", () => {
    expect(LOYALTY_LEDGER_TYPES).toEqual(["earn", "redeem", "reversal", "adjustment"]);
    for (const type of LOYALTY_LEDGER_TYPES) expect(isLoyaltyLedgerType(type)).toBe(true);
    expect(isLoyaltyLedgerType("claim")).toBe(false);
    expect(isLoyaltyLedgerType("")).toBe(false);
    expect(isLoyaltyLedgerType(null)).toBe(false);
    expect(isLoyaltyLedgerType(undefined)).toBe(false);
  });
});

describe("loyalty points stats migration", () => {
  const sql = read("supabase/migrations/20260908000000_loyalty_points_stats.sql");

  it("adds the aggregate functions the dashboard reads", () => {
    expect(sql).toContain("create or replace function public.get_loyalty_points_summary");
    expect(sql).toContain("create or replace function public.get_loyalty_points_daily");
    expect(sql).toContain("create or replace function public.get_loyalty_top_customers");
    expect(sql).toContain("create or replace function public.get_loyalty_points_outstanding");
    // อ่านอย่างเดียวและต้องเคารพ RLS ของผู้เรียก ห้าม security definer
    expect(sql).not.toContain("security definer");
    expect((sql.match(/security invoker/g) ?? []).length).toBe(4);
    expect((sql.match(/^\s*stable$/gm) ?? []).length).toBe(4);
  });

  it("keeps an index for store-wide time range scans", () => {
    expect(sql).toContain("loyalty_ledger_store_created_idx");
    expect(sql).toContain("on loyalty_ledger(store_id, created_at desc)");
  });

  it("reports redeemed points as a positive number because redeem deltas are negative", () => {
    const summary = section(sql, "create or replace function public.get_loyalty_points_summary", "-- 2)");
    expect(summary).toContain("sum(points_delta) filter (where type = 'earn')");
    expect(summary).toContain("-sum(points_delta) filter (where type = 'redeem')");
    // reversal/adjustment มีทั้งบวกและลบ จึงต้องคืนค่าสุทธิแบบมีเครื่องหมาย ห้ามกลับเครื่องหมาย
    expect(summary).toContain("sum(points_delta) filter (where type = 'reversal')");
    expect(summary).not.toContain("-sum(points_delta) filter (where type = 'reversal')");
    expect(summary).not.toContain("-sum(points_delta) filter (where type = 'adjustment')");
  });

  it("buckets the daily breakdown in the store timezone, not UTC", () => {
    const daily = section(sql, "create or replace function public.get_loyalty_points_daily", "-- 3)");
    expect(daily).toContain("(created_at at time zone p_timezone)::date");
  });

  it("scopes every function to one store and clamps the top-customer limit", () => {
    expect((sql.match(/store_id = p_store_id/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(sql).toContain("l.store_id = p_store_id");
    expect(sql).toContain("limit greatest(least(coalesce(p_limit, 10), 50), 1)");
    expect((sql.match(/grant execute on function public\.get_loyalty_/g) ?? []).length).toBe(4);
  });
});

describe("loyalty stats repository", () => {
  const repo = read("src/modules/loyalty/stats-repository.ts");

  it("calls the aggregate RPCs instead of pulling the whole ledger into node", () => {
    expect(repo).toContain('supabase.rpc("get_loyalty_points_summary"');
    expect(repo).toContain('supabase.rpc("get_loyalty_points_daily"');
    expect(repo).toContain('supabase.rpc("get_loyalty_top_customers"');
    expect(repo).toContain('supabase.rpc("get_loyalty_points_outstanding"');
  });

  it("converts the requested days with the store timezone helper used by bill history", () => {
    expect(repo).toContain("getStoreLocalDateRangeUtc");
    expect(repo).toContain("range.timezone || DEFAULT_TIME_ZONE");
    // โซนเวลาที่ Postgres ไม่รู้จักทำให้ทั้ง query พัง จึงต้องกรองก่อนส่งเข้า RPC
    expect(repo).toContain("p_timezone: safeTimezone(range.timezone)");
    expect(section(repo, "function safeTimezone")).toContain("return DEFAULT_TIME_ZONE;");
  });

  it("clamps page size and offset of the store-wide feed", () => {
    const feed = section(repo, "export async function listStoreLoyaltyLedger");
    expect(feed).toContain("Math.min(Math.max(Math.floor(options.limit ?? 50), 1), 200)");
    expect(feed).toContain("Math.min(Math.max(Math.floor(options.offset ?? 0), 0), 10_000)");
    expect(feed).toContain('.eq("store_id", storeId)');
    expect(feed).toContain('{ count: "exact" }');
  });

  it("resolves customer names and bill numbers in batches scoped to the store", () => {
    const feed = section(repo, "export async function listStoreLoyaltyLedger");
    expect(feed).toContain('.from("customers").select("id, name").eq("store_id", storeId).in("id", customerIds)');
    expect(feed).toContain('.from("orders").select("id, order_number").eq("store_id", storeId).in("id", orderIds)');
  });
});

describe("loyalty stats page", () => {
  const page = read("src/app/(dashboard)/customers/stats/page.tsx");
  const view = read("src/app/(dashboard)/customers/stats/LoyaltyPointsStatsView.tsx");
  const actions = read("src/app/(dashboard)/customers/stats/actions.ts");
  const manager = read("src/app/(dashboard)/customers/CustomerLoyaltyManager.tsx");

  it("gates on the same permission and package feature as the customers page", () => {
    expect(page).toContain('resolved.can("catalog.manage")');
    expect(page).toContain("features.loyaltyPoints");
    expect(page).toContain("getPlanFeatures");
  });

  it("defaults to the current month in the store timezone and rejects bogus dates", () => {
    expect(page).toContain("getStoreLocalDate(ctx.storeTimezone)");
    expect(page).toContain("isValidDate");
    expect(page).toContain("MAX_RANGE_DAYS");
    expect(page).toContain("if (dateFrom > dateTo)");
  });

  it("logs every view and every CSV export so nothing succeeds silently", () => {
    expect(page).toContain("logSystemEvent");
    expect(page).toContain('source: "loyalty.stats"');
    expect(page).toContain('level: errors.length ? "warn" : "info"');
    expect(actions).toContain("logLoyaltyStatsExportAction");
    expect(actions).toContain('requirePermission("catalog.manage")');
    expect(actions).toContain('requireFeature("loyaltyPoints")');
    expect(actions).toContain("logSystemEvent");
  });

  it("shows the numbers the shop asks for and links back from the customers page", () => {
    expect(view).toContain("แต้มที่แจก");
    expect(view).toContain("แต้มที่ลูกค้าใช้");
    expect(view).toContain("แต้มคงค้างทั้งร้าน");
    expect(view).toContain("ลูกค้าที่เคลื่อนไหว");
    expect(view).toContain("รายการแต้มล่าสุด");
    expect(view).toContain("ส่งออก CSV");
    expect(manager).toContain('href="/customers/stats"');
    expect(manager).toContain("สถิติแต้ม");
  });

  it("resets paging when filters change so the feed never lands on an empty page", () => {
    const apply = section(view, "function applyFilters()", "function goToOffset");
    expect(apply).toContain("offset: 0");
  });
});

describe("per-customer points history", () => {
  const actions = read("src/app/(dashboard)/customers/actions.ts");
  const repository = read("src/modules/loyalty/repository.ts");
  const panel = read("src/app/(dashboard)/customers/CustomerLedgerPanel.tsx");

  it("lets managers open the history — catalog.manage, not settings.manage_store", () => {
    const ledgerAction = section(actions, "export async function loadCustomerLedgerAction", "export async function saveRewardAction");
    expect(ledgerAction).toContain('requirePermission("catalog.manage")');
    expect(ledgerAction).not.toContain('requirePermission("settings.manage_store")');
    expect(ledgerAction).toContain('requireFeature("loyaltyPoints")');
  });

  it("shows which bill each entry came from", () => {
    const ledgerQuery = section(
      repository,
      "export async function listLoyaltyLedgerForCustomer",
      "export interface LoyaltyLedgerEntry",
    );
    expect(ledgerQuery).toContain('.select("id, order_number")');
    expect(ledgerQuery).toContain("orderNumber:");
    expect(repository).toContain("orderNumber: string | null;");
    expect(panel).toContain("entry.orderNumber");
  });
});
