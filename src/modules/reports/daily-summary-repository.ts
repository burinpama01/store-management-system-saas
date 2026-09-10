/**
 * ดึงตัวเลขสรุปยอดของ "หนึ่งร้าน หนึ่งวัน" ตามเวลาของร้าน
 *
 * ใช้ service client ตั้งใจ เพราะผู้เรียกมี 2 แบบที่สิทธิ์ต่างกันมาก
 *   • cron (ไม่มีผู้ใช้เลย)
 *   • พนักงานกดออกงาน (role staff/cashier ซึ่ง RLS ไม่ให้อ่านรายงาน)
 * ผลลัพธ์ไม่ถูกส่งคืนให้ผู้เรียกที่หน้าจอ — ไหลออกทางอีเมล/LINE ของ "เจ้าของ" เท่านั้น
 * ทุก query จึงล็อกด้วย organization_id + store_id เสมอ ห้ามรับ storeId ลอย ๆ
 */
import { createSupabaseServiceClient } from "@/server/integrations/supabase/server";
import { storeDateTimeToUtc } from "@/shared/utils/datetime";
import { loadAllRows } from "./pagination";
import type {
  DailySummaryPaymentMethod,
  DailySummaryProduct,
  StoreDailySummary,
} from "./daily-summary";

/** PostgREST ส่ง .in() เป็น query string — ก้อนใหญ่เกินจะชนเพดาน URL */
const BATCH_SIZE = 200;
const QUERY_PAGE_SIZE = 1000;
const TOP_PRODUCT_LIMIT = 5;

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function toNumber(value: number | string | null | undefined): number {
  return Number(value ?? 0);
}

/** ช่วงเวลา UTC ที่ตรงกับ "หนึ่งวันตามนาฬิกาของร้าน" — 23:30 ของร้านต้องอยู่ในวันนั้น ไม่ใช่วันถัดไป */
export function storeDayWindowUtc(date: string, timezone: string): { startUtc: string; endUtc: string } | null {
  const startUtc = storeDateTimeToUtc(`${date}T00:00`, timezone);
  if (!startUtc) return null;
  const nextDay = new Date(`${date}T00:00:00.000Z`);
  nextDay.setUTCDate(nextDay.getUTCDate() + 1);
  const endUtc = storeDateTimeToUtc(`${nextDay.toISOString().slice(0, 10)}T00:00`, timezone);
  if (!endUtc) return null;
  return { startUtc, endUtc };
}

function aggregatePaymentMethods(
  rows: Array<{ method: string; amount: number | string | null }>,
): DailySummaryPaymentMethod[] {
  const byMethod = new Map<string, { count: number; amount: number }>();
  for (const row of rows) {
    const existing = byMethod.get(row.method) ?? { count: 0, amount: 0 };
    existing.count += 1;
    existing.amount = round2(existing.amount + toNumber(row.amount));
    byMethod.set(row.method, existing);
  }
  return Array.from(byMethod.entries())
    .map(([method, value]) => ({ method, ...value }))
    .sort((a, b) => b.amount - a.amount);
}

function aggregateTopProducts(
  rows: Array<{ product_name: string; quantity: number | string | null; total_price: number | string | null }>,
): DailySummaryProduct[] {
  const byName = new Map<string, { quantity: number; revenue: number }>();
  for (const row of rows) {
    const existing = byName.get(row.product_name) ?? { quantity: 0, revenue: 0 };
    existing.quantity += toNumber(row.quantity);
    existing.revenue = round2(existing.revenue + toNumber(row.total_price));
    byName.set(row.product_name, existing);
  }
  return Array.from(byName.entries())
    .map(([name, value]) => ({ name, ...value }))
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, TOP_PRODUCT_LIMIT);
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

export interface LoadStoreDailySummaryInput {
  readonly storeId: string;
  readonly organizationId: string;
  readonly storeName: string;
  /** YYYY-MM-DD ตามเวลาของร้าน */
  readonly date: string;
  readonly timezone: string;
}

