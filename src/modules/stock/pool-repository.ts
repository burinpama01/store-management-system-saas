import { createSupabaseServerClient } from "@/server/integrations/supabase/server";
import type { Database } from "@/server/integrations/supabase/database.types";
import { mapError, type AppError } from "@/shared/utils/error";
import type { StockPoolAdjustmentInput } from "./types";

type StockPoolRow = Database["public"]["Tables"]["stock_pools"]["Row"];
type StockPoolLinkRow = Database["public"]["Tables"]["variant_stock_links"]["Row"];

export interface StockPoolView {
  id: string;
  organizationId: string;
  storeId: string;
  name: string;
  unitLabel: string;
  quantity: number;
  lowStockThreshold: number;
  isActive: boolean;
}

export interface StockPoolLink {
  variantId: string;
  stockPoolId: string;
  consumptionQuantity: number;
}

export type StockPoolAdjustmentResult =
  | { ok: true; data: StockPoolRow; error: null }
  | { ok: false; error: AppError };

function isStockPoolRow(data: unknown): data is StockPoolRow {
  return !!data
    && typeof data === "object"
    && typeof (data as { id?: unknown }).id === "string"
    && typeof (data as { quantity?: unknown }).quantity === "number";
}

function isStockPoolLinkRow(data: unknown): data is StockPoolLinkRow {
  return !!data
    && typeof data === "object"
    && typeof (data as { variant_id?: unknown }).variant_id === "string"
    && typeof (data as { stock_pool_id?: unknown }).stock_pool_id === "string"
    && typeof (data as { consumption_quantity?: unknown }).consumption_quantity === "number"
    && typeof (data as { created_at?: unknown }).created_at === "string";
}

function mapPool(row: StockPoolRow): StockPoolView {
  return {
    id: row.id,
    organizationId: row.organization_id,
    storeId: row.store_id,
    name: row.name,
    unitLabel: row.unit_label,
    quantity: row.quantity,
    lowStockThreshold: row.low_stock_threshold,
    isActive: row.is_active,
  };
}

/**
 * includeInactive: Pool ที่ปิดใช้งานแล้วยังต้องดึงมาได้ เพราะ variant ที่ผูกไว้ก่อน
 * ยังผูกอยู่ (RPC ไม่ให้ผูกซ้ำ) ถ้าซ่อนไปหน้าจอจะกลายเป็นทางตัน — แก้ยอดไม่ได้เลย
 */
export async function listStockPools(
  storeId: string,
  opts?: { includeInactive?: boolean },
): Promise<{ data: StockPoolView[]; error: AppError | null }> {
  const supabase = await createSupabaseServerClient();
  let query = supabase.from("stock_pools").select("*").eq("store_id", storeId);
  if (!opts?.includeInactive) query = query.eq("is_active", true);
  const { data, error } = await query.order("name");
  if (error) return { data: [], error: mapError(error) };
  return { data: (data ?? []).map(mapPool), error: null };
}

export async function listStockPoolLinks(storeId: string, variantIds: readonly string[]): Promise<{ data: StockPoolLink[]; error: AppError | null }> {
  const supabase = await createSupabaseServerClient();
  if (!storeId.trim()) return { data: [], error: mapError(new Error("ไม่พบร้านค้า")) };
  const scopedVariantIds = [...new Set(variantIds.filter((variantId) => variantId.trim()))];
  if (scopedVariantIds.length === 0) return { data: [], error: null };
  const { data, error } = await supabase
    .from("variant_stock_links")
    .select("variant_id, stock_pool_id, consumption_quantity")
    .in("variant_id", scopedVariantIds);
  if (error) return { data: [], error: mapError(error) };
  return {
    data: (data ?? []).map((link) => ({
      variantId: link.variant_id,
      stockPoolId: link.stock_pool_id,
      consumptionQuantity: link.consumption_quantity,
    })),
    error: null,
  };
}

export async function createStockPoolAndLinkVariant(input: {
  variantId: string;
  storeId: string;
  name: string;
  unitLabel: string;
  lowStockThreshold: number;
  consumptionQuantity: number;
}): Promise<{ ok: true; data: StockPoolView; error: null } | { ok: false; error: AppError }> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("create_stock_pool_and_link_variant", {
    p_variant_id: input.variantId,
    p_store_id: input.storeId,
    p_name: input.name,
    p_unit_label: input.unitLabel,
    p_low_stock_threshold: input.lowStockThreshold,
    p_consumption_quantity: input.consumptionQuantity,
  });
  if (error || !isStockPoolRow(data)) {
    return { ok: false, error: mapError(error ?? new Error("สร้างและเชื่อม Stock Pool ไม่สำเร็จ")) };
  }
  return { ok: true, data: mapPool(data), error: null };
}

export async function linkVariantToStockPool(input: {
  variantId: string;
  poolId: string;
  storeId: string;
  consumptionQuantity: number;
}): Promise<{ ok: true; error: null } | { ok: false; error: AppError }> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("link_variant_to_stock_pool", {
    p_variant_id: input.variantId,
    p_pool_id: input.poolId,
    p_store_id: input.storeId,
    p_consumption_quantity: input.consumptionQuantity,
  });
  if (
    error
    || !isStockPoolLinkRow(data)
    || data.variant_id !== input.variantId
    || data.stock_pool_id !== input.poolId
    || data.consumption_quantity !== input.consumptionQuantity
  ) {
    return {
      ok: false,
      error: {
        code: "stock_pool_link_failed",
        message: "link variant to stock pool RPC failed",
        userMessage: "ไม่สามารถเชื่อม Stock Pool ได้",
      },
    };
  }
  return { ok: true, error: null };
}

/**
 * Adjusts a pool only through the database RPC. The store-scoped precheck keeps
 * an accidentally stale dashboard context from targeting another store; the RPC
 * repeats authorization while holding the pool row lock.
 */
export async function adjustStockPool(input: StockPoolAdjustmentInput): Promise<StockPoolAdjustmentResult> {
  const supabase = await createSupabaseServerClient();
  const { data: pool, error: poolError } = await supabase
    .from("stock_pools")
    .select("id")
    .eq("id", input.poolId)
    .eq("store_id", input.storeId)
    .maybeSingle();

  if (poolError) {
    return {
      ok: false,
      error: {
        code: "stock_pool_precheck_failed",
        message: poolError.message,
        userMessage: "ไม่สามารถตรวจสอบ Stock Pool ได้",
      },
    };
  }
  if (!pool) {
    return { ok: false, error: mapError(new Error("ไม่พบ Stock Pool หรือไม่มีสิทธิ์เข้าถึง")) };
  }

  const { data, error } = await supabase.rpc("adjust_stock_pool", {
    p_pool_id: input.poolId,
    p_mode: input.mode,
    p_quantity: input.quantity,
    p_reason: input.reason,
  });
  if (error || !isStockPoolRow(data)) {
    return {
      ok: false,
      error: {
        code: "stock_adjustment_failed",
        message: error?.message ?? "stock pool adjustment returned no data",
        userMessage: "ไม่สามารถปรับสต็อกได้",
      },
    };
  }

  return { ok: true, data, error: null };
}
