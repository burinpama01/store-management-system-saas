import { after } from "next/server";
import { createSupabaseServiceClient } from "@/server/integrations/supabase/server";
import { notifyOwnerSafely } from "@/modules/notifications/dispatcher";
import { DEFAULT_LOW_STOCK_THRESHOLD } from "./repository";

export interface SoldStockItem {
  /** variant ที่ตัดสต็อก (ข้ามรายการที่ไม่มี variant / ไม่ตัดสต็อก) */
  variantId: string | null | undefined;
  /** จำนวนหน่วยฐานที่ตัดไป (quantity × ตัวคูณหน่วยแพ็ค) */
  baseQuantity: number;
}

/**
 * ตรวจสต็อกหลังการขายแบบเบื้องหลัง (ไม่บล็อกการตอบ POS) แล้วยิงแจ้งเตือน stock_alert
 * เฉพาะ variant ที่ "เพิ่งข้ามเส้น" (ก่อนขายยังเกิน threshold แต่หลังขายเหลือ ≤ threshold)
 * เพื่อไม่ให้สแปมทุกบิลที่สต็อกต่ำอยู่แล้ว
 */
export function notifyLowStockAfterSaleSafely(
  organizationId: string,
  storeId: string,
  items: SoldStockItem[],
): void {
  const run = () => checkAndNotify(organizationId, storeId, items).catch(() => {});
  try {
    after(run);
  } catch {
    void run();
  }
}

async function checkAndNotify(
  organizationId: string,
  storeId: string,
  items: SoldStockItem[],
): Promise<void> {
  const soldByVariant = new Map<string, number>();
  for (const item of items) {
    if (!item.variantId || !(item.baseQuantity > 0)) continue;
    soldByVariant.set(item.variantId, (soldByVariant.get(item.variantId) ?? 0) + item.baseQuantity);
  }
  if (soldByVariant.size === 0) return;

  const supabase = await createSupabaseServiceClient();
  const variantIds = [...soldByVariant.keys()];
  const { data: variants, error } = await supabase
    .from("product_variants")
    .select("id, name, stock_quantity, track_stock, product_id")
    .in("id", variantIds);
  if (error || !variants || variants.length === 0) return;

  const productIds = [...new Set(variants.map((v) => v.product_id))];
  const { data: products } = await supabase
    .from("products")
    .select("id, name, store_id")
    .in("id", productIds);
  const productById = new Map((products ?? []).map((p) => [p.id, p]));

  const threshold = DEFAULT_LOW_STOCK_THRESHOLD;

  for (const variant of variants) {
    const product = productById.get(variant.product_id);
    if (!product || product.store_id !== storeId) continue;
    if (!variant.track_stock || typeof variant.stock_quantity !== "number") continue;

    const post = variant.stock_quantity;
    const sold = soldByVariant.get(variant.id) ?? 0;
    const pre = post + sold;
    // แจ้งเฉพาะตอนเพิ่งข้ามเส้น (กันสแปม)
    if (!(pre > threshold && post <= threshold)) continue;

    const productName = variant.name ? `${product.name} (${variant.name})` : product.name;
    notifyOwnerSafely({
      type: "stock_alert",
      organizationId,
      storeId,
      title: "สต็อกใกล้หมด",
      message: `${productName} เหลือ ${post} ชิ้น`,
      metadata: { productName, stockQuantity: post, variantId: variant.id },
    });
  }
}