export function requireExactCount(result: { count: number | null; error: unknown }): number {
  if (result.error) throw result.error;
  return result.count ?? 0;
}

/**
 * คืน null เมื่อร้านนี้ "ไม่มีออเดอร์ที่ปิดบิลในวันนั้น" — ผู้เรียกใช้ค่านี้เป็นตัวตัดสินว่าจะส่งหรือไม่ส่ง
 * (โจทย์คือส่งเฉพาะร้านที่มีออเดอร์ของวันนั้นเท่านั้น)
 */
export async function loadStoreDailySummary(
  input: LoadStoreDailySummaryInput,
): Promise<StoreDailySummary | null> {
  const window = storeDayWindowUtc(input.date, input.timezone);
  if (!window) return null;

  const supabase = await createSupabaseServiceClient();

  const [orders, voidedRes] = await Promise.all([
    loadAllRows<{
      id: string;
      total: number | string | null;
      qr_order_source: boolean | null;
      order_number: string | null;
    }>((from, to) =>
      supabase
        .from("orders")
        .select("id, total, qr_order_source, order_number")
        .eq("organization_id", input.organizationId)
        .eq("store_id", input.storeId)
        .eq("status", "paid")
        .gte("paid_at", window.startUtc)
        .lt("paid_at", window.endUtc)
        .order("id", { ascending: true })
        .range(from, to),
    QUERY_PAGE_SIZE),
    supabase
      .from("orders")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", input.organizationId)
      .eq("store_id", input.storeId)
      .in("status", ["voided", "refunded"])
      .gte("voided_at", window.startUtc)
      .lt("voided_at", window.endUtc),
  ]);

  if (voidedRes.error) throw voidedRes.error;
  if (orders.length === 0) return null;

  const revenue = round2(orders.reduce((sum, row) => sum + toNumber(row.total), 0));
  let posOrderCount = 0;
  let qrOrderCount = 0;
  let deliveryOrderCount = 0;
  for (const order of orders) {
    // ช่องทางเดียวกับที่หน้ารายงานใช้: QR = qr_order_source, เดลิเวอรี = เลขบิล JDC-
    if (order.qr_order_source === true) qrOrderCount += 1;
    else if (order.order_number?.startsWith("JDC-")) deliveryOrderCount += 1;
    else posOrderCount += 1;
  }

  const orderIds = orders.map((order) => order.id);
  const idChunks = chunk(orderIds, BATCH_SIZE);

  const [paymentBatches, itemBatches] = await Promise.all([
    Promise.all(
      idChunks.map((ids) =>
        loadAllRows<{ id: string; method: string; amount: number | string | null }>((from, to) =>
          supabase
            .from("payments")
            .select("id, method, amount")
            .in("order_id", ids)
            .eq("status", "completed")
            .order("id", { ascending: true })
            .range(from, to),
        QUERY_PAGE_SIZE),
      ),
    ),
    Promise.all(
      idChunks.map((ids) =>
        loadAllRows<{
          id: string;
          product_name: string;
          quantity: number | string | null;
          total_price: number | string | null;
        }>((from, to) =>
          supabase
            .from("order_items")
            .select("id, product_name, quantity, total_price")
            .in("order_id", ids)
            .order("id", { ascending: true })
            .range(from, to),
        QUERY_PAGE_SIZE),
      ),
    ),
  ]);

  const paymentRows = paymentBatches.flat();
  const itemRows = itemBatches.flat();

  return {
    storeId: input.storeId,
    storeName: input.storeName,
    date: input.date,
    orderCount: orders.length,
    revenue,
    avgOrderValue: round2(revenue / orders.length),
    posOrderCount,
    qrOrderCount,
    deliveryOrderCount,
    voidedCount: requireExactCount(voidedRes),
    paymentMethods: aggregatePaymentMethods(paymentRows),
    topProducts: aggregateTopProducts(itemRows),
  };
}
