/**
 * สถิติแต้มลูกค้าทั้งร้าน — อ่าน loyalty_ledger แบบรวมยอด
 *
 * เดิม ledger ถูกอ่านที่เดียวคือประวัติรายคน (repository.listLoyaltyLedgerForCustomer)
 * ร้านจึงตอบไม่ได้ว่าเดือนนี้แจกแต้มไปเท่าไร ลูกค้าเอาไปใช้จริงกี่แต้ม และเหลือแต้ม
 * ค้างในระบบเท่าไร — ที่นี่รวมยอดฝั่ง DB (RPC) ไม่ดึง ledger ทั้งร้านมานับใน Node
 *
 * ช่วงเวลาเป็นวันที่ตามโซนเวลาร้านเสมอ แล้วแปลงเป็น UTC ด้วย getStoreLocalDateRangeUtc
 * ตัวเดียวกับที่ประวัติบิล POS ใช้ (ไม่งั้นยอด "วันนี้" ของร้านไทยจะเริ่มตอน 07:00)
 */
import { createSupabaseServerClient } from "@/server/integrations/supabase/server";
import { getStoreLocalDateRangeUtc } from "@/modules/pos/order-repository";
import { mapError } from "@/shared/utils/error";
import { DEFAULT_TIME_ZONE } from "@/shared/utils/datetime";

export type LoyaltyLedgerType = "earn" | "redeem" | "reversal" | "adjustment";

export const LOYALTY_LEDGER_TYPES: readonly LoyaltyLedgerType[] = [
  "earn",
  "redeem",
  "reversal",
  "adjustment",
];

export interface LoyaltyPointsSummary {
  /** แต้มที่แจกให้ลูกค้า (บวกเสมอ) */
  earnedPoints: number;
  /** แต้มที่ลูกค้าใช้ไป แสดงเป็นเลขบวกเพื่ออ่านง่าย */
  redeemedPoints: number;
  /** ผลสุทธิของการกลับรายการ (ยกเลิกบิล) — ติดลบเมื่อดึงแต้มคืนจากลูกค้า */
  reversalPoints: number;
  /** ผลสุทธิของการปรับมือโดยพนักงาน */
  adjustmentPoints: number;
  /** แต้มในระบบเปลี่ยนไปสุทธิเท่าไรในช่วงนี้ */
  netPoints: number;
  earnCount: number;
  redeemCount: number;
  reversalCount: number;
  adjustmentCount: number;
  entryCount: number;
  /** จำนวนลูกค้าที่มีความเคลื่อนไหวแต้มในช่วงนี้ */
  activeCustomerCount: number;
}

export interface LoyaltyPointsDaily {
  date: string;
  earnedPoints: number;
  redeemedPoints: number;
  reversalPoints: number;
  adjustmentPoints: number;
  netPoints: number;
  entryCount: number;
}

export interface LoyaltyTopCustomer {
  customerId: string;
  customerName: string;
  phone: string | null;
  earnedPoints: number;
  redeemedPoints: number;
  netPoints: number;
  entryCount: number;
  pointsBalance: number;
}

export interface LoyaltyPointsOutstanding {
  /** แต้มคงค้างทั้งร้าน = ภาระผูกพันที่ลูกค้ายังเอามาแลกได้ */
  outstandingPoints: number;
  memberCount: number;
  membersWithPoints: number;
}

export interface StoreLoyaltyLedgerEntry {
  id: string;
  type: LoyaltyLedgerType;
  pointsDelta: number;
  reason: string | null;
  orderId: string | null;
  orderNumber: string | null;
  customerId: string;
  customerName: string;
  createdAt: string;
}

export interface LoyaltyStatsRange {
  dateFrom: string;
  dateTo: string;
  timezone?: string;
}

const EMPTY_SUMMARY: LoyaltyPointsSummary = {
  earnedPoints: 0,
  redeemedPoints: 0,
  reversalPoints: 0,
  adjustmentPoints: 0,
  netPoints: 0,
  earnCount: 0,
  redeemCount: 0,
  reversalCount: 0,
  adjustmentCount: 0,
  entryCount: 0,
  activeCustomerCount: 0,
};

