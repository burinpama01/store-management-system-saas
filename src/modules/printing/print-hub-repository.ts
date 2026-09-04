import { createSupabaseServiceClient } from "@/server/integrations/supabase/server";
import type { Json } from "@/server/integrations/supabase/database.types";
import { mapError, type AppError } from "@/shared/utils/error";
import {
  generateHubToken,
  hashHubToken,
  PRINT_JOB_LEASE_SECONDS,
  type PrintJobOutcome,
} from "@/modules/printing/print-hub";

/** "usb" prints through the Windows spooler on the cashier PC running the Hub. */
export type PrintTargetKind = "ip" | "bt" | "usb";

export interface ClaimedPrintJob {
  id: string;
  targetKind: PrintTargetKind;
  targetHost: string | null;
  targetPort: number;
  targetDevice: string | null;
  payloadB64: string;
  /** โทเค็นต่อการเคลมครั้งนี้ — agent ต้องส่งกลับตอน ack (กัน ack ค้างจากรอบก่อน) */
  claimToken: string | null;
  attempts: number;
}

export interface StoreHubAuth {
  organizationId: string;
  tokenHash: string | null;
}

/** งานที่เคลมไปแล้วแต่ไม่รู้ผล — ต้องให้คนตรวจใบจริงก่อนตัดสิน (ห้ามพิมพ์ซ้ำเอง) */
export interface UnknownPrintJob {
  id: string;
  jobKind: PrintJobKind | null;
  attempts: number;
  claimedAt: string | null;
  createdAt: string;
}

export interface HubStatus {
  lastSeen: string | null;
  pendingJobs: number;
  /** งานที่ agent กำลังถืออยู่ (ยังไม่เลย lease) */
  claimedJobs: number;
  /** งานที่ผลไม่ชัดเจน — แสดงให้ร้านตัดสินใจ */
  unknownJobs: number;
  failedJobs: number;
  /** รายการงาน unknown ล่าสุดสำหรับหน้า Settings/POS */
  unknownJobList: UnknownPrintJob[];
  /** เครื่องพิมพ์ที่ Hub agent สแกนเจอบนพีซีแคชเชียร์ (ผลล่าสุด) */
  devices: HubDevice[];
  devicesAt: string | null;
}

/** เครื่องพิมพ์หนึ่งตัวที่ Hub agent มองเห็นบนพีซีแคชเชียร์ */
export interface HubDevice {
  /** ชื่อเครื่องพิมพ์ของ Windows (ใช้เป็น target ของงานพิมพ์ USB) */
  name: string;
  /** พอร์ตของ Windows เช่น USB001, COM5, IP_192.168.1.59 */
  port: string;
  /** เป็นเครื่องพิมพ์ default ของ Windows หรือไม่ */
  isDefault: boolean;
  /** true = เสียบผ่าน USB (พิจารณาจากชื่อพอร์ต) */
  isUsb: boolean;
  offline: boolean;
}

type Result<T> = Promise<{ data: T | null; error: AppError | null }>;

/** เพดานจำนวนเครื่องพิมพ์ที่รับจาก agent (กันแถวบวมโดยไม่ตั้งใจ) */
export const MAX_HUB_DEVICES = 30;

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
 * เคลมงานที่รอพิมพ์แบบ atomic ผ่าน RPC (FOR UPDATE SKIP LOCKED) — ถ้ามี agent
 * สองตัวบนเครื่องเดียว (Scheduled Task + Launcher เปิดซ้ำ) งานหนึ่งใบจะไปได้ที่
 * ตัวเดียวเท่านั้น ทุกการเคลมเพิ่ม attempts และออก claim token ใหม่เสมอ
 */
