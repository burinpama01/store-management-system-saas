import { createSupabaseServiceClient } from "@/server/integrations/supabase/server";
import { mapError, type AppError } from "@/shared/utils/error";
import { generateHubToken, hashHubToken } from "@/modules/printing/print-hub";

export type PrintTargetKind = "ip" | "bt";

export interface ClaimedPrintJob {
  id: string;
  targetKind: PrintTargetKind;
  targetHost: string | null;
  targetPort: number;
  targetDevice: string | null;
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

/** U11 — ชนิดงานของ print intent (ใบเสร็จ / ตั๋วครัว); job แบบ legacy ไม่ระบุ */
export type PrintJobKind = "receipt" | "station_ticket";

/**
 * Adds a print job to the queue for the store's Print Hub to claim.
 * U11 — เมื่อระบุ sourceKey (คีย์กำกับต้นทางของ intent เช่น
 * "unified_pos_settlement:<operation_key>:receipt") การ enqueue เป็น idempotent:
 * ถ้ามี job ของคีย์นี้อยู่แล้ว (replay ของ operation เดิม) จะคืน id เดิมโดยไม่สร้างแถวใหม่
 * (dedupe ระดับ schema ด้วย unique index print_jobs_source_key_uq)
 */
export async function enqueuePrintJob(input: {
  organizationId: string;
  storeId: string;
  printerId: string | null;
  /** "ip" prints over LAN TCP (host/port); "bt" prints to a cashier-PC COM port. */
  kind?: PrintTargetKind;
  host?: string | null;
  port?: number;
  device?: string | null;
  payloadB64: string;
  /** U11 — unique source key (replay ของ intent เดิมคืน job id เดิม) */
  sourceKey?: string | null;
  /** U11 — ชนิดงาน (receipt / station_ticket) */
  jobKind?: PrintJobKind | null;
}): Result<{ id: string; deduped?: boolean }> {
  const supabase = await createSupabaseServiceClient();
  if (input.sourceKey) {
    // replay path: คีย์เดิม → คืน job เดิม (ไม่ duplicate ใบเสร็จ/ตั๋ว)
    const existing = await findPrintJobIdBySourceKey(input.storeId, input.sourceKey);
    if (existing) return { data: { id: existing, deduped: true }, error: null };
  }
  const { data, error } = await supabase
    .from("print_jobs")
    .insert({
      organization_id: input.organizationId,
      store_id: input.storeId,
      printer_id: input.printerId,
      target_kind: input.kind ?? "ip",
      target_host: input.host ?? null,
      target_port: input.port ?? 9100,
      target_device: input.device ?? null,
      payload_b64: input.payloadB64,
      status: "pending",
      source_key: input.sourceKey ?? null,
      job_kind: input.jobKind ?? null,
    })
    .select("id")
    .single();
  if (error) {
    // race กับ enqueue คีย์เดิมพร้อมกัน → unique violation → อ่าน id ของผู้ชนะ
    if (input.sourceKey && (error as { code?: string }).code === "23505") {
      const existing = await findPrintJobIdBySourceKey(input.storeId, input.sourceKey);
      if (existing) return { data: { id: existing, deduped: true }, error: null };
    }
    return { data: null, error: mapError(error) };
  }
  return { data: { id: data.id }, error: null };
}

/** U11 — หา id ของ job ที่มี source key นี้ในร้าน (null ถ้าไม่มี) */
export async function findPrintJobIdBySourceKey(storeId: string, sourceKey: string): Promise<string | null> {
  const supabase = await createSupabaseServiceClient();
  const { data } = await supabase
    .from("print_jobs")
    .select("id")
    .eq("store_id", storeId)
    .eq("source_key", sourceKey)
    .maybeSingle();
  return data?.id ?? null;
}

/** U11 — นับจำนวน reprint job ที่มีอยู่ของ receipt job (source_key ขึ้นต้นด้วย prefix)
 * ใช้ range (gte/lt) แทน LIKE — คีย์จาก client อาจมี % หรือ _ จึงไม่ตีความเป็น wildcard */
export async function countPrintJobsBySourceKeyPrefix(storeId: string, sourceKeyPrefix: string): Promise<number> {
  const supabase = await createSupabaseServiceClient();
  // ขอบบน: ต่อท้ายด้วย U+FFFF (สูงกว่าอักขระ BMP ทั้งหมด) → ครอบทุกคีย์ที่ขึ้นต้นด้วย prefix
  const { count } = await supabase
    .from("print_jobs")
    .select("id", { count: "exact", head: true })
    .eq("store_id", storeId)
    .gte("source_key", sourceKeyPrefix)
    .lt("source_key", `${sourceKeyPrefix}\uffff`);
  return count ?? 0;
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
    .select("id, target_kind, target_host, target_port, target_device, payload_b64");
  if (claimError) return { data: null, error: mapError(claimError) };

  const jobs = (claimed ?? []).map((row) => ({
    id: row.id,
    targetKind: (row.target_kind === "bt" ? "bt" : "ip") as PrintTargetKind,
    targetHost: row.target_host,
    targetPort: row.target_port,
    targetDevice: row.target_device,
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
