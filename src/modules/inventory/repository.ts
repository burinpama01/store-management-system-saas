/**
 * คลังวัตถุดิบ — Supabase queries
 * ใช้ client ของผู้ใช้ (RLS ระดับ manager) · การเปลี่ยนยอดทำผ่าน RPC security definer เท่านั้น
 */
import { createSupabaseServerClient, createSupabaseServiceClient } from "@/server/integrations/supabase/server";
import type { InventoryItem, InventoryMovement, MovementType, Supplier, SupplierInput } from "./types";

// ตาราง/RPC ใหม่ยังไม่อยู่ใน database.types (แบบเดียวกับ missions/repository.ts)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LooseClient = any;

type Result<T> = { data: T; error: null } | { data: null; error: string };

interface StoreScope {
  organizationId: string;
  storeId: string;
}

const num = (value: unknown): number => (typeof value === "number" ? value : Number(value ?? 0));
const numOrNull = (value: unknown): number | null => (value === null || value === undefined ? null : num(value));

/** ข้อความจาก RPC → ภาษาไทยที่ผู้ใช้อ่านเข้าใจ (ไม่ส่งข้อความ SQL ดิบขึ้นจอ) */
export function inventoryErrorMessage(raw: string | undefined | null): string {
  const message = raw ?? "";
  if (message.includes("not enabled")) return "สาขานี้ยังไม่ได้เปิดคลังวัตถุดิบ";
  if (message.includes("manager role") || message.includes("only owner/admin")) return "ไม่มีสิทธิ์จัดการคลังวัตถุดิบ";
  if (message.includes("stockManagement")) return "แพ็กเกจปัจจุบันยังไม่รวมระบบสต็อก";
  if (message.includes("already set")) return "ตั้งยอดยกมาไปแล้ว — ใช้ปรับยอดแทน";
  if (message.includes("requires a reason")) return "กรุณาระบุเหตุผลที่ปรับยอด";
  if (message.includes("on hand must be")) return "ยอดคงเหลือไม่ถูกต้อง";
  if (message.includes("ingredient not found")) return "ไม่พบวัตถุดิบนี้";
  if (message.includes("suppliers_store_name_unique_idx") || message.includes("duplicate key")) return "มีผู้ขายชื่อนี้อยู่แล้ว";
  return "บันทึกไม่สำเร็จ ลองใหม่อีกครั้ง";
}

/* eslint-disable @typescript-eslint/no-explicit-any -- แถวดิบจาก PostgREST */
function mapSupplier(row: any): Supplier {
  return {
    id: row.id,
    name: row.name,
    taxId: row.tax_id,
    branchCode: row.branch_code,
    contactName: row.contact_name,
    phone: row.phone,
    lineId: row.line_id,
    address: row.address,
    note: row.note,
    leadDays: num(row.lead_days),
    paymentTermsDays: num(row.payment_terms_days),
    isActive: row.is_active === true,
  };
}

export async function isInventoryEnabled(storeId: string): Promise<boolean> {
  const db: LooseClient = await createSupabaseServiceClient();
  const { data, error } = await db.from("stores").select("inventory_enabled").eq("id", storeId).maybeSingle();
  if (error || !data) return false;
  return data.inventory_enabled === true;
}

export async function setInventoryEnabled(storeId: string, enabled: boolean): Promise<Result<boolean>> {
  const db: LooseClient = await createSupabaseServerClient();
  const { data, error } = await db.rpc("inventory_set_enabled", { p_store_id: storeId, p_enabled: enabled });
  if (error) return { data: null, error: inventoryErrorMessage(error.message) };
  return { data: data === true, error: null };
}

export async function listSuppliers(storeId: string): Promise<Result<Supplier[]>> {
  const db: LooseClient = await createSupabaseServerClient();
  const { data, error } = await db
    .from("suppliers")
    .select("*")
    .eq("store_id", storeId)
    .order("is_active", { ascending: false })
    .order("name")
    .limit(500);
  if (error) return { data: null, error: inventoryErrorMessage(error.message) };
  return { data: (data ?? []).map(mapSupplier), error: null };
}

export async function saveSupplier(scope: StoreScope, input: SupplierInput): Promise<Result<{ id: string }>> {
  const db: LooseClient = await createSupabaseServerClient();
  const payload = {
    organization_id: scope.organizationId,
    store_id: scope.storeId,
    name: input.name,
    tax_id: input.taxId,
    branch_code: input.branchCode,
    contact_name: input.contactName,
    phone: input.phone,
    line_id: input.lineId,
    address: input.address,
    note: input.note,
    lead_days: input.leadDays,
    payment_terms_days: input.paymentTermsDays,
    is_active: input.isActive,
    updated_at: new Date().toISOString(),
  };
  const result = input.id
    ? await db.from("suppliers").update(payload).eq("id", input.id).eq("store_id", scope.storeId).select("id").maybeSingle()
    : await db.from("suppliers").insert(payload).select("id").single();
  if (result.error) return { data: null, error: inventoryErrorMessage(result.error.message) };
  if (!result.data) return { data: null, error: "ไม่พบผู้ขายนี้" };
  return { data: { id: result.data.id }, error: null };
}