function toNumber(value: number | string | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function rangeToUtc(range: LoyaltyStatsRange) {
  return getStoreLocalDateRangeUtc(range.dateFrom, range.dateTo, range.timezone || DEFAULT_TIME_ZONE);
}

/**
 * โซนเวลาถูกส่งเข้าไปเป็นสตริงใน SQL (`at time zone`) — ค่าที่ Postgres ไม่รู้จักจะทำให้
 * ทั้ง query พังทันที ต่างจาก getStoreLocalDateRangeUtc ที่ fallback ให้เงียบ ๆ
 */
function safeTimezone(timezone: string | undefined): string {
  const candidate = timezone || DEFAULT_TIME_ZONE;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidate });
    return candidate;
  } catch {
    return DEFAULT_TIME_ZONE;
  }
}

export function isLoyaltyLedgerType(value: string | null | undefined): value is LoyaltyLedgerType {
  return LOYALTY_LEDGER_TYPES.includes((value ?? "") as LoyaltyLedgerType);
}

export async function getLoyaltyPointsSummary(storeId: string, range: LoyaltyStatsRange) {
  const supabase = await createSupabaseServerClient();
  const { startUtc, endUtc } = rangeToUtc(range);
  const { data, error } = await supabase.rpc("get_loyalty_points_summary", {
    p_store_id: storeId,
    p_from: startUtc,
    p_to: endUtc,
  });
  if (error) return { data: null, error: mapError(error) };

  const row = Array.isArray(data) ? data[0] : null;
  if (!row) return { data: EMPTY_SUMMARY, error: null };
  return {
    data: {
      earnedPoints: toNumber(row.earned_points),
      redeemedPoints: toNumber(row.redeemed_points),
      reversalPoints: toNumber(row.reversal_points),
      adjustmentPoints: toNumber(row.adjustment_points),
      netPoints: toNumber(row.net_points),
      earnCount: toNumber(row.earn_count),
      redeemCount: toNumber(row.redeem_count),
      reversalCount: toNumber(row.reversal_count),
      adjustmentCount: toNumber(row.adjustment_count),
      entryCount: toNumber(row.entry_count),
      activeCustomerCount: toNumber(row.active_customer_count),
    } satisfies LoyaltyPointsSummary,
    error: null,
  };
}

export async function listLoyaltyPointsDaily(storeId: string, range: LoyaltyStatsRange) {
  const supabase = await createSupabaseServerClient();
  const { startUtc, endUtc } = rangeToUtc(range);
  const { data, error } = await supabase.rpc("get_loyalty_points_daily", {
    p_store_id: storeId,
    p_from: startUtc,
    p_to: endUtc,
    p_timezone: safeTimezone(range.timezone),
  });
  if (error) return { data: null, error: mapError(error) };

  return {
    data: (data ?? []).map((row) => ({
      date: row.date,
      earnedPoints: toNumber(row.earned_points),
      redeemedPoints: toNumber(row.redeemed_points),
      reversalPoints: toNumber(row.reversal_points),
      adjustmentPoints: toNumber(row.adjustment_points),
      netPoints: toNumber(row.net_points),
      entryCount: toNumber(row.entry_count),
    })) satisfies LoyaltyPointsDaily[],
    error: null,
  };
}

export async function listLoyaltyTopCustomers(
  storeId: string,
  range: LoyaltyStatsRange,
  options: { limit?: number } = {},
) {
  const supabase = await createSupabaseServerClient();
  const { startUtc, endUtc } = rangeToUtc(range);
  const safeLimit = Math.min(Math.max(Math.floor(options.limit ?? 10), 1), 50);
  const { data, error } = await supabase.rpc("get_loyalty_top_customers", {
    p_store_id: storeId,
    p_from: startUtc,
    p_to: endUtc,
    p_limit: safeLimit,
  });
  if (error) return { data: null, error: mapError(error) };

  return {
    data: (data ?? []).map((row) => ({
      customerId: row.customer_id,
      customerName: row.customer_name,
      phone: row.phone,
      earnedPoints: toNumber(row.earned_points),
      redeemedPoints: toNumber(row.redeemed_points),
      netPoints: toNumber(row.net_points),
      entryCount: toNumber(row.entry_count),
      pointsBalance: toNumber(row.points_balance),
    })) satisfies LoyaltyTopCustomer[],
    error: null,
  };
}

