import { after } from "next/server";
import { notifyOwnerNow } from "@/modules/notifications/dispatcher";
import { createSupabaseServiceClient } from "@/server/integrations/supabase/server";

export interface StockPoolMovementForAlert {
  movementType: string;
  beforeQuantity: number;
  afterQuantity: number;
}

export function isStockPoolLowStockSaleCrossing(
  movement: StockPoolMovementForAlert,
  threshold: number,
): boolean {
  return movement.movementType === "sale"
    && movement.beforeQuantity > threshold
    && movement.afterQuantity <= threshold;
}

/**
 * Reads committed Stock Pool sale movements after the order RPC succeeds.
 * `after` keeps notification delivery outside the order transaction/response;
 * the fallback is still best-effort for runtimes without a request lifecycle.
 */
export function notifyLowStockAfterSaleSafely(
  organizationId: string,
  storeId: string,
  orderId: string,
): void {
  const run = () => checkAndNotify(organizationId, storeId, orderId).catch(() => {});
  try {
    after(run);
  } catch {
    void run();
  }
}

async function checkAndNotify(
  organizationId: string,
  storeId: string,
  orderId: string,
): Promise<void> {
  if (!organizationId || !storeId || !orderId) return;

  const supabase = await createSupabaseServiceClient();
  const { data: movements, error: movementError } = await supabase
    .from("stock_movements")
    .select("id, stock_pool_id, movement_type, before_quantity, after_quantity")
    .eq("movement_type", "sale")
    .eq("reference_type", "order")
    .eq("reference_id", orderId);
  if (movementError || !movements?.length) return;

  const poolIds = [...new Set(movements.map((movement) => movement.stock_pool_id))];
  const { data: pools, error: poolError } = await supabase
    .from("stock_pools")
    .select("id, name, unit_label, low_stock_threshold")
    .eq("organization_id", organizationId)
    .eq("store_id", storeId)
    .in("id", poolIds);
  if (poolError || !pools?.length) return;

  const poolById = new Map(pools.map((pool) => [pool.id, pool]));
  const crossingMovements = movements.filter((movement) => {
    const pool = poolById.get(movement.stock_pool_id);
    return Boolean(pool && isStockPoolLowStockSaleCrossing({
      movementType: movement.movement_type,
      beforeQuantity: movement.before_quantity,
      afterQuantity: movement.after_quantity,
    }, pool.low_stock_threshold));
  });
  if (!crossingMovements.length) return;

  const crossingPoolIds = [...new Set(crossingMovements.map((movement) => movement.stock_pool_id))];
  const { data: links, error: linkError } = await supabase
    .from("variant_stock_links")
    .select("stock_pool_id, variant_id, consumption_quantity")
    .in("stock_pool_id", crossingPoolIds);
  if (linkError) return;

  const variantIds = [...new Set((links ?? []).map((link) => link.variant_id))];
  const { data: variants, error: variantError } = variantIds.length
    ? await supabase
      .from("product_variants")
      .select("id, product_id, name, is_active")
      .in("id", variantIds)
      .eq("is_active", true)
    : { data: [], error: null };
  if (variantError) return;

  const productIds = [...new Set((variants ?? []).map((variant) => variant.product_id))];
  const { data: products, error: productError } = productIds.length
    ? await supabase
      .from("products")
      .select("id, name, is_active")
      .eq("organization_id", organizationId)
      .eq("store_id", storeId)
      .eq("is_active", true)
      .in("id", productIds)
    : { data: [], error: null };
  if (productError) return;

  const variantById = new Map((variants ?? []).map((variant) => [variant.id, variant]));
  const productById = new Map((products ?? []).map((product) => [product.id, product]));
  const itemNamesByPool = new Map<string, string[]>();
  for (const link of links ?? []) {
    const variant = variantById.get(link.variant_id);
    const product = variant ? productById.get(variant.product_id) : null;
    if (!variant || !product) continue;
    const label = variant.name ? `${product.name} (${variant.name})` : product.name;
    const names = itemNamesByPool.get(link.stock_pool_id) ?? [];
    names.push(`${label} ×${link.consumption_quantity}`);
    itemNamesByPool.set(link.stock_pool_id, names);
  }

  for (const movement of crossingMovements) {
    const pool = poolById.get(movement.stock_pool_id);
    if (!pool) continue;

    const { error: claimError } = await supabase
      .from("stock_movement_notification_claims")
      .insert({
        movement_id: movement.id,
        organization_id: organizationId,
        store_id: storeId,
      });
    if (claimError) continue;

    const linkedItemNames = itemNamesByPool.get(pool.id) ?? [];
    const linkedItemsText = linkedItemNames.length
      ? linkedItemNames.join(", ")
      : "ไม่มีรายการขายที่เปิดใช้งาน";
    const delivered = await notifyOwnerNow({
      type: "stock_alert",
      organizationId,
      storeId,
      title: "Stock Pool ใกล้หมด",
      message: `${pool.name} เหลือ ${movement.after_quantity} ${pool.unit_label} · ใช้กับ ${linkedItemsText}`,
      metadata: {
        stockMovementId: movement.id,
        stockPoolId: pool.id,
        productName: pool.name,
        stockQuantity: movement.after_quantity,
        unitLabel: pool.unit_label,
        linkedItems: linkedItemsText,
      },
    });
    if (!delivered) {
      await supabase
        .from("stock_movement_notification_claims")
        .delete()
        .eq("movement_id", movement.id);
    }
  }
}
