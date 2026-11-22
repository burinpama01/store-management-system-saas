/**
 * สินค้าซื้อขาด/ฝากขาย — Supabase queries (เฟส C0–C4)
 * การเปลี่ยนแปลงทั้งหมดผ่าน RPC security definer ที่ตรวจ role + Enterprise + สวิตช์สาขาใน DB อีกชั้น
 * การอ่านใช้ client ของผู้ใช้ (RLS ระดับ manager)
 */
import { logSystemEvent } from "@/modules/system/event-log";
import { createSupabaseServerClient, createSupabaseServiceClient } from "@/server/integrations/supabase/server";
import type {
  ConsignPricing,
  DailyReportRow,
  LotAdjustKind,
  NeedsFlavorRow,
  PayoutMethod,
  ProductSourcingInput,
  ReceiveLine,
  ResaleLot,
  ResaleProduct,
  SettlementPreview,
  SettlementRow,
  SettleTrigger,
  SourcingMode,
  StockLevel,
} from "./types";

// คอลัมน์/RPC ใหม่ยังไม่อยู่ใน database.types (แบบเดียวกับ inventory/repository.ts)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LooseClient = any;

type Result<T> = { data: T; error: null } | { data: null; error: string };

const num = (value: unknown): number => (typeof value === "number" ? value : Number(value ?? 0));
const numOrNull = (value: unknown): number | null => (value === null || value === undefined ? null : num(value));

/** ข้อความจาก RPC → ภาษาไทย (ไม่ส่งข้อความ SQL ดิบขึ้นจอ) */
export function consignmentErrorMessage(raw: string | undefined | null): string {
  const message = raw ?? "";
  const map: Array<[string, string]> = [
    ["only owner/admin", "เปิด/ปิดได้เฉพาะเจ้าของหรือแอดมิน"],
    ["enterprise plan", "สินค้าซื้อขาด/ฝากขาย ใช้ได้เฉพาะแพ็กเกจ Enterprise"],
    ["not enabled for this store", "สาขานี้ยังไม่ได้เปิดระบบซื้อขาด/ฝากขาย"],
    ["manager role", "ต้องเป็นผู้จัดการขึ้นไป"],
    ["store not found", "ไม่พบสาขานี้"],
    ["product not found", "ไม่พบเมนูนี้"],
    ["supplier not found", "ไม่พบเจ้าของสินค้า (หรือปิดใช้งานอยู่)"],
    ["still has resale stock", "ยังมีของคงเหลือ — คืนเจ้าของหรือตัดของเสียให้หมดก่อนเปลี่ยนเป็นทำเอง"],
    ["cannot change owner or mode", "ยังมีของคงเหลือ — เปลี่ยนเจ้าของ/รูปแบบไม่ได้จนกว่าของจะหมด"],
    ["cannot change flavor group", "ยังมีของคงเหลือ — เปลี่ยนกลุ่มรสชาติไม่ได้จนกว่าของจะหมด"],
    ["uses variant stock", "เมนูนี้ใช้สต็อกแบบเดิม (นับสต็อก/Stock Pool) — ปิดก่อนจึงตั้งเป็นซื้อมาขายได้"],
    ["invalid consignment pricing", "เลือกวิธีคิดเงินกับเจ้าของ"],
    ["invalid store percent", "เปอร์เซ็นต์ของร้านต้องมากกว่า 0 และน้อยกว่า 100"],
    ["invalid unit cost", "ราคาต่อชิ้นไม่ถูกต้อง"],
    ["option group not found", "ไม่พบกลุ่มรสชาตินี้ในเมนู"],
    ["option not in flavor group", "รสที่เลือกไม่อยู่ในกลุ่มรสชาติของเมนู"],
    ["flavor is required", "เมนูนี้นับรายรส — ต้องเลือกรสทุกบรรทัด"],
    ["product does not belong to this owner", "มีเมนูที่ไม่ได้เป็นของเจ้าของรายนี้ หรือรูปแบบไม่ตรง"],
    ["duplicate line", "มีเมนู/รสซ้ำในรายการรับของ"],
    ["invalid quantity", "จำนวนต้องเป็นจำนวนเต็มมากกว่า 0"],
    ["invalid lines", "ยังไม่มีรายการรับของ"],
    ["invalid payout method", "เลือกจ่ายเงินสดหรือโอน"],
    ["settlement amount changed", "ยอดเปลี่ยนระหว่างนั้น (มีขายเพิ่ม/ยกเลิก) — โหลดยอดใหม่แล้วกดอีกครั้ง"],
    ["nothing to settle", "ไม่มียอดที่ต้องเคลียร์"],
    ["not enough stock in lot", "จำนวนมากกว่าของที่เหลือในล็อต"],
    ["only consignment lots", "ทำได้เฉพาะของฝากขาย"],
    ["lot not found", "ไม่พบล็อตนี้"],
    ["movement not found", "ไม่พบรายการนี้ (อาจเลือกรสไปแล้ว)"],
    ["nothing to assign", "รายการนี้ถูกยกเลิกไปแล้ว"],
    ["note too long", "หมายเหตุยาวเกินไป"],
    ["insufficient cash in drawer", "เงินสดในลิ้นชักไม่พอ — เลือกโอน หรือค้างไว้ก่อน"],
    ["cash session is not open", "ยังไม่ได้เปิดรอบเงินสด — เปิดรอบก่อน หรือเลือกโอน"],
    ["invalid date range", "ช่วงวันที่ไม่ถูกต้อง (ไม่เกิน 3 เดือน)"],
  ];
  for (const [needle, text] of map) if (message.includes(needle)) return text;
  return "บันทึกไม่สำเร็จ ลองใหม่อีกครั้ง";
}

