"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import sharp from "sharp";
import { getCurrentUser, getUserStores, resolveCurrentStore } from "@/modules/auth/session";
import { getStoreLocalDate } from "@/modules/attendance/date";
import { notifyOwnerSafely } from "@/modules/notifications/dispatcher";
import {
  answerChecklistItem,
  attachChecklistPhoto,
  getChecklistRun,
  listChecklistTemplates,
  OPS_EVIDENCE_BUCKET,
  reopenChecklistRun,
  saveChecklistTemplate,
  setOperationsEnabled,
  startChecklistRun,
  submitChecklistRun,
} from "@/modules/operations/repository";
import { formatMeasuredValue, validateTemplateInput } from "@/modules/operations/rules";
import { buildStarterTemplates, isStorePackId, type StarterSelection } from "@/modules/operations/starter-packs";
import { isOpsManagerRole } from "@/modules/operations/access";
import type { ChecklistAnswer, TemplateInput } from "@/modules/operations/types";
import { logActionError, logSystemEvent } from "@/modules/system/event-log";
import { createSupabaseServiceClient } from "@/server/integrations/supabase/server";

const SOURCE = "operations.checklist";
const MAX_PHOTO_BYTES = 8 * 1024 * 1024;

export interface OpsActionState {
  ok: boolean;
  error: string | null;
}

async function getOpsContext() {
  const user = await getCurrentUser();
  if (!user) throw new Error("กรุณาเข้าสู่ระบบใหม่");
  const { organizations, stores, memberships } = await getUserStores();
  const ctx = await resolveCurrentStore(stores, organizations, memberships);
  if (!ctx) throw new Error("ไม่พบข้อมูลร้านค้า");
  return { user, ctx, isManager: isOpsManagerRole(ctx.role) };
}

function actorLabel(user: { email?: string | null; id: string }): string {
  return (user.email ?? user.id).slice(0, 100);
}

async function logOps(input: {
  action: string;
  ok: boolean;
  message: string;
  organizationId: string;
  storeId: string;
  actorUserId: string;
  context?: Record<string, unknown>;
}) {
  await logSystemEvent({
    level: input.ok ? "info" : "warn",
    source: SOURCE,
    action: input.action,
    message: input.message,
    organizationId: input.organizationId,
    storeId: input.storeId,
    actorUserId: input.actorUserId,
    context: input.context,
  });
}

function fail(error: unknown): OpsActionState {
  return { ok: false, error: error instanceof Error ? error.message : "เกิดข้อผิดพลาด" };
}

/* ── พนักงาน ─────────────────────────────────────────────── */

export async function startChecklistRunAction(templateId: string): Promise<OpsActionState> {
  let runId: string;
  try {
    const { user, ctx } = await getOpsContext();
    const shiftDate = getStoreLocalDate(ctx.storeTimezone, new Date());
    const result = await startChecklistRun(templateId, shiftDate);
    await logOps({
      action: "startRun",
      ok: !result.error,
      message: result.error ? `เริ่มเช็กลิสต์ไม่สำเร็จ: ${result.error}` : "เริ่ม/เปิดเช็กลิสต์",
      organizationId: ctx.organizationId,
      storeId: ctx.storeId,
      actorUserId: user.id,
      context: { templateId, shiftDate, runId: result.data },
    });
    if (result.error !== null) return { ok: false, error: result.error };
    runId = result.data;
  } catch (error) {
    return fail(error);
  }
  redirect(`/ops/run/${runId}`);
}

