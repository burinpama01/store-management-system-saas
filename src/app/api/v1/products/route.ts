import { authenticateApiKey, apiError, apiJson } from "@/modules/api-keys/auth";
import { parsePagination } from "@/modules/api-keys/route-helpers";
import { createSupabaseServiceClient } from "@/server/integrations/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = await authenticateApiKey(req, "products.read");
  if (!auth.ok) return apiError(auth.status, auth.error);

  const { limit, offset } = parsePagination(req);
  const supabase = await createSupabaseServiceClient();
  const { data, error } = await supabase
    .from("products")
    .select("id, store_id, category_id, name, base_price, is_active")
    .eq("organization_id", auth.organizationId)
    .order("name")
    .range(offset, offset + limit - 1);

  if (error) return apiError(500, "Failed to fetch products");
  return apiJson(data ?? [], { limit, offset, count: data?.length ?? 0 });
}