export async function isConsignmentEnabled(storeId: string): Promise<boolean> {
  const db: LooseClient = await createSupabaseServiceClient();
  const { data, error } = await db.from("stores").select("consignment_enabled").eq("id", storeId).maybeSingle();
  if (error) {
    // ไม่ล้มทั้งหน้า (ถือว่าปิด) แต่ห้ามเงียบ — ทิ้ง log ให้ตามได้
    await logSystemEvent({
      level: "warn",
      source: "consignment",
      action: "isConsignmentEnabledFailed",
      message: `อ่านสวิตช์ฝากขายไม่สำเร็จ: ${error.message}`,
      storeId,
    }).catch(() => undefined);
    return false;
  }
  return data?.consignment_enabled === true;
}

export async function setConsignmentEnabled(storeId: string, enabled: boolean): Promise<Result<boolean>> {
  const db: LooseClient = await createSupabaseServerClient();
  const { data, error } = await db.rpc("consignment_set_enabled", { p_store_id: storeId, p_enabled: enabled });
  if (error) return { data: null, error: consignmentErrorMessage(error.message) };
  return { data: data === true, error: null };
}

/* eslint-disable @typescript-eslint/no-explicit-any -- แถวดิบจาก PostgREST */

/** เมนูทั้งหมดของสาขา + ช่องที่มาสินค้า + กลุ่มตัวเลือก (ไว้เลือกกลุ่มรส) */
export async function listResaleProducts(storeId: string): Promise<Result<ResaleProduct[]>> {
  const db: LooseClient = await createSupabaseServerClient();
  const { data, error } = await db
    .from("products")
    .select(
      "id, name, base_price, is_active, sourcing_mode, supplier_id, consign_pricing, consign_store_pct, resale_unit_cost, resale_option_group_id, product_variants(id, track_stock, variant_stock_links(variant_id)), modifier_groups(id, name, sort_order, modifier_options(id, name, price_adjustment, is_active, sort_order, resale_unit_cost))",
    )
    .eq("store_id", storeId)
    .order("name")
    .limit(1000);
  if (error) return { data: null, error: consignmentErrorMessage(error.message) };
  const byOrder = (a: any, b: any) => num(a.sort_order) - num(b.sort_order);
  return {
    data: (data ?? []).map((row: any) => ({
      id: row.id,
      name: row.name,
      basePrice: num(row.base_price),
      isActive: row.is_active === true,
      sourcingMode: (row.sourcing_mode ?? "made") as SourcingMode,
      supplierId: row.supplier_id ?? null,
      consignPricing: (row.consign_pricing ?? null) as ConsignPricing | null,
      consignStorePct: numOrNull(row.consign_store_pct),
      resaleUnitCost: numOrNull(row.resale_unit_cost),
      resaleOptionGroupId: row.resale_option_group_id ?? null,
      usesVariantStock: (row.product_variants ?? []).some(
        (v: any) => v.track_stock === true || (Array.isArray(v.variant_stock_links) ? v.variant_stock_links.length > 0 : !!v.variant_stock_links),
      ),
      groups: [...(row.modifier_groups ?? [])].sort(byOrder).map((g: any) => ({
        id: g.id,
        name: g.name,
        options: [...(g.modifier_options ?? [])].sort(byOrder).map((o: any) => ({
          id: o.id,
          name: o.name,
          priceAdjustment: num(o.price_adjustment),
          isActive: o.is_active === true,
          resaleUnitCost: numOrNull(o.resale_unit_cost),
        })),
      })),
    })),
    error: null,
  };
}

