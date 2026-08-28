// Task 9/D (v0.34.0) — Server-side AI quota governance.
// Contract from the plan: resolve user/org from the server session, reserve the
// per-request budget atomically BEFORE calling the provider (deny-before-call),
// settle actual usage idempotently afterwards; a timeout that never reports
// provider usage keeps its reservation for reconciliation instead of refunding.
import { createSupabaseServiceClient } from "@/server/integrations/supabase/server";

/** Monthly token budget per organization (server constant; env override allowed). */
export const AI_MONTHLY_TOKEN_BUDGET = Number(process.env.AI_MONTHLY_TOKEN_BUDGET ?? 100000);

/** Hard cap per request — every reservation is bounded by the adapter anyway. */
export const AI_MAX_OUTPUT_TOKENS = 600;

export type QuotaDecision = { granted: boolean; reason?: string };

/** Pure decision core (unit-tested): used + reserved + request must fit the budget. */
export function evaluateQuota(args: {
  monthlyUsed: number;
  monthlyReserved: number;
  budget: number;
  maxTokens: number;
}): QuotaDecision {
  const { monthlyUsed, monthlyReserved, budget, maxTokens } = args;
  if (!Number.isFinite(maxTokens) || maxTokens <= 0 || !Number.isFinite(budget) || budget <= 0) {
    return { granted: false, reason: "invalid_request" };
  }
  if (monthlyUsed + monthlyReserved + maxTokens > budget) {
    return { granted: false, reason: "budget_exceeded" };
  }
  return { granted: true };
}

export type ReserveResult = { granted: boolean; reason?: string };

/**
 * Atomic reservation via the SECURITY DEFINER RPC (advisory-locked per org).
 * The service client is used because reservations are server-governed state;
 * clients have no direct access to the table at all.
 */
export async function reserveQuota(args: {
  organizationId: string;
  requestId: string;
  feature: string;
  maxTokens?: number;
  budget?: number;
}): Promise<ReserveResult> {
  const supabase = await createSupabaseServiceClient();
  const { data, error } = await supabase.rpc("reserve_ai_quota", {
    p_organization_id: args.organizationId,
    p_request_id: args.requestId,
    p_feature: args.feature,
    p_max_tokens: args.maxTokens ?? AI_MAX_OUTPUT_TOKENS,
    p_monthly_budget: args.budget ?? AI_MONTHLY_TOKEN_BUDGET,
  });
  if (error) return { granted: false, reason: error.message };
  const result = data as { granted?: boolean; reason?: string };
  return { granted: Boolean(result?.granted), reason: result?.reason };
}

export type SettleInput = {
  organizationId: string;
  requestId: string;
  feature: string;
  model: string;
  storeId?: string | null;
  userId?: string | null;
  tokens: number;
  status: "ok" | "error" | "timeout" | "denied";
  requestHash: string;
};

/** Idempotent settle: flip the reservation to settled, then append the ledger row. */
export async function settleUsage(input: SettleInput): Promise<{ ok: boolean; error: string | null }> {
  const supabase = await createSupabaseServiceClient();
  const claimed = await supabase
    .from("ai_quota_reservations")
    .update({ status: "settled" })
    .eq("organization_id", input.organizationId)
    .eq("request_id", input.requestId)
    .eq("status", "reserved")
    .select("id");
  if (claimed.error) return { ok: false, error: claimed.error.message };
  // Nothing to claim (already settled) → do not append a duplicate ledger row.
  if (!claimed.data || claimed.data.length === 0) return { ok: true, error: null };
  const inserted = await supabase.from("ai_usage_logs").insert({
    organization_id: input.organizationId,
    store_id: input.storeId ?? null,
    user_id: input.userId ?? null,
    feature: input.feature,
    model: input.model,
    tokens: input.tokens,
    status: input.status,
    request_hash: input.requestHash,
  });
  if (inserted.error) return { ok: false, error: inserted.error.message };
  return { ok: true, error: null };
}