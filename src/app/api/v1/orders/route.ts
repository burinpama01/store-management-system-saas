import { authenticateApiKey, apiError, apiJson } from "@/modules/api-keys/auth";
import { parsePagination, dateParam } from "@/modules/api-keys/route-helpers";
import { createSupabaseServiceClient } from "@/server/integrations/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = await authenticateApiKey(req);
  if (!auth.ok) return apiError(auth.status, auth.error);

  const { limit, offset } = parsePagination(req);
  const from = dateParam(req, "from");
  const to = dateParam(req, "to");

  const supabase = await createSupabaseServiceClient();
  let query = supabase
    .from("orders")
    .select("id, store_id, order_number, status, total, table_number, created_at, paid_at")
    .eq("organization_id", auth.organizationId);
  if (from) query = query.gte("created_at", `${from}T00:00:00Z`);
  if (to) query = query.lte("created_at", `${to}T23:59:59Z`);

  const { data, error } = await query
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) return apiError(500, "Failed to fetch orders");
  return apiJson(data ?? [], { limit, offset, count: data?.length ?? 0 });
}