export async function saveProductSourcing(input: ProductSourcingInput): Promise<Result<{ mode: SourcingMode }>> {
  const db: LooseClient = await createSupabaseServerClient();
  const { data, error } = await db.rpc("consignment_save_product", {
    p_product_id: input.productId,
    p_settings: {
      mode: input.mode,
      supplierId: input.supplierId,
      pricing: input.pricing,
      storePct: input.storePct,
      unitCost: input.unitCost,
      optionGroupId: input.optionGroupId,
      optionCosts: input.optionCosts,
    },
  });
  if (error) return { data: null, error: consignmentErrorMessage(error.message) };
  return { data: { mode: (data?.mode ?? input.mode) as SourcingMode }, error: null };
}

export async function getStockLevels(storeId: string): Promise<Result<StockLevel[]>> {
  const db: LooseClient = await createSupabaseServerClient();
  const { data, error } = await db.rpc("consignment_stock_levels", { p_store_id: storeId });
  if (error) return { data: null, error: consignmentErrorMessage(error.message) };
  return {
    data: (data ?? []).map((r: any) => ({
      productId: r.product_id,
      optionId: r.option_id ?? null,
      onHand: num(r.on_hand),
      nearestExpiry: r.nearest_expiry ?? null,
    })),
    error: null,
  };
}

export async function listOpenLots(storeId: string): Promise<Result<ResaleLot[]>> {
  const db: LooseClient = await createSupabaseServerClient();
  const { data, error } = await db
    .from("resale_lots")
    .select("id, product_id, option_id, supplier_id, mode, qty_received, qty_remaining, unit_cost, expires_on, received_at")
    .eq("store_id", storeId)
    .gt("qty_remaining", 0)
    .order("received_at")
    .limit(1000);
  if (error) return { data: null, error: consignmentErrorMessage(error.message) };
  return {
    data: (data ?? []).map((r: any) => ({
      id: r.id,
      productId: r.product_id,
      optionId: r.option_id ?? null,
      supplierId: r.supplier_id,
      mode: r.mode,
      qtyReceived: num(r.qty_received),
      qtyRemaining: num(r.qty_remaining),
      unitCost: num(r.unit_cost),
      expiresOn: r.expires_on ?? null,
      receivedAt: r.received_at,
    })),
    error: null,
  };
}

