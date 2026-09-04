import { authenticateApiKey, apiError, apiJson } from "@/modules/api-keys/auth";
import { parsePagination } from "@/modules/api-keys/route-helpers";
import { createSupabaseServiceClient } from "@/server/integrations/supabase/server";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * สต๊อกยังคงรายงาน "ต่อ variant" เหมือนเดิม (breaking change กับ integration ที่
 * ใช้อยู่แล้วไม่คุ้ม) — variant ที่ผูก Stock Pool จะได้ฟิลด์ stock_pool เพิ่มมา และ
 * available_quantity เป็นยอดที่ขายได้จริง: Pool → floor(ยอด Pool / จำนวนที่ตัด),
 * ไม่ผูก Pool → stock_quantity เดิม, ไม่ติดตามสต๊อก → null (ไม่จำกัด)
 */
export async function GET(req: Request) {
  const auth = await authenticateApiKey(req, "inventory.read");
  if (!auth.ok) return apiError(auth.status, auth.error);

  const { limit, offset } = parsePagination(req);
  const url = new URL(req.url);
  const storeId = url.searchParams.get("store_id")?.trim() || null;
  if (storeId && !UUID_RE.test(storeId)) return apiError(400, "Invalid store_id");

  const supabase = await createSupabaseServiceClient();

  let productQuery = supabase
    .from("products")
    .select("id")
    .eq("organization_id", auth.organizationId);
  if (storeId) productQuery = productQuery.eq("store_id", storeId);
  const { data: productRows, error: prodErr } = await productQuery;
  if (prodErr) return apiError(500, "Failed to fetch inventory");

  const productIds = (productRows ?? []).map((p) => p.id);
  if (productIds.length === 0) return apiJson([], { limit, offset, count: 0 });

  const { data, error } = await supabase
    .from("product_variants")
    .select("id, product_id, name, stock_quantity, track_stock, is_active")
    .in("product_id", productIds)
    .order("product_id")
    .range(offset, offset + limit - 1);
  if (error) return apiError(500, "Failed to fetch inventory");

  const variants = data ?? [];
  if (variants.length === 0) return apiJson([], { limit, offset, count: 0 });

  const { data: links, error: linkError } = await supabase
    .from("variant_stock_links")
    .select("variant_id, stock_pool_id, consumption_quantity")
    .in("variant_id", variants.map((variant) => variant.id));
  if (linkError) return apiError(500, "Failed to fetch inventory");

  const poolIds = [...new Set((links ?? []).map((link) => link.stock_pool_id))];
  const { data: pools, error: poolError } = poolIds.length
    ? await supabase
      .from("stock_pools")
      .select("id, name, unit_label, quantity, low_stock_threshold, is_active")
      .in("id", poolIds)
    : { data: [], error: null };
  if (poolError) return apiError(500, "Failed to fetch inventory");

  const poolById = new Map((pools ?? []).map((pool) => [pool.id, pool]));
  const linkByVariant = new Map((links ?? []).map((link) => [link.variant_id, link]));

  const rows = variants.map((variant) => {
    const link = linkByVariant.get(variant.id);
    const pool = link ? poolById.get(link.stock_pool_id) : undefined;
    if (!link || !pool) {
      return {
        ...variant,
        stock_pool: null,
        available_quantity: variant.track_stock ? variant.stock_quantity ?? 0 : null,
      };
    }
    return {
      ...variant,
      stock_pool: {
        id: pool.id,
        name: pool.name,
        unit_label: pool.unit_label,
        quantity: pool.quantity,
        low_stock_threshold: pool.low_stock_threshold,
        is_active: pool.is_active,
        consumption_quantity: link.consumption_quantity,
      },
      available_quantity: Math.floor(pool.quantity / link.consumption_quantity),
    };
  });

  return apiJson(rows, { limit, offset, count: rows.length });
}
