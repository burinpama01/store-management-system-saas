import { createSupabaseServiceClient } from "@/server/integrations/supabase/server";
import { getOrganizationBillingState } from "@/modules/billing/billing-service";
import { canUseFeature, DEFAULT_BILLING_STATE } from "@/modules/billing/types";
import { hashApiKey } from "./repository";

export interface ApiAuthSuccess {
  ok: true;
  organizationId: string;
  apiKeyId: string;
}
export interface ApiAuthFailure {
  ok: false;
  status: 401 | 403;
  error: string;
}
export type ApiAuthResult = ApiAuthSuccess | ApiAuthFailure;

/** Extracts the API key from `Authorization: Bearer <key>` or `x-api-key`. */
function readKey(req: Request): string | null {
  const auth = req.headers.get("authorization");
  if (auth && auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim() || null;
  }
  const x = req.headers.get("x-api-key");
  return x?.trim() || null;
}

/**
 * Authenticates an inbound API request: resolves the org from the key hash,
 * rejects revoked keys, then enforces the Enterprise `apiIntegration` feature
 * and an active subscription. Touches last_used_at on success (best-effort).
 */
export async function authenticateApiKey(req: Request): Promise<ApiAuthResult> {
  const plaintext = readKey(req);
  if (!plaintext) {
    return { ok: false, status: 401, error: "Missing API key" };
  }

  const supabase = await createSupabaseServiceClient();
  const { data: row } = await supabase
    .from("api_keys")
    .select("id, organization_id, revoked_at")
    .eq("key_hash", hashApiKey(plaintext))
    .maybeSingle();

  if (!row || row.revoked_at) {
    return { ok: false, status: 401, error: "Invalid API key" };
  }

  const billingState =
    (await getOrganizationBillingState(row.organization_id)) ?? DEFAULT_BILLING_STATE;
  if (!canUseFeature(billingState, "apiIntegration")) {
    return { ok: false, status: 403, error: "API access requires the Enterprise plan" };
  }

  // Best-effort usage timestamp; never blocks the request.
  await supabase
    .from("api_keys")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", row.id);

  return { ok: true, organizationId: row.organization_id, apiKeyId: row.id };
}

/** Standard JSON error envelope for the public API. */
export function apiError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Standard JSON success envelope for the public API. */
export function apiJson(data: unknown, meta?: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ data, ...(meta ? { meta } : {}) }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