export async function answerChecklistItemAction(input: {
  runId: string;
  runItemId: string;
  answer: ChecklistAnswer;
  value: number | null;
  note: string | null;
}): Promise<OpsActionState & { answer?: ChecklistAnswer; outOfRange?: boolean }> {
  try {
    const { user, ctx } = await getOpsContext();
    if (input.value !== null && (!Number.isFinite(input.value) || Math.abs(input.value) >= 1e8)) {
      return { ok: false, error: "ค่าที่กรอกไม่ถูกต้อง" };
    }
    const result = await answerChecklistItem({
      runItemId: input.runItemId,
      answer: input.answer,
      value: input.value,
      note: input.note?.trim() ? input.note.trim().slice(0, 1000) : null,
    });
    if (result.error !== null) {
      await logOps({
        action: "answerItem",
        ok: false,
        message: `บันทึกคำตอบไม่สำเร็จ: ${result.error}`,
        organizationId: ctx.organizationId,
        storeId: ctx.storeId,
        actorUserId: user.id,
        context: { runId: input.runId, runItemId: input.runItemId },
      });
      return { ok: false, error: result.error };
    }

    if (result.data.notifyCriticalFail) {
      const run = await getChecklistRun(ctx.storeId, input.runId);
      const item = run.data?.items.find((entry) => entry.id === input.runItemId);
      if (run.data && item) {
        const valueText = item.valueType === "number"
          ? ` = ${formatMeasuredValue(result.data.value, item.unit, item.minValue, item.maxValue)}`
          : "";
        notifyOwnerSafely({
          type: "ops_checklist",
          organizationId: ctx.organizationId,
          storeId: ctx.storeId,
          title: "เช็กลิสต์: ข้อสำคัญไม่ผ่าน",
          message: `${run.data.templateName} · ${item.label}${valueText} — ${input.note?.trim() ?? ""} (โดย ${actorLabel(user)})`,
          metadata: {
            event: "critical_fail",
            runId: run.data.id,
            runItemId: item.id,
            templateName: run.data.templateName,
            itemLabel: item.label,
            employeeName: actorLabel(user),
          },
        });
      }
    }

    await logOps({
      action: "answerItem",
      ok: true,
      message: `บันทึกคำตอบ ${result.data.answer}${result.data.outOfRange ? " (ค่าเกินช่วง)" : ""}`,
      organizationId: ctx.organizationId,
      storeId: ctx.storeId,
      actorUserId: user.id,
      context: { runId: input.runId, runItemId: input.runItemId, notified: result.data.notifyCriticalFail },
    });
    revalidatePath(`/ops/run/${input.runId}`);
    return { ok: true, error: null, answer: result.data.answer, outOfRange: result.data.outOfRange };
  } catch (error) {
    logActionError({ source: SOURCE, action: "answerItem", error });
    return fail(error);
  }
}

export async function uploadChecklistPhotoAction(formData: FormData): Promise<OpsActionState> {
  try {
    const { user, ctx } = await getOpsContext();
    const runId = String(formData.get("runId") ?? "");
    const runItemId = String(formData.get("runItemId") ?? "");
    const file = formData.get("file");
    if (!(file instanceof File) || file.size === 0) return { ok: false, error: "ไม่พบไฟล์รูป" };
    if (file.size > MAX_PHOTO_BYTES) return { ok: false, error: "ไฟล์รูปใหญ่เกิน 8MB" };
    if (file.type && !file.type.startsWith("image/")) return { ok: false, error: "แนบได้เฉพาะไฟล์รูป" };

    // path มาจาก run ที่อ่านได้ภายใต้ RLS ของผู้ใช้ — ไม่เชื่อ path จาก client
    const run = await getChecklistRun(ctx.storeId, runId);
    if (run.error || !run.data) return { ok: false, error: "ไม่พบรอบเช็กลิสต์" };
    if (!run.data.items.some((item) => item.id === runItemId)) return { ok: false, error: "ไม่พบข้อในเช็กลิสต์" };
    if (run.data.status !== "in_progress") return { ok: false, error: "เช็กลิสต์นี้ส่งแล้ว" };

    let jpeg: Buffer;
    try {
      jpeg = await sharp(Buffer.from(await file.arrayBuffer()))
        .rotate()
        .resize({ width: 1280, height: 1280, fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 78 })
        .toBuffer();
    } catch {
      return { ok: false, error: "อ่านไฟล์รูปไม่ได้" };
    }

    const path = `${run.data.organizationId}/${run.data.storeId}/ops/${run.data.id}/${runItemId}-${randomUUID()}.jpg`;
    const service = await createSupabaseServiceClient();
    const upload = await service.storage.from(OPS_EVIDENCE_BUCKET).upload(path, jpeg, {
      contentType: "image/jpeg",
      upsert: false,
    });
    if (upload.error !== null) {
      await logOps({
        action: "uploadPhoto",
        ok: false,
        message: `อัปโหลดรูปไม่สำเร็จ: ${upload.error.message}`,
        organizationId: ctx.organizationId,
        storeId: ctx.storeId,
        actorUserId: user.id,
        context: { runId, runItemId },
      });
      return { ok: false, error: "อัปโหลดรูปไม่สำเร็จ" };
    }

    const attached = await attachChecklistPhoto(runItemId, path);
    if (attached.error !== null) {
      // ผูกไม่สำเร็จ = ลบไฟล์ทิ้ง ไม่ให้มีไฟล์ลอยที่ไม่มีใครอ้างถึง
      await service.storage.from(OPS_EVIDENCE_BUCKET).remove([path]);
    }
    await logOps({
      action: "uploadPhoto",
      ok: !attached.error,
      message: attached.error ? `ผูกรูปไม่สำเร็จ: ${attached.error}` : "แนบรูปหลักฐาน",
      organizationId: ctx.organizationId,
      storeId: ctx.storeId,
      actorUserId: user.id,
      context: { runId, runItemId, bytes: jpeg.length },
    });
    if (attached.error !== null) return { ok: false, error: attached.error };
    revalidatePath(`/ops/run/${runId}`);
    return { ok: true, error: null };
  } catch (error) {
    logActionError({ source: SOURCE, action: "uploadPhoto", error });
    return fail(error);
  }
}

