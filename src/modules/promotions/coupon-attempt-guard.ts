import { createSupabaseServiceClient } from "@/server/integrations/supabase/server";

// Brute-force guard for POS coupon / reward-voucher code entry.
// Codes are typed into the POS coupon field, so we cap how many failed guesses
// a store can make in a short window. Successful redemptions never count, so a
// busy cashier with valid codes is never blocked.
const WINDOW_MS = 10 * 60 * 1000;
const MAX_FAILED_ATTEMPTS = 10;

export async function isCouponAttemptBlocked(storeId: string): Promise<boolean> {
  const supabase = await createSupabaseServiceClient();
  const since = new Date(Date.now() - WINDOW_MS).toISOString();
  const { count, error } = await supabase
    .from("pos_coupon_code_attempts")
    .select("id", { count: "exact", head: true })
    .eq("store_id", storeId)
    .eq("succeeded", false)
    .gte("created_at", since);

  // Fail open: a logging/count error must never block a legitimate cashier.
  if (error) return false;
  return (count ?? 0) >= MAX_FAILED_ATTEMPTS;
}

export async function recordCouponAttempt(input: {
  organizationId: string | null;
  storeId: string;
  userId?: string | null;
  code: string;
  succeeded: boolean;
}): Promise<void> {
  try {
    const supabase = await createSupabaseServiceClient();
    await supabase.from("pos_coupon_code_attempts").insert({
      organization_id: input.organizationId,
      store_id: input.storeId,
      user_id: input.userId ?? null,
      code_normalized: input.code.trim().slice(0, 40).toUpperCase() || null,
      succeeded: input.succeeded,
    });
  } catch {
    // best-effort logging only
  }
}