export async function getLoyaltyPointsOutstanding(storeId: string) {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("get_loyalty_points_outstanding", {
    p_store_id: storeId,
  });
  if (error) return { data: null, error: mapError(error) };

  const row = Array.isArray(data) ? data[0] : null;
  return {
    data: {
      outstandingPoints: toNumber(row?.outstanding_points),
      memberCount: toNumber(row?.member_count),
      membersWithPoints: toNumber(row?.members_with_points),
    } satisfies LoyaltyPointsOutstanding,
    error: null,
  };
}

/**
 * ฟีดรายการแต้มล่าสุดของทั้งร้าน — ชื่อลูกค้าและเลขบิลดึงแยกเป็นชุด
 * (ไม่ embed ผ่าน PostgREST เพราะ loyalty_ledger มี FK ไป customers หลายเส้นทาง
 * การอ้าง relation จึงกำกวมและพังง่ายเวลาชื่อ constraint เปลี่ยน)
 */
export async function listStoreLoyaltyLedger(
  storeId: string,
  range: LoyaltyStatsRange,
  options: { limit?: number; offset?: number; type?: LoyaltyLedgerType | null } = {},
) {
  const supabase = await createSupabaseServerClient();
  const { startUtc, endUtc } = rangeToUtc(range);
  const safeLimit = Math.min(Math.max(Math.floor(options.limit ?? 50), 1), 200);
  const safeOffset = Math.min(Math.max(Math.floor(options.offset ?? 0), 0), 10_000);

  let query = supabase
    .from("loyalty_ledger")
    .select("id, type, points_delta, reason, order_id, customer_id, created_at", { count: "exact" })
    .eq("store_id", storeId)
    .gte("created_at", startUtc)
    .lt("created_at", endUtc)
    .order("created_at", { ascending: false })
    .range(safeOffset, safeOffset + safeLimit - 1);
  if (options.type) query = query.eq("type", options.type);

  const { data, error, count } = await query;
  if (error) return { data: null, error: mapError(error), total: 0 };

  const rows = data ?? [];
  const customerIds = [...new Set(rows.map((row) => row.customer_id))];
  const orderIds = [...new Set(rows.map((row) => row.order_id).filter((id): id is string => Boolean(id)))];

  const [customersRes, ordersRes] = await Promise.all([
    customerIds.length
      ? supabase.from("customers").select("id, name").eq("store_id", storeId).in("id", customerIds)
      : Promise.resolve({ data: [], error: null }),
    orderIds.length
      ? supabase.from("orders").select("id, order_number").eq("store_id", storeId).in("id", orderIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (customersRes.error) return { data: null, error: mapError(customersRes.error), total: 0 };
  if (ordersRes.error) return { data: null, error: mapError(ordersRes.error), total: 0 };

  const nameById = new Map((customersRes.data ?? []).map((row) => [row.id, row.name]));
  const orderNumberById = new Map((ordersRes.data ?? []).map((row) => [row.id, row.order_number]));

  return {
    data: rows.map((row) => ({
      id: row.id,
      type: row.type as LoyaltyLedgerType,
      pointsDelta: toNumber(row.points_delta),
      reason: row.reason,
      orderId: row.order_id,
      orderNumber: row.order_id ? orderNumberById.get(row.order_id) ?? null : null,
      customerId: row.customer_id,
      customerName: nameById.get(row.customer_id) ?? "ลูกค้าถูกลบ",
      createdAt: row.created_at,
    })) satisfies StoreLoyaltyLedgerEntry[],
    error: null,
    total: count ?? 0,
  };
}