export async function submitChecklistRunAction(runId: string): Promise<OpsActionState> {
  try {
    const { user, ctx } = await getOpsContext();
    const result = await submitChecklistRun(runId);
    await logOps({
      action: "submitRun",
      ok: !result.error,
      message: result.error ? `ส่งเช็กลิสต์ไม่สำเร็จ: ${result.error}` : "ส่งเช็กลิสต์",
      organizationId: ctx.organizationId,
      storeId: ctx.storeId,
      actorUserId: user.id,
      context: { runId, ...(result.data ?? {}) },
    });
    if (result.error !== null) return { ok: false, error: result.error };

    if (result.data.failCount > 0) {
      const run = await getChecklistRun(ctx.storeId, runId);
      const name = run.data?.templateName ?? "เช็กลิสต์";
      notifyOwnerSafely({
        type: "ops_checklist",
        organizationId: ctx.organizationId,
        storeId: ctx.storeId,
        title: "ส่งเช็กลิสต์ — มีข้อไม่ผ่าน",
        message: `${name}: ไม่ผ่าน ${result.data.failCount} ข้อ (สำคัญ ${result.data.criticalFailCount}) โดย ${actorLabel(user)}`,
        metadata: {
          event: "submitted_with_fail",
          runId,
          templateName: name,
          failCount: result.data.failCount,
          criticalFailCount: result.data.criticalFailCount,
          employeeName: actorLabel(user),
        },
      });
    }
    revalidatePath("/ops");
    revalidatePath(`/ops/run/${runId}`);
    return { ok: true, error: null };
  } catch (error) {
    logActionError({ source: SOURCE, action: "submitRun", error });
    return fail(error);
  }
}

/* ── เจ้าของ / admin ─────────────────────────────────────────── */

export async function reopenChecklistRunAction(runId: string, reason: string): Promise<OpsActionState> {
  try {
    const { user, ctx, isManager } = await getOpsContext();
    if (!isManager) return { ok: false, error: "ไม่มีสิทธิ์ทำรายการนี้" };
    const result = await reopenChecklistRun(runId, reason);
    await logOps({
      action: "reopenRun",
      ok: !result.error,
      message: result.error ? `เปิดรอบใหม่ไม่สำเร็จ: ${result.error}` : "เปิดเช็กลิสต์ที่ส่งแล้วให้แก้ใหม่",
      organizationId: ctx.organizationId,
      storeId: ctx.storeId,
      actorUserId: user.id,
      context: { runId },
    });
    if (result.error !== null) return { ok: false, error: result.error };
    revalidatePath(`/ops/run/${runId}`);
    revalidatePath("/ops");
    return { ok: true, error: null };
  } catch (error) {
    return fail(error);
  }
}

export async function saveChecklistTemplateAction(
  templateId: string | null,
  input: TemplateInput,
): Promise<OpsActionState & { templateId?: string }> {
  try {
    const { user, ctx, isManager } = await getOpsContext();
    if (!isManager) return { ok: false, error: "ไม่มีสิทธิ์ทำรายการนี้" };
    const invalid = validateTemplateInput(input);
    if (invalid) return { ok: false, error: invalid };
    const result = await saveChecklistTemplate(ctx.storeId, templateId, input);
    await logOps({
      action: "saveTemplate",
      ok: !result.error,
      message: result.error ? `บันทึกเช็กลิสต์ไม่สำเร็จ: ${result.error}` : `บันทึกเช็กลิสต์ “${input.name}”`,
      organizationId: ctx.organizationId,
      storeId: ctx.storeId,
      actorUserId: user.id,
      context: { templateId: result.data ?? templateId, itemCount: input.items.length },
    });
    if (result.error !== null) return { ok: false, error: result.error };
    revalidatePath("/ops");
    revalidatePath("/ops/templates");
    revalidatePath("/settings/operations");
    return { ok: true, error: null, templateId: result.data };
  } catch (error) {
    return fail(error);
  }
}

