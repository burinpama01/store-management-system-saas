import { createSupabaseServerClient, createSupabaseServiceClient } from "@/server/integrations/supabase/server";
import { opsErrorMessage } from "./rules";
import type {
  ChecklistAnswer,
  ChecklistEvent,
  ChecklistRun,
  ChecklistRunItem,
  ChecklistTemplate,
  ChecklistTemplateItem,
  TemplateInput,
} from "./types";

export const OPS_EVIDENCE_BUCKET = "staff-evidence";

type Result<T> = { data: T; error: null } | { data: null; error: string };

// ตาราง/RPC ใหม่ยังไม่อยู่ใน database.types (แบบเดียวกับ RPC cron อื่นในโปรเจกต์)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LooseClient = any;

async function userClient(): Promise<LooseClient> {
  return createSupabaseServerClient();
}

/* eslint-disable @typescript-eslint/no-explicit-any -- แถวดิบจาก PostgREST */
function num(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function mapTemplateItem(row: any): ChecklistTemplateItem {
  return {
    id: row.id,
    sortOrder: row.sort_order,
    label: row.label,
    description: row.description ?? null,
    critical: Boolean(row.critical),
    valueType: row.value_type,
    unit: row.unit ?? null,
    minValue: num(row.min_value),
    maxValue: num(row.max_value),
    photoRule: row.photo_rule,
  };
}

function mapTemplate(row: any): ChecklistTemplate {
  return {
    id: row.id,
    storeId: row.store_id,
    name: row.name,
    area: row.area ?? "",
    phase: row.phase,
    dueTime: row.due_time ? String(row.due_time).slice(0, 5) : null,
    daysOfWeek: (row.days_of_week ?? []).map(Number),
    requireBeforeClockOut: Boolean(row.require_before_clock_out),
    assigneeUserIds: row.assignee_user_ids ?? [],
    version: row.version,
    isActive: Boolean(row.is_active),
    sortOrder: row.sort_order ?? 0,
    updatedAt: row.updated_at,
    items: ((row.ops_checklist_template_items ?? []) as any[]).map(mapTemplateItem).sort((a, b) => a.sortOrder - b.sortOrder),
  };
}

function mapRunItem(row: any): ChecklistRunItem {
  return {
    id: row.id,
    sortOrder: row.sort_order,
    label: row.label,
    description: row.description ?? null,
    critical: Boolean(row.critical),
    valueType: row.value_type,
    unit: row.unit ?? null,
    minValue: num(row.min_value),
    maxValue: num(row.max_value),
    photoRule: row.photo_rule,
    answer: row.answer ?? null,
    value: num(row.value),
    note: row.note ?? null,
    photoPath: row.photo_path ?? null,
    answeredBy: row.answered_by ?? null,
    answeredAt: row.answered_at ?? null,
  };
}

function mapRun(row: any): ChecklistRun {
  return {
    id: row.id,
    storeId: row.store_id,
    organizationId: row.organization_id,
    templateId: row.template_id,
    templateVersion: row.template_version,
    templateName: row.template_name,
    area: row.area ?? "",
    phase: row.phase,
    shiftDate: row.shift_date,
    status: row.status,
    startedBy: row.started_by,
    startedAt: row.started_at,
    submittedBy: row.submitted_by ?? null,
    submittedAt: row.submitted_at ?? null,
    items: ((row.ops_checklist_run_items ?? []) as any[]).map(mapRunItem).sort((a, b) => a.sortOrder - b.sortOrder),
  };
}

function mapEvent(row: any): ChecklistEvent {
  return {
    id: row.id,
    templateId: row.template_id ?? null,
    runId: row.run_id ?? null,
    runItemId: row.run_item_id ?? null,
    actorUserId: row.actor_user_id,
    action: row.action,
    detail: (row.detail ?? {}) as Record<string, unknown>,
    createdAt: row.created_at,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export async function isOperationsEnabled(storeId: string): Promise<boolean> {
  const db = await userClient();
  const { data } = await db.from("stores").select("operations_enabled").eq("id", storeId).maybeSingle();
  return Boolean(data?.operations_enabled);
}

export async function setOperationsEnabled(storeId: string, enabled: boolean): Promise<Result<true>> {
  const db = await userClient();
  const { data, error } = await db
    .from("stores")
    .update({ operations_enabled: enabled })
    .eq("id", storeId)
    .select("id");
  if (error) return { data: null, error: error.message };
  // RLS ปฏิเสธแบบเงียบ = 0 แถว (บทเรียนจากการลบรายการบัญชี) — ต้องถือว่าไม่สำเร็จ
  if (!data || data.length === 0) return { data: null, error: "ไม่มีสิทธิ์เปลี่ยนการตั้งค่าร้าน" };
  return { data: true, error: null };
}

export async function listChecklistTemplates(
  storeId: string,
  opts: { includeInactive?: boolean } = {},
): Promise<Result<ChecklistTemplate[]>> {
  const db = await userClient();
  let query = db
    .from("ops_checklist_templates")
    .select("*, ops_checklist_template_items(*)")
    .eq("store_id", storeId)
    .order("sort_order")
    .order("created_at")
    .limit(200);
  if (!opts.includeInactive) query = query.eq("is_active", true);
  const { data, error } = await query;
  if (error) return { data: null, error: error.message };
  return { data: (data ?? []).map(mapTemplate), error: null };
}

export async function getChecklistTemplate(storeId: string, templateId: string): Promise<Result<ChecklistTemplate | null>> {
  const db = await userClient();
  const { data, error } = await db
    .from("ops_checklist_templates")
    .select("*, ops_checklist_template_items(*)")
    .eq("store_id", storeId)
    .eq("id", templateId)
    .maybeSingle();
  if (error) return { data: null, error: error.message };
  return { data: data ? mapTemplate(data) : null, error: null };
}

export async function listChecklistRuns(
  storeId: string,
  range: { from: string; to: string },
): Promise<Result<ChecklistRun[]>> {
  const db = await userClient();
  const { data, error } = await db
    .from("ops_checklist_runs")
    .select("*, ops_checklist_run_items(*)")
    .eq("store_id", storeId)
    .gte("shift_date", range.from)
    .lte("shift_date", range.to)
    .order("shift_date", { ascending: false })
    .order("started_at", { ascending: false });
  if (error) return { data: null, error: error.message };
  return { data: (data ?? []).map(mapRun), error: null };
}

export async function getChecklistRun(storeId: string, runId: string): Promise<Result<ChecklistRun | null>> {
  const db = await userClient();
  const { data, error } = await db
    .from("ops_checklist_runs")
    .select("*, ops_checklist_run_items(*)")
    .eq("store_id", storeId)
    .eq("id", runId)
    .maybeSingle();
  if (error) return { data: null, error: error.message };
  return { data: data ? mapRun(data) : null, error: null };
}

/** template ที่ส่งแล้วของกะนั้น — ใช้ตรวจตอนออกงาน (RLS: สมาชิกร้านอ่านได้) */
export async function listSubmittedTemplateIds(storeId: string, shiftDate: string): Promise<Result<Set<string>>> {
  const db = await userClient();
  const { data, error } = await db
    .from("ops_checklist_runs")
    .select("template_id")
    .eq("store_id", storeId)
    .eq("shift_date", shiftDate)
    .eq("status", "submitted");
  if (error) return { data: null, error: error.message };
  return { data: new Set((data ?? []).map((row: { template_id: string }) => row.template_id)), error: null };
}

/** ประวัติ (RLS: owner/admin เท่านั้น — staff ได้ [] เสมอ) */
export async function listChecklistEventsForRuns(storeId: string, runIds: string[]): Promise<Result<ChecklistEvent[]>> {
  if (runIds.length === 0) return { data: [], error: null };
  const db = await userClient();
  const { data, error } = await db
    .from("ops_checklist_events")
    .select("*")
    .eq("store_id", storeId)
    .in("run_id", runIds.slice(0, 200))
    .order("created_at", { ascending: true })
    .limit(2000);
  if (error) return { data: null, error: error.message };
  return { data: (data ?? []).map(mapEvent), error: null };
}

export async function listTemplateEvents(storeId: string, limit = 30): Promise<Result<ChecklistEvent[]>> {
  const db = await userClient();
  const { data, error } = await db
    .from("ops_checklist_events")
    .select("*")
    .eq("store_id", storeId)
    .in("action", ["template_created", "template_updated"])
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) return { data: null, error: error.message };
  return { data: (data ?? []).map(mapEvent), error: null };
}

export async function saveChecklistTemplate(
  storeId: string,
  templateId: string | null,
  input: TemplateInput,
): Promise<Result<string>> {
  const db = await userClient();
  const { data, error } = await db.rpc("ops_save_checklist_template", {
    p_store_id: storeId,
    p_template_id: templateId,
    p_payload: {
      name: input.name.trim(),
      area: input.area.trim(),
      phase: input.phase,
      due_time: input.dueTime,
      days_of_week: input.daysOfWeek,
      require_before_clock_out: input.requireBeforeClockOut,
      assignee_user_ids: input.assigneeUserIds,
      is_active: input.isActive,
      sort_order: input.sortOrder,
      items: input.items.map((item) => ({
        label: item.label.trim(),
        description: item.description,
        critical: item.critical,
        value_type: item.valueType,
        unit: item.unit,
        min_value: item.valueType === "number" ? item.minValue : null,
        max_value: item.valueType === "number" ? item.maxValue : null,
        photo_rule: item.photoRule,
      })),
    },
  });
  if (error) return { data: null, error: opsErrorMessage(error.message) };
  return { data: data as string, error: null };
}

export async function startChecklistRun(templateId: string, shiftDate: string | null): Promise<Result<string>> {
  const db = await userClient();
  const { data, error } = await db.rpc("ops_start_checklist_run", {
    p_template_id: templateId,
    p_shift_date: shiftDate,
  });
  if (error) return { data: null, error: opsErrorMessage(error.message) };
  return { data: data as string, error: null };
}

export interface AnswerResult {
  answer: ChecklistAnswer;
  value: number | null;
  outOfRange: boolean;
  notifyCriticalFail: boolean;
}

export async function answerChecklistItem(input: {
  runItemId: string;
  answer: ChecklistAnswer;
  value: number | null;
  note: string | null;
}): Promise<Result<AnswerResult>> {
  const db = await userClient();
  const { data, error } = await db.rpc("ops_answer_checklist_item", {
    p_run_item_id: input.runItemId,
    p_answer: input.answer,
    p_value: input.value,
    p_note: input.note,
  });
  if (error) return { data: null, error: opsErrorMessage(error.message) };
  return {
    data: {
      answer: data.answer,
      value: num(data.value),
      outOfRange: Boolean(data.out_of_range),
      notifyCriticalFail: Boolean(data.notify_critical_fail),
    },
    error: null,
  };
}

export async function attachChecklistPhoto(runItemId: string, path: string): Promise<Result<true>> {
  const db = await userClient();
  const { error } = await db.rpc("ops_attach_checklist_photo", { p_run_item_id: runItemId, p_path: path });
  if (error) return { data: null, error: opsErrorMessage(error.message) };
  return { data: true, error: null };
}

export async function submitChecklistRun(runId: string): Promise<Result<{ failCount: number; criticalFailCount: number }>> {
  const db = await userClient();
  const { data, error } = await db.rpc("ops_submit_checklist_run", { p_run_id: runId });
  if (error) return { data: null, error: opsErrorMessage(error.message) };
  return { data: { failCount: Number(data.fail_count ?? 0), criticalFailCount: Number(data.critical_fail_count ?? 0) }, error: null };
}

export async function reopenChecklistRun(runId: string, reason: string): Promise<Result<true>> {
  const db = await userClient();
  const { error } = await db.rpc("ops_reopen_checklist_run", { p_run_id: runId, p_reason: reason });
  if (error) return { data: null, error: opsErrorMessage(error.message) };
  return { data: true, error: null };
}

/** signed URL อายุสั้นสำหรับดูรูปหลักฐาน — เรียกหลังตรวจสิทธิ์/ร้านแล้วเท่านั้น */
export async function createEvidenceSignedUrls(paths: string[], expiresInSeconds = 600): Promise<Map<string, string>> {
  const unique = [...new Set(paths.filter(Boolean))];
  const urls = new Map<string, string>();
  if (unique.length === 0) return urls;
  const service = await createSupabaseServiceClient();
  const { data } = await service.storage.from(OPS_EVIDENCE_BUCKET).createSignedUrls(unique, expiresInSeconds);
  for (const entry of data ?? []) {
    if (entry.path && entry.signedUrl) urls.set(entry.path, entry.signedUrl);
  }
  return urls;
}

export interface DueChecklistAlert {
  organizationId: string;
  storeId: string;
  storeName: string;
  templateId: string;
  templateName: string;
  area: string;
  shiftDate: string;
  dueAtLocal: string;
  dedupeKey: string;
}

/** cron เท่านั้น (service role) */
export async function listDueChecklistAlerts(): Promise<Result<DueChecklistAlert[]>> {
  const service: LooseClient = await createSupabaseServiceClient();
  const { data, error } = await service.rpc("ops_checklist_due_alerts");
  if (error) return { data: null, error: error.message };
  return {
    data: ((data ?? []) as Array<Record<string, string>>).map((row) => ({
      organizationId: row.organization_id,
      storeId: row.store_id,
      storeName: row.store_name,
      templateId: row.template_id,
      templateName: row.template_name,
      area: row.area ?? "",
      shiftDate: row.shift_date,
      dueAtLocal: row.due_at_local,
      dedupeKey: row.dedupe_key,
    })),
    error: null,
  };
}

/** จอง dedupe key — true = เพิ่งจองได้ (ควรแจ้ง), false = มีคนแจ้งไปแล้ว */
export async function claimOpsNotification(key: string, organizationId: string, storeId: string): Promise<Result<boolean>> {
  const service: LooseClient = await createSupabaseServiceClient();
  const { data, error } = await service
    .from("ops_notification_log")
    .upsert({ dedupe_key: key, organization_id: organizationId, store_id: storeId }, { onConflict: "dedupe_key", ignoreDuplicates: true })
    .select("dedupe_key");
  if (error) return { data: null, error: error.message };
  return { data: (data ?? []).length > 0, error: null };
}