export async function claimPendingPrintJobs(
  storeId: string,
  limit = 5,
  options: { leaseSeconds?: number; agentVersion?: string | null } = {},
): Result<ClaimedPrintJob[]> {
  const supabase = await createSupabaseServiceClient();
  const { data, error } = await supabase.rpc("claim_print_jobs", {
    p_store_id: storeId,
    p_limit: limit,
    p_lease_seconds: options.leaseSeconds ?? PRINT_JOB_LEASE_SECONDS,
    p_agent_version: options.agentVersion ?? null,
  });
  if (error) return { data: null, error: mapError(error) };

  const jobs = (data ?? []).map((row) => ({
    id: row.id,
    targetKind: (row.target_kind === "bt" || row.target_kind === "usb" ? row.target_kind : "ip") as PrintTargetKind,
    targetHost: row.target_host,
    targetPort: row.target_port,
    targetDevice: row.target_device,
    payloadB64: row.payload_b64,
    claimToken: row.claim_token,
    attempts: row.attempts,
  }));
  return { data: jobs, error: null };
}

/**
 * ปิดงานที่ lease หมดโดยไม่มี ack ให้เป็น unknown — เรียกแบบ lazy ตอน poll/status
 * เพราะโควตา cron ของ Vercel Hobby เต็มแล้ว (ไม่มี slot ให้ scheduled job)
 */
export async function reconcileStalePrintJobs(storeId: string): Result<{ reconciled: number }> {
  const supabase = await createSupabaseServiceClient();
  const { data, error } = await supabase.rpc("reconcile_stale_print_jobs", { p_store_id: storeId });
  if (error) return { data: null, error: mapError(error) };
  return { data: { reconciled: typeof data === "number" ? data : 0 }, error: null };
}

/** ผลของการ ack: applied=false แปลว่า ack นี้ไม่ตรงกับการเคลมปัจจุบัน (ค้างจากรอบก่อน) */
export interface AckPrintJobResult {
  applied: boolean;
  status: PrintJobOutcome | null;
}

/**
 * บันทึกผลงานพิมพ์ที่ Hub รายงานกลับ โดยรับเฉพาะงานที่ยังอยู่สถานะ claimed และ
 * โทเค็นตรงกับการเคลมล่าสุด — ack ที่มาช้าหลังงานถูกตีเป็น unknown/เคลมใหม่แล้ว
 * ต้องไม่ทับผลปัจจุบัน (agent เก่าที่ฟื้นขึ้นมาหลังเน็ตกลับ)
 */
export async function ackPrintJob(input: {
  jobId: string;
  storeId: string;
  outcome: PrintJobOutcome;
  error?: string | null;
  /** null = agent รุ่นเก่าที่ยังไม่ส่งโทเค็น (compatibility window) */
  claimToken?: string | null;
}): Result<AckPrintJobResult> {
  const supabase = await createSupabaseServiceClient();
  const patch =
    input.outcome === "printed"
      ? { status: "printed" as const, printed_at: new Date().toISOString(), error: null }
      : input.outcome === "failed"
        ? { status: "failed" as const, error: input.error?.slice(0, 500) ?? "Print failed" }
        : {
            status: "unknown" as const,
            error:
              input.error?.slice(0, 500) ??
              "Print Hub รายงานว่าไม่ทราบผล — ตรวจว่ากระดาษออกแล้วหรือยังก่อนสั่งพิมพ์ซ้ำ",
          };

  let query = supabase
    .from("print_jobs")
    .update(patch)
    .eq("id", input.jobId)
    .eq("store_id", input.storeId)
    .eq("status", "claimed");
  if (input.claimToken) query = query.eq("claim_token", input.claimToken);

  const { data, error } = await query.select("id");
  if (error) return { data: null, error: mapError(error) };
  const applied = (data ?? []).length > 0;
  return { data: { applied, status: applied ? input.outcome : null }, error: null };
}

/**
 * คนตัดสินผลของงาน unknown หลังไปดูกระดาษจริง:
 *   printed_confirmed = ใบออกแล้ว ปิดงาน
 *   retried           = ใบไม่ออก ส่งกลับเข้าคิวเป็น attempt ใหม่
 * ระบบไม่ทำสองอย่างนี้เองเด็ดขาด เพราะเดาผิดข้างหนึ่งคือใบเสร็จซ้ำ อีกข้างคือใบหาย
 */
