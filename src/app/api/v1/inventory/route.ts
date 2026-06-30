import { authenticateApiKey, apiError, apiJson } from "@/modules/api-keys/auth";
import { parsePagination } from "@/modules/api-keys/route-helpers";
import { createSupabaseServiceClient } from "@/server/integrations/supabase/server";

export const dynamic = "force-dynamic";

// Stock is tracked at the variant level; scope to the org via its products.
export async function GET(req: Request) {
  const auth = await authenticateApiKey(req);
  if (!auth.ok) return apiError(auth.status, auth.error);

  const { limit, offset } = parsePagination(req);
  const supabase = await createSupabaseServiceClient();

  const { data: productRows, error: prodErr } = await supabase
    .from("products")
    .select("id")
    .eq("organization_id", auth.organizationId);
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
  return apiJson(data ?? [], { limit, offset, count: data?.length ?? 0 });
}