export async function createStarterPackTemplatesAction(
  selection: StarterSelection,
): Promise<OpsActionState & { created?: number; skipped?: number }> {
  try {
    const { user, ctx, isManager } = await getOpsContext();
    if (!isManager) return { ok: false, error: "ไม่มีสิทธิ์ทำรายการนี้" };
    const packs = Array.isArray(selection?.packs) ? selection.packs.filter(isStorePackId) : [];
    if (packs.length === 0) return { ok: false, error: "เลือกประเภทร้านอย่างน้อย 1 อย่าง" };
    const kitchenNames = Array.isArray(selection?.kitchenNames)
      ? selection.kitchenNames.filter((name): name is string => typeof name === "string")
      : [];
    const templates = buildStarterTemplates({ packs, kitchenNames });

    const existing = await listChecklistTemplates(ctx.storeId, { includeInactive: true });
    if (existing.error !== null) return { ok: false, error: existing.error };
    const names = new Set(existing.data.map((template) => template.name));
    const baseSort = existing.data.reduce((max, template) => Math.max(max, template.sortOrder + 1), 0);
    let created = 0;
    let skipped = 0;
    for (const starter of templates) {
      // ชื่อซ้ำกับที่มีอยู่ = ข้าม ไม่เขียนทับของที่เจ้าของแก้ไว้แล้ว
      if (names.has(starter.name)) {
        skipped += 1;
        continue;
      }
      const result = await saveChecklistTemplate(ctx.storeId, null, {
        name: starter.name,
        area: starter.area,
        phase: starter.phase,
        dueTime: starter.dueTime,
        daysOfWeek: starter.daysOfWeek,
        requireBeforeClockOut: starter.requireBeforeClockOut,
        items: starter.items,
        // สร้างแบบปิดใช้และไม่มีผู้รับผิดชอบ — เจ้าของตรวจ/แก้ก่อนเปิด
        assigneeUserIds: [],
        isActive: false,
        sortOrder: baseSort + starter.sortOrder,
      });
      if (result.error !== null) {
        await logOps({
          action: "createStarterPacks",
          ok: false,
          message: `สร้างแม่แบบ “${starter.name}” ไม่สำเร็จ: ${result.error}`,
          organizationId: ctx.organizationId,
          storeId: ctx.storeId,
          actorUserId: user.id,
          context: { packs, created },
        });
        // ชุดที่สร้างไปแล้วยังอยู่ (ไม่ rollback — กดสร้างซ้ำระบบข้ามชื่อซ้ำเอง) ต้องให้หน้าเห็นทันที
        if (created > 0) {
          revalidatePath("/ops/templates");
          revalidatePath("/settings/operations");
        }
        return { ok: false, error: `สร้าง “${starter.name}” ไม่สำเร็จ: ${result.error} (สร้างไปแล้ว ${created} ชุด — กดสร้างอีกครั้งเพื่อทำต่อ)` };
      }
      names.add(starter.name);
      created += 1;
    }
    await logOps({
      action: "createStarterPacks",
      ok: true,
      message: `สร้างเช็กลิสต์จากแม่แบบ ${created} ชุด (ข้ามชื่อซ้ำ ${skipped})`,
      organizationId: ctx.organizationId,
      storeId: ctx.storeId,
      actorUserId: user.id,
      context: { packs, kitchenCount: kitchenNames.length, created, skipped },
    });
    revalidatePath("/ops/templates");
    revalidatePath("/settings/operations");
    return { ok: true, error: null, created, skipped };
  } catch (error) {
    return fail(error);
  }
}

export async function setOperationsEnabledAction(enabled: boolean): Promise<OpsActionState> {
  try {
    const { user, ctx, isManager } = await getOpsContext();
    if (!isManager) return { ok: false, error: "ไม่มีสิทธิ์ทำรายการนี้" };
    const result = await setOperationsEnabled(ctx.storeId, enabled);
    await logOps({
      action: "setEnabled",
      ok: !result.error,
      message: result.error ? `เปลี่ยนสถานะระบบไม่สำเร็จ: ${result.error}` : enabled ? "เปิดระบบงานหน้าร้าน" : "ปิดระบบงานหน้าร้าน",
      organizationId: ctx.organizationId,
      storeId: ctx.storeId,
      actorUserId: user.id,
      context: { enabled },
    });
    if (result.error !== null) return { ok: false, error: result.error };
    revalidatePath("/", "layout");
    revalidatePath("/settings/operations");
    return { ok: true, error: null };
  } catch (error) {
    return fail(error);
  }
}