export async function resolveUnknownPrintJob(input: {
  jobId: string;
  storeId: string;
  resolution: "printed_confirmed" | "retried";
  userId: string | null;
}): Result<{ status: "printed" | "pending" }> {
  const supabase = await createSupabaseServiceClient();
  const now = new Date().toISOString();
  const patch =
    input.resolution === "printed_confirmed"
      ? {
          status: "printed" as const,
          printed_at: now,
          error: null,
          resolution: "printed_confirmed" as const,
          resolved_at: now,
          resolved_by: input.userId,
        }
      : {
          status: "pending" as const,
          error: null,
          claim_token: null,
          lease_expires_at: null,
          claimed_at: null,
          resolution: "retried" as const,
          resolved_at: now,
          resolved_by: input.userId,
        };

  const { data, error } = await supabase
    .from("print_jobs")
    .update(patch)
    .eq("id", input.jobId)
    .eq("store_id", input.storeId)
    .eq("status", "unknown")
    .select("id");
  if (error) return { data: null, error: mapError(error) };
  if ((data ?? []).length === 0) {
    return { data: null, error: mapError(new Error("งานนี้ถูกจัดการไปแล้ว หรือไม่ได้อยู่ในสถานะรอตรวจสอบ")) };
  }
  return { data: { status: input.resolution === "printed_confirmed" ? "printed" : "pending" }, error: null };
}

/** จำนวนงาน unknown ที่ดึงมาแสดง (พอให้ร้านไล่เคลียร์ ไม่ดึงทั้งประวัติ) */
export const MAX_UNKNOWN_JOBS_LISTED = 20;

/**
 * Heartbeat + สภาพคิวสำหรับการ์ดสถานะ (Settings และแถบเตือนที่ POS)
 * เรียก reconcile ก่อนนับเสมอ เพื่อให้ตัวเลข unknown เป็นของจริง ณ เวลาที่เปิดดู
 */
export async function getHubStatus(storeId: string): Result<HubStatus> {
  const supabase = await createSupabaseServiceClient();
  await reconcileStalePrintJobs(storeId);

  const { data: store, error: storeError } = await supabase
    .from("stores")
    .select("print_hub_last_seen, print_hub_devices, print_hub_devices_at")
    .eq("id", storeId)
    .single();
  if (storeError) return { data: null, error: mapError(storeError) };

  const { data: openJobs, error: jobsError } = await supabase
    .from("print_jobs")
    .select("id, status, job_kind, attempts, claimed_at, created_at")
    .eq("store_id", storeId)
    .in("status", ["pending", "claimed", "unknown", "failed"])
    .order("created_at", { ascending: false })
    .limit(200);
  if (jobsError) return { data: null, error: mapError(jobsError) };

  const rows = openJobs ?? [];
  const countOf = (status: string) => rows.filter((row) => row.status === status).length;
  const unknownJobList = rows
    .filter((row) => row.status === "unknown")
    .slice(0, MAX_UNKNOWN_JOBS_LISTED)
    .map((row) => ({
      id: row.id,
      jobKind: (row.job_kind ?? null) as PrintJobKind | null,
      attempts: row.attempts,
      claimedAt: row.claimed_at,
      createdAt: row.created_at,
    }));

  return {
    data: {
      lastSeen: store.print_hub_last_seen,
      pendingJobs: countOf("pending"),
      claimedJobs: countOf("claimed"),
      unknownJobs: countOf("unknown"),
      failedJobs: countOf("failed"),
      unknownJobList,
      devices: parseHubDevices(store.print_hub_devices),
      devicesAt: store.print_hub_devices_at ?? null,
    },
    error: null,
  };
}

