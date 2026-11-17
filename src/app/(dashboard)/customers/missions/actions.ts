"use server";

import { revalidatePath } from "next/cache";
import { getResolvedCurrentPermissions } from "@/modules/auth/guards";
import { getOrganizationBillingState } from "@/modules/billing/billing-service";
import { DEFAULT_BILLING_STATE } from "@/modules/billing/types";
import { canUseMemberPrivileges } from "@/modules/members/access";
import { saveStoreMission, setMissionsEnabled } from "@/modules/missions/repository";
import { validateMissionInput, type MissionInput } from "@/modules/missions/rules";
import { isOpsManagerRole } from "@/modules/operations/access";
import { logSystemEvent } from "@/modules/system/event-log";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOCK = "ภารกิจสะสมใช้ได้เฉพาะแพ็กเกจ Enterprise";

async function managerContext() {
  const { user, ctx, resolved } = await getResolvedCurrentPermissions();
  if (!isOpsManagerRole(resolved.role)) return { error: "เฉพาะเจ้าของหรือแอดมินที่ตั้งภารกิจได้" as const };
  const billing = (await getOrganizationBillingState(ctx.organizationId)) ?? DEFAULT_BILLING_STATE;
  if (!canUseMemberPrivileges(billing)) return { user, ctx, error: LOCK };
  return { user, ctx, error: null };
}

/** สร้าง/แก้ภารกิจ — รอบที่ลูกค้ารับไปแล้วยังใช้เป้า/เพดานเดิม (snapshot ตอนกดรับ) */
export async function saveMissionAction(missionId: string | null, input: MissionInput): Promise<{ ok: boolean; error: string | null }> {
  try {
    const m = await managerContext();
    if (m.error !== null || !("ctx" in m)) return { ok: false, error: m.error };
    if (missionId !== null && !UUID_RE.test(missionId)) return { ok: false, error: "ข้อมูลภารกิจไม่ถูกต้อง" };
    const ids = [...input.categoryIds, ...input.productIds, ...(input.rewardProductId ? [input.rewardProductId] : [])];
    if (ids.some((id) => !UUID_RE.test(id))) return { ok: false, error: "สินค้า/หมวดที่เลือกไม่ถูกต้อง" };
    const invalid = validateMissionInput(input);
    if (invalid) return { ok: false, error: invalid };

    const result = await saveStoreMission(m.ctx.storeId, missionId, input);
    await logSystemEvent({
      level: result.error ? "error" : "info",
      source: "missions.admin",
      action: "saveMission",
      message: result.error ? `บันทึกภารกิจไม่สำเร็จ: ${result.error}` : missionId ? "แก้ภารกิจ" : "สร้างภารกิจ",
      organizationId: m.ctx.organizationId,
      storeId: m.ctx.storeId,
      actorUserId: m.user.id,
      context: {
        missionId: result.data ?? missionId,
        scope: input.scope,
        targetCount: input.targetCount,
        maxPerOrder: input.maxPerOrder,
        durationDays: input.durationDays,
        repeatable: input.repeatable,
        rewardType: input.rewardType,
        status: input.status,
      },
    });
    if (result.error !== null) return { ok: false, error: result.error };
    revalidatePath("/customers/missions");
    return { ok: true, error: null };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "บันทึกไม่สำเร็จ" };
  }
}

export async function setMissionsEnabledAction(enabled: boolean): Promise<{ ok: boolean; error: string | null }> {
  try {
    const m = await managerContext();
    // ไม่ใช่ Enterprise แล้วยังปิดภารกิจได้ (เพื่อหยุดนับ) แต่เปิดไม่ได้
    if (!("ctx" in m) || (m.error !== null && !(m.error === LOCK && !enabled))) return { ok: false, error: m.error };
    const { user, ctx } = m;
    const result = await setMissionsEnabled(ctx.storeId, enabled);
    await logSystemEvent({
      level: result.error ? "error" : "info",
      source: "missions.admin",
      action: "setMissionsEnabled",
      message: result.error ? `เปลี่ยนสวิตช์ภารกิจไม่สำเร็จ: ${result.error}` : enabled ? "เปิดภารกิจสะสมของสาขา" : "ปิดภารกิจสะสมของสาขา",
      organizationId: ctx.organizationId,
      storeId: ctx.storeId,
      actorUserId: user.id,
      context: { enabled },
    });
    if (result.error !== null) return { ok: false, error: result.error };
    revalidatePath("/customers/missions");
    return { ok: true, error: null };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "บันทึกไม่สำเร็จ" };
  }
}