export async function listInventoryItems(storeId: string): Promise<Result<InventoryItem[]>> {
  const db: LooseClient = await createSupabaseServerClient();
  const [ingredientsRes, stockRes] = await Promise.all([
    db
      .from("ingredients")
      .select("id, name, purchase_unit, usage_unit, usage_per_purchase, purchase_price, is_active, reorder_point, safety_days, default_supplier_id")
      .eq("store_id", storeId)
      .order("name")
      .limit(1000),
    db.from("ingredient_stock").select("ingredient_id, on_hand, avg_unit_cost, updated_at").eq("store_id", storeId).limit(1000),
  ]);
  const error = ingredientsRes.error ?? stockRes.error;
  if (error) return { data: null, error: inventoryErrorMessage(error.message) };
  const stockById = new Map<string, any>((stockRes.data ?? []).map((row: any) => [row.ingredient_id, row]));
  return {
    data: (ingredientsRes.data ?? []).map((row: any): InventoryItem => {
      const stock = stockById.get(row.id);
      return {
        ingredientId: row.id,
        name: row.name,
        purchaseUnit: row.purchase_unit,
        usageUnit: row.usage_unit,
        usagePerPurchase: num(row.usage_per_purchase),
        purchasePrice: num(row.purchase_price),
        isActive: row.is_active === true,
        reorderPoint: numOrNull(row.reorder_point),
        safetyDays: num(row.safety_days),
        defaultSupplierId: row.default_supplier_id ?? null,
        onHand: stock ? num(stock.on_hand) : null,
        avgUnitCost: stock ? num(stock.avg_unit_cost) : null,
        updatedAt: stock?.updated_at ?? null,
      };
    }),
    error: null,
  };
}

export async function listRecentMovements(storeId: string, ingredientId: string | null, limit = 50): Promise<Result<InventoryMovement[]>> {
  const db: LooseClient = await createSupabaseServerClient();
  let query = db
    .from("ingredient_movements")
    .select("id, ingredient_id, movement_type, qty_delta, before_qty, after_qty, unit_cost, reason, created_at")
    .eq("store_id", storeId)
    .order("created_at", { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 200));
  if (ingredientId) query = query.eq("ingredient_id", ingredientId);
  const { data, error } = await query;
  if (error) return { data: null, error: inventoryErrorMessage(error.message) };
  return {
    data: (data ?? []).map((row: any) => ({
      id: row.id,
      ingredientId: row.ingredient_id,
      movementType: row.movement_type as MovementType,
      qtyDelta: num(row.qty_delta),
      beforeQty: num(row.before_qty),
      afterQty: num(row.after_qty),
      unitCost: num(row.unit_cost),
      reason: row.reason ?? null,
      createdAt: row.created_at,
    })),
    error: null,
  };
}

/** วัตถุดิบต้องอยู่ในสาขาที่ผู้ใช้เลือกอยู่ — RPC ตรวจสิทธิ์จากสาขาของวัตถุดิบเอง จึงต้องผูกกับสาขาปัจจุบันที่ชั้น action */
export async function ingredientBelongsToStore(storeId: string, ingredientId: string): Promise<boolean> {
  const db: LooseClient = await createSupabaseServerClient();
  const { data, error } = await db.from("ingredients").select("id").eq("id", ingredientId).eq("store_id", storeId).maybeSingle();
  return !error && Boolean(data);
}

export async function setIngredientBalance(input: {
  ingredientId: string;
  kind: "opening" | "manual_adjust";
  newOnHand: number;
  reason: string | null;
  unitCost: number | null;
}): Promise<Result<{ onHand: number; avgUnitCost: number }>> {
  const db: LooseClient = await createSupabaseServerClient();
  const { data, error } = await db.rpc("inventory_set_balance", {
    p_ingredient_id: input.ingredientId,
    p_kind: input.kind,
    p_new_on_hand: input.newOnHand,
    p_reason: input.reason,
    p_unit_cost: input.unitCost,
  });
  if (error) return { data: null, error: inventoryErrorMessage(error.message) };
  const row = Array.isArray(data) ? data[0] : data;
  return { data: { onHand: num(row?.on_hand), avgUnitCost: num(row?.avg_unit_cost) }, error: null };
}

/** ตั้งจุดสั่งซื้อ/วันสำรอง/ผู้ขายประจำ (คอลัมน์ใน ingredients — RLS manager เดิม) */
export async function saveIngredientInventorySettings(
  storeId: string,
  ingredientId: string,
  input: { reorderPoint: number | null; safetyDays: number; defaultSupplierId: string | null },
): Promise<Result<true>> {
  const db: LooseClient = await createSupabaseServerClient();
  const { data, error } = await db
    .from("ingredients")
    .update({
      reorder_point: input.reorderPoint,
      safety_days: input.safetyDays,
      default_supplier_id: input.defaultSupplierId,
      updated_at: new Date().toISOString(),
    })
    .eq("id", ingredientId)
    .eq("store_id", storeId)
    .select("id");
  if (error) {
    if (String(error.message).includes("default supplier")) return { data: null, error: "ผู้ขายต้องเป็นของสาขาเดียวกัน" };
    return { data: null, error: inventoryErrorMessage(error.message) };
  }
  if (!data || data.length === 0) return { data: null, error: "ไม่พบวัตถุดิบนี้" };
  return { data: true, error: null };
}
/* eslint-enable @typescript-eslint/no-explicit-any */