/** Row จาก DB เขียนโดย agent — ตรวจรูปทรงก่อนใช้เสมอ (เนื้อหาไม่ใช่คำสั่ง) */
export function parseHubDevices(value: unknown): HubDevice[] {
  if (!Array.isArray(value)) return [];
  const devices: HubDevice[] = [];
  for (const raw of value.slice(0, MAX_HUB_DEVICES)) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as Record<string, unknown>;
    const name = typeof row.name === "string" ? row.name.trim().slice(0, 128) : "";
    if (!name) continue;
    const port = typeof row.port === "string" ? row.port.trim().slice(0, 64) : "";
    devices.push({
      name,
      port,
      isDefault: row.isDefault === true,
      isUsb: row.isUsb === true,
      offline: row.offline === true,
    });
  }
  return devices;
}

/**
 * บันทึกผลสแกนเครื่องพิมพ์ที่ Hub agent ส่งมาพร้อม poll — หน้า Settings ใช้แสดง
 * รายการให้ร้านกดเลือกเครื่องพิมพ์ USB ได้ในคลิกเดียว (ไม่ต้องพิมพ์ชื่อเอง)
 */
export async function saveHubDevices(storeId: string, devices: unknown): Promise<{ error: AppError | null }> {
  const parsed = parseHubDevices(devices);
  const supabase = await createSupabaseServiceClient();
  const { error } = await supabase
    .from("stores")
    // HubDevice[] เป็นข้อมูลธรรมดา (string/boolean ล้วน) — cast เพื่อลงคอลัมน์ jsonb
    .update({
      print_hub_devices: parsed as unknown as Json,
      print_hub_devices_at: new Date().toISOString(),
    })
    .eq("id", storeId);
  return { error: error ? mapError(error) : null };
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

/** v3 — binding ของเครื่องพิมพ์ USB หนึ่งเครื่องที่ Hub ใช้เลือกปลายทาง */
export interface HubUsbBinding {
  printerId: string;
  name: string | null;
  identity: HubUsbIdentity | null;
  policy: "auto_single" | "confirm_multi" | "manual";
}

/** identity ที่เสถียรของเครื่องพิมพ์ USB (เก็บที่แถว printers ไม่ใช่ไฟล์บนเครื่องร้าน) */
export interface HubUsbIdentity {
  v: number;
  queueName: string | null;
  pnpDeviceId: string | null;
  vid: string | null;
  pid: string | null;
  serial: string | null;
  driverName: string | null;
}

const IDENTITY_FIELD_MAX = 256;

/** identity มาจากเครื่องของร้าน — เป็นข้อมูล ไม่ใช่คำสั่ง จึงตรวจรูปทรง+ตัดความยาวก่อนใช้ */
export function parseHubUsbIdentity(value: unknown): HubUsbIdentity | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const text = (key: string): string | null => {
    const raw = row[key];
    if (typeof raw !== "string") return null;
    const trimmed = raw.trim().slice(0, IDENTITY_FIELD_MAX);
    return trimmed || null;
  };
  const pnpDeviceId = text("pnpDeviceId");
  const vid = text("vid");
  const pid = text("pid");
  // identity ที่ไม่มีทั้ง pnp id และคู่ vid/pid ใช้จับคู่อะไรไม่ได้ ถือว่าไม่มี
  if (!pnpDeviceId && !(vid && pid)) return null;
  return {
    v: typeof row.v === "number" && Number.isFinite(row.v) ? row.v : 1,
    queueName: text("queueName"),
    pnpDeviceId,
    vid: vid ? vid.toUpperCase().slice(0, 8) : null,
    pid: pid ? pid.toUpperCase().slice(0, 8) : null,
    serial: text("serial"),
    driverName: text("driverName"),
  };
}

/** map jobId -> printerId ของงานที่เพิ่งเคลม (ใช้หา binding ของงาน USB) */
export async function getPrinterIdsForJobs(storeId: string, jobIds: string[]): Result<Record<string, string | null>> {
  const ids = [...new Set(jobIds.filter((id) => typeof id === "string" && id))];
  if (ids.length === 0) return { data: {}, error: null };
  const supabase = await createSupabaseServiceClient();
  const { data, error } = await supabase
    .from("print_jobs")
    .select("id, printer_id")
    .eq("store_id", storeId)
    .in("id", ids);
  if (error) return { data: null, error: mapError(error) };
  const map: Record<string, string | null> = {};
  for (const row of data ?? []) map[row.id] = row.printer_id;
  return { data: map, error: null };
}