export async function receiveLots(input: {
  supplierId: string;
  mode: "resale" | "consignment";
  lines: ReceiveLine[];
  expiresOn: string | null;
  note: string | null;
  paymentMethod: PayoutMethod | null;
}): Promise<Result<{ total: number; lotIds: string[]; transactionId: string | null }>> {
  const db: LooseClient = await createSupabaseServerClient();
  const { data, error } = await db.rpc("consignment_receive_lots", {
    p_supplier_id: input.supplierId,
    p_mode: input.mode,
    p_lines: input.lines,
    p_expires_on: input.expiresOn,
    p_note: input.note,
    p_payment_method: input.paymentMethod,
  });
  if (error) return { data: null, error: consignmentErrorMessage(error.message) };
  return { data: { total: num(data?.total), lotIds: data?.lotIds ?? [], transactionId: data?.transactionId ?? null }, error: null };
}

export async function listNeedsFlavor(storeId: string): Promise<Result<NeedsFlavorRow[]>> {
  const db: LooseClient = await createSupabaseServerClient();
  const { data, error } = await db
    .from("resale_movements")
    .select("id, product_id, qty, created_at")
    .eq("store_id", storeId)
    .eq("movement_type", "sale")
    .eq("needs_flavor", true)
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) return { data: null, error: consignmentErrorMessage(error.message) };
  const rows = data ?? [];
  if (rows.length === 0) return { data: [], error: null };
  const { data: restores, error: restoreError } = await db
    .from("resale_movements")
    .select("reverses_id, qty")
    .in("reverses_id", rows.map((r: any) => r.id));
  if (restoreError) return { data: null, error: consignmentErrorMessage(restoreError.message) };
  const restored = new Map<string, number>();
  for (const r of restores ?? []) restored.set(r.reverses_id, (restored.get(r.reverses_id) ?? 0) + num(r.qty));
  return {
    data: rows
      .map((r: any) => ({
        movementId: r.id,
        productId: r.product_id,
        qty: -num(r.qty) - (restored.get(r.id) ?? 0),
        createdAt: r.created_at,
      }))
      .filter((r: NeedsFlavorRow) => r.qty > 0),
    error: null,
  };
}

export async function assignFlavor(movementId: string, optionId: string): Promise<Result<number>> {
  const db: LooseClient = await createSupabaseServerClient();
  const { data, error } = await db.rpc("consignment_assign_flavor", { p_movement_id: movementId, p_option_id: optionId });
  if (error) return { data: null, error: consignmentErrorMessage(error.message) };
  return { data: num(data), error: null };
}

function mapPreview(p: any): SettlementPreview {
  return {
    supplierId: p.supplierId,
    name: p.name,
    payoutMethod: p.payoutMethod === "transfer" ? "transfer" : "cash",
    payoutAccount: p.payoutAccount ?? null,
    settleCycle: p.settleCycle === "daily" ? "daily" : "restock",
    lines: (p.lines ?? []).map((l: any) => ({
      productId: l.productId,
      optionId: l.optionId ?? null,
      qty: num(l.qty),
      gross: num(l.gross),
      due: num(l.due),
    })),
    qtySold: num(p.qtySold),
    grossSales: num(p.grossSales),
    ownerDue: num(p.ownerDue),
    clawback: num(p.clawback),
    carryIn: num(p.carryIn),
    total: num(p.total),
    pendingRows: num(p.pendingRows),
  };
}

/**
 * เจ้าของที่เคลียร์ "ทุกวัน" ของสาขา — ใช้ตอนปิดรอบเงินสด (แคชเชียร์อ่าน suppliers ผ่าน RLS ไม่ได้ จึงใช้ service client
 * และคืนแค่ id; ยอดเงินอ่านผ่าน RPC พรีวิวที่ตรวจสิทธิ์ cashier ใน DB อีกชั้น)
 */
export async function listDailyCycleSupplierIds(storeId: string): Promise<Result<string[]>> {
  const db: LooseClient = await createSupabaseServiceClient();
  const { data, error } = await db
    .from("suppliers")
    .select("id")
    .eq("store_id", storeId)
    .eq("is_active", true)
    .eq("settle_cycle", "daily")
    .limit(200);
  if (error) return { data: null, error: consignmentErrorMessage(error.message) };
  return { data: (data ?? []).map((r: { id: string }) => r.id), error: null };
}

