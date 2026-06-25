import { createSupabaseServiceClient } from "@/server/integrations/supabase/server";
import { mapError, type AppError } from "@/shared/utils/error";
import { generateHubToken, hashHubToken } from "@/modules/printing/print-hub";

export interface ClaimedPrintJob {
  id: string;
  targetHost: string;
  targetPort: number;
  payloadB64: string;
}

export interface StoreHubAuth {
  organizationId: string;
  tokenHash: string | null;
}

export interface HubStatus {
  lastSeen: string | null;
  pendingJobs: number;
}

type Result<T> = Promise<{ data: T | null; error: AppError | null }>;

/** Adds a print job to the queue for the store's Print Hub to claim. */
export async function enqueuePrintJob(input: {
  organizationId: string;
  storeId: string;
  printerId: string | null;
  host: string;
  port: number;
  payloadB64: string;
}): Result<{ id: string }> {
  const supabase = await createSupabaseServiceClient();
  const { data, error } = await supabase
    .from("print_jobs")
    .insert({
      organization_id: input.organizationId,
      store_id: input.storeId,
      printer_id: input.printerId,
      target_host: input.host,
      target_port: input.port,
      payload_b64: input.payloadB64,
      status: "pending",
    })
    .select("id")
    .single();
  if (error) return { data: null, error: mapError(error) };
  return { data: { id: data.id }, error: null };
}

/** Returns the store's organization + hashed Hub token for auth checks. */
export async function getStoreHubAuth(storeId: string): Result<StoreHubAuth> {
  const supabase = await createSupabaseServiceClient();
  const { data, error } = await supabase
    .from("stores")
    .select("organization_id, print_hub_token_hash")
    .eq("id", storeId)
    .single();
  if (error) return { data: null, error: mapError(error) };
  return {
    data: { organizationId: data.organization_id, tokenHash: data.print_hub_token_hash },
    error: null,
  };
}

/** Records that the Hub for a store is alive (called on every poll). */
export async function touchHubHeartbeat(storeId: string): Promise<{ error: AppError | null }> {
  const supabase = await createSupabaseServiceClient();
  const { error } = await supabase
    .from("stores")
    .update({ print_hub_last_seen: new Date().toISOString() })
    .eq("id", storeId);
  return { error: error ? mapError(error) : null };
}

/**
 * Claims the oldest pending jobs for a store. One Hub per store, so a guarded
 * two-step claim (select ids, then update where still pending) is race-safe.
 */
export async function claimPendingPrintJobs(storeId: string, limit = 5): Result<ClaimedPrintJob[]> {
  const supabase = await createSupabaseServiceClient();
  const { data: pending, error: selectError } = await supabase
    .from("print_jobs")
    .select("id")
    .eq("store_id", storeId)
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(limit);
  if (selectError) return { data: null, error: mapError(selectError) };

  const ids = (pending ?? []).map((row) => row.id);
  if (ids.length === 0) return { data: [], error: null };

  const { data: claimed, error: claimError } = await supabase
    .from("print_jobs")
    .update({ status: "claimed", claimed_at: new Date().toISOString() })
    .in("id", ids)
    .eq("status", "pending")
    .select("id, target_host, target_port, payload_b64");
  if (claimError) return { data: null, error: mapError(claimError) };

  const jobs = (claimed ?? []).map((row) => ({
    id: row.id,
    targetHost: row.target_host,
    targetPort: row.target_port,
    payloadB64: row.payload_b64,
  }));
  return { data: jobs, error: null };
}

/** Marks a claimed job as printed or failed after the Hub reports back. */
export async function ackPrintJob(input: {
  jobId: string;
  storeId: string;
  ok: boolean;
  error?: string | null;
}): Promise<{ error: AppError | null }> {
  const supabase = await createSupabaseServiceClient();
  const patch = input.ok
    ? { status: "printed" as const, printed_at: new Date().toISOString(), error: null }
    : { status: "failed" as const, error: input.error?.slice(0, 500) ?? "Print failed" };
  const { error } = await supabase
    .from("print_jobs")
    .update(patch)
    .eq("id", input.jobId)
    .eq("store_id", input.storeId);
  return { error: error ? mapError(error) : null };
}

/** Heartbeat + pending depth for the Settings UI status card. */
export async function getHubStatus(storeId: string): Result<HubStatus> {
  const supabase = await createSupabaseServiceClient();
  const { data: store, error: storeError } = await supabase
    .from("stores")
    .select("print_hub_last_seen")
    .eq("id", storeId)
    .single();
  if (storeError) return { data: null, error: mapError(storeError) };

  const { count, error: countError } = await supabase
    .from("print_jobs")
    .select("id", { count: "exact", head: true })
    .eq("store_id", storeId)
    .eq("status", "pending");
  if (countError) return { data: null, error: mapError(countError) };

  return {
    data: { lastSeen: store.print_hub_last_seen, pendingJobs: count ?? 0 },
    error: null,
  };
}

/** Generates a fresh Hub token, stores its hash, and returns the plaintext once. */
export async function rotateHubToken(storeId: string): Result<{ token: string }> {
  const supabase = await createSupabaseServiceClient();
  const token = generateHubToken();
  const { error } = await supabase
    .from("stores")
    .update({ print_hub_token_hash: hashHubToken(token) })
    .eq("id", storeId);
  if (error) return { data: null, error: mapError(error) };
  return { data: { token }, error: null };
}