/** อ่าน binding ของเครื่องพิมพ์ที่งาน USB ในคิวอ้างถึง (Hub เลือกปลายทางจากค่าล่าสุดเสมอ) */
export async function getUsbBindings(storeId: string, printerIds: string[]): Result<HubUsbBinding[]> {
  const ids = [...new Set(printerIds.filter((id) => typeof id === "string" && id))];
  if (ids.length === 0) return { data: [], error: null };
  const supabase = await createSupabaseServiceClient();
  const { data, error } = await supabase
    .from("printers")
    .select("id, hub_usb_name, hub_usb_identity, hub_usb_binding_policy")
    .eq("store_id", storeId)
    .in("id", ids);
  if (error) return { data: null, error: mapError(error) };
  const bindings = (data ?? []).map((row) => ({
    printerId: row.id,
    name: row.hub_usb_name,
    identity: parseHubUsbIdentity(row.hub_usb_identity),
    policy: row.hub_usb_binding_policy ?? "auto_single",
  }));
  return { data: bindings, error: null };
}

/**
 * จำ identity ของเครื่องพิมพ์ที่ "พิมพ์สำเร็จจริง" ไว้กับ binding (แผน v3 §4 ข้อ 3)
 * เขียนเฉพาะเมื่อยังไม่มี identity เดิม — ไม่แย่ง binding ที่คนเคยยืนยันไว้แล้ว
 */
export async function learnUsbIdentity(input: {
  storeId: string;
  printerId: string;
  identity: unknown;
}): Promise<{ error: AppError | null; learned: boolean }> {
  const identity = parseHubUsbIdentity(input.identity);
  if (!identity) return { error: null, learned: false };
  const supabase = await createSupabaseServiceClient();
  const { data, error } = await supabase
    .from("printers")
    .update({
      hub_usb_identity: identity as unknown as Json,
      hub_usb_name: identity.queueName ?? undefined,
    })
    .eq("id", input.printerId)
    .eq("store_id", input.storeId)
    .is("hub_usb_identity", null)
    .select("id");
  if (error) return { error: mapError(error), learned: false };
  return { error: null, learned: (data ?? []).length > 0 };
}

/** ตั้งระดับการเลือกเครื่องพิมพ์อัตโนมัติของร้าน (ผลกับงาน USB ทุกใบตั้งแต่รอบถัดไป) */
export async function setUsbBindingPolicy(input: {
  storeId: string;
  printerId: string;
  policy: "auto_single" | "confirm_multi" | "manual";
}): Promise<{ error: AppError | null }> {
  const supabase = await createSupabaseServiceClient();
  const { error } = await supabase
    .from("printers")
    .update({ hub_usb_binding_policy: input.policy })
    .eq("id", input.printerId)
    .eq("store_id", input.storeId);
  return { error: error ? mapError(error) : null };
}

/**
 * ลืมเครื่องที่ผูกไว้ — ล้างทั้งชื่อคิวและ identity
 * ใช้ตอนเปลี่ยนเครื่องพิมพ์ใหม่: ถ้าไม่ล้าง identity เดิม ระบบจะยังตามหาเครื่องเก่าที่ไม่มีแล้ว
 */
export async function forgetUsbBinding(input: {
  storeId: string;
  printerId: string;
}): Promise<{ error: AppError | null }> {
  const supabase = await createSupabaseServiceClient();
  const { error } = await supabase
    .from("printers")
    .update({ hub_usb_name: null, hub_usb_identity: null })
    .eq("id", input.printerId)
    .eq("store_id", input.storeId);
  return { error: error ? mapError(error) : null };
}
