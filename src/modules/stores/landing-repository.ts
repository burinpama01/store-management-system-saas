// Server-only through server.ts -> next/headers. Never import this module from a client component.
import { createSupabaseServiceClient } from "@/server/integrations/supabase/server";

export type LandingStore = { name: string; slug: string; logoUrl: string | null };
type LandingStoreRow = { name: string; slug: string; logo_url: string | null };

function publicLogo(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

/** Only public branding leaves the server; no order, customer or activity details are returned. */
export async function listLandingStores(now = new Date()): Promise<LandingStore[]> {
  try {
    const supabase = await createSupabaseServiceClient();
    const since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await supabase
      .from("stores")
      // Empty inner embeds express existence without downloading menu/order rows.
      .select("name,slug,logo_url,organizations!inner(),products!inner(),orders!inner()")
      .eq("is_active", true)
      .is("organizations.suspended_at", null)
      .eq("products.is_active", true)
      .or("available_for_pos.eq.true,available_for_qr.eq.true", { referencedTable: "products" })
      .gte("orders.created_at", since)
      .lte("orders.created_at", now.toISOString())
      .in("orders.status", ["open", "pending_payment", "paid", "refunded"])
      .order("name")
      .order("slug")
      .limit(12)
      .abortSignal(AbortSignal.timeout(4000))
      .returns<LandingStoreRow[]>();
    if (error) {
      console.warn("[landing-stores] Showcase query unavailable");
      return [];
    }
    return (data ?? []).map((row) => ({ name: row.name, slug: row.slug, logoUrl: publicLogo(row.logo_url) }));
  } catch {
    console.warn("[landing-stores] Showcase unavailable");
    return [];
  }
}