export async function getSettlementPreview(supplierId: string): Promise<Result<SettlementPreview>> {
  const db: LooseClient = await createSupabaseServerClient();
  const { data, error } = await db.rpc("consignment_settlement_preview", { p_supplier_id: supplierId });
  if (error || !data) return { data: null, error: consignmentErrorMessage(error?.message) };
  return { data: mapPreview(data), error: null };
}

export async function settle(input: {
  supplierId: string;
  method: PayoutMethod;
  trigger: SettleTrigger;
  expectedTotal: number;
  note: string | null;
}): Promise<Result<{ settlementId: string; paid: number; carryOut: number }>> {
  const db: LooseClient = await createSupabaseServerClient();
  const { data, error } = await db.rpc("consignment_settle", {
    p_supplier_id: input.supplierId,
    p_method: input.method,
    p_trigger: input.trigger,
    p_expected_total: input.expectedTotal,
    p_note: input.note,
  });
  if (error) return { data: null, error: consignmentErrorMessage(error.message) };
  return { data: { settlementId: data?.settlementId, paid: num(data?.paid), carryOut: num(data?.carryOut) }, error: null };
}

export async function adjustLot(input: { lotId: string; kind: LotAdjustKind; qty: number; note: string | null }): Promise<Result<number>> {
  const db: LooseClient = await createSupabaseServerClient();
  const { data, error } = await db.rpc("consignment_adjust_lot", {
    p_lot_id: input.lotId,
    p_kind: input.kind,
    p_qty: input.qty,
    p_note: input.note,
  });
  if (error) return { data: null, error: consignmentErrorMessage(error.message) };
  return { data: num(data?.qtyRemaining), error: null };
}

export async function listSettlements(storeId: string, limit = 50): Promise<Result<SettlementRow[]>> {
  const db: LooseClient = await createSupabaseServerClient();
  const { data, error } = await db
    .from("consignment_settlements")
    .select("id, supplier_id, trigger_kind, qty_sold, gross_sales, owner_due, clawback, carry_in, carry_out, paid_amount, payout_method, settled_at")
    .eq("store_id", storeId)
    .order("settled_at", { ascending: false })
    .limit(limit);
  if (error) return { data: null, error: consignmentErrorMessage(error.message) };
  return {
    data: (data ?? []).map((r: any) => ({
      id: r.id,
      supplierId: r.supplier_id,
      triggerKind: r.trigger_kind,
      qtySold: num(r.qty_sold),
      grossSales: num(r.gross_sales),
      ownerDue: num(r.owner_due),
      clawback: num(r.clawback),
      carryIn: num(r.carry_in),
      carryOut: num(r.carry_out),
      paidAmount: num(r.paid_amount),
      payoutMethod: r.payout_method ?? null,
      settledAt: r.settled_at,
    })),
    error: null,
  };
}

export async function getDailyReport(storeId: string, from: string, to: string): Promise<Result<DailyReportRow[]>> {
  const db: LooseClient = await createSupabaseServerClient();
  const { data, error } = await db.rpc("consignment_daily_report", { p_store_id: storeId, p_from: from, p_to: to });
  if (error) return { data: null, error: consignmentErrorMessage(error.message) };
  return {
    data: (data ?? []).map((r: any) => ({
      day: r.day,
      supplierId: r.supplier_id,
      productId: r.product_id,
      optionId: r.option_id ?? null,
      mode: r.mode,
      qtySold: num(r.qty_sold),
      grossSales: num(r.gross_sales),
      ownerDue: num(r.owner_due),
      resaleCost: num(r.resale_cost),
      storeProfit: num(r.store_profit),
      unsettledDue: num(r.unsettled_due),
      damagedStore: num(r.damaged_store),
      damagedOwner: num(r.damaged_owner),
      returned: num(r.returned),
      boughtOut: num(r.bought_out),
    })),
    error: null,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */
