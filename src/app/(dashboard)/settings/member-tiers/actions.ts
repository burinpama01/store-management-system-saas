"use server";

import { revalidatePath } from "next/cache";
import { getResolvedCurrentPermissions } from "@/modules/auth/guards";
import { getOrganizationBillingState } from "@/modules/billing/billing-service";
import { DEFAULT_BILLING_STATE } from "@/modules/billing/types";
import { canUseMemberPrivileges } from "@/modules/members/access";
import { isOpsManagerRole } from "@/modules/operations/access";
import {
  getTierProgram,
  initializeTiers,
  saveTierBenefits,
  saveTierProgram,
  setTierProgramEnabled,
  type TierBenefit,
  type TierInitPreview,
} from "@/modules/member-tiers/repository";
import { validateTierBenefit, validateTierProgram, type TierProgramInput } from "@/modules/member-tiers/rules";
import { logSystemEvent } from "@/modules/system/event-log";

const LOCK = "ระดับสมาชิกใช้ได้เฉพาะแพ็กเกจ Enterprise";

async function guard() {
  const { user, ctx, resolved } = await getResolvedCurrentPermissions();
  if (!isOpsManagerRole(resolved.role)) return { error: "เฉพาะเจ้าของหรือแอดมินที่ตั้งค่าระดับสมาชิกได้" as const };
  const billing = (await getOrganizationBillingState(ctx.organizationId)) ?? DEFAULT_BILLING_STATE;
  if (!canUseMemberPrivileges(billing)) return { error: LOCK };
  return { user, ctx, error: null };
}

function log(level: "info" | "error", action: string, message: string, ctx: { organizationId: string; storeId: string }, userId: string, context?: Record<string, unknown>) {
  void logSystemEvent({ level, source: "member-tiers", action, message, organizationId: ctx.organizationId, storeId: ctx.storeId, actorUserId: userId, context });
}

export async function saveTierProgramAction(input: TierProgramInput): Promise<{ ok: boolean; error: string | null }> {
  try {
    const g = await guard();
    if (g.error !== null) return { ok: false, error: g.error };
    const invalid = validateTierProgram(input);
    if (invalid) return { ok: false, error: invalid };
    const result = await saveTierProgram(g.ctx.storeId, input);
    log(result.error ? "error" : "info", "saveTierProgram", result.error ? `บันทึกระดับสมาชิกไม่สำเร็จ: ${result.error}` : "บันทึกการตั้งค่าระดับสมาชิก", g.ctx, g.user.id, {
      metricMode: input.metricMode,
      cycleMonths: input.cycleMonths,
      downgradeOneStep: input.downgradeOneStep,
      tiers: input.tiers.length,
    });
    if (result.error !== null) return { ok: false, error: result.error };
    revalidatePath("/settings/member-tiers");
    return { ok: true, error: null };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "บันทึกไม่สำเร็จ" };
  }
}

/** ดูตัวอย่าง (dryRun) หรือเปิดใช้จริง — T5 เจ้าของเลือกเริ่มศูนย์/คำนวณย้อนหลัง */
export async function initializeTiersAction(
  mode: "zero" | "backfill",
  dryRun: boolean,
): Promise<{ ok: boolean; error: string | null; preview?: TierInitPreview }> {
  try {
    const g = await guard();
    if (g.error !== null) return { ok: false, error: g.error };
    const result = await initializeTiers(g.ctx.storeId, mode, dryRun);
    if (!dryRun || result.error) {
      log(result.error ? "error" : "info", "initializeTiers", result.error ? `เปิดใช้ระดับสมาชิกไม่สำเร็จ: ${result.error}` : `เปิดใช้ระดับสมาชิก (${mode === "backfill" ? "คำนวณย้อนหลัง" : "เริ่มจากศูนย์"})`, g.ctx, g.user.id, {
        mode,
        dryRun,
        members: result.data?.members ?? null,
      });
    }
    if (result.error !== null) return { ok: false, error: result.error };
    if (!dryRun) {
      revalidatePath("/settings/member-tiers");
      revalidatePath("/pos");
    }
    return { ok: true, error: null, preview: result.data };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "ดำเนินการไม่สำเร็จ" };
  }
}

export async function setTierProgramEnabledAction(enabled: boolean): Promise<{ ok: boolean; error: string | null }> {
  try {
    const g = await guard();
    if (g.error !== null) return { ok: false, error: g.error };
    const result = await setTierProgramEnabled(g.ctx.storeId, enabled);
    log(result.error ? "error" : "info", "setTierProgramEnabled", result.error ? `เปลี่ยนสถานะไม่สำเร็จ: ${result.error}` : enabled ? "เปิดระดับสมาชิก" : "ปิดระดับสมาชิก", g.ctx, g.user.id, { enabled });
    if (result.error !== null) return { ok: false, error: result.error };
    revalidatePath("/settings/member-tiers");
    revalidatePath("/pos");
    return { ok: true, error: null };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "บันทึกไม่สำเร็จ" };
  }
}

/** บันทึกสิทธิ์ตามระดับ (โค้ดรายเดือน) — ฝั่งฐานข้อมูลตรวจระดับซ้ำและสร้างคูปองเดือนนี้ให้ทุกสาขา */
export async function saveTierBenefitsAction(benefits: TierBenefit[]): Promise<{ ok: boolean; error: string | null }> {
  try {
    const g = await guard();
    if (g.error !== null) return { ok: false, error: g.error };
    if (benefits.length > 30) return { ok: false, error: "ตั้งสิทธิ์ได้สูงสุด 30 รายการ" };
    const program = await getTierProgram(g.ctx.organizationId);
    const maxRank = program?.tiers.length ? Math.max(...program.tiers.map((tier) => tier.rank)) : 0;
    if (maxRank < 1) return { ok: false, error: "ตั้งค่าระดับสมาชิกก่อน" };
    for (const benefit of benefits) {
      const invalid = validateTierBenefit(benefit, maxRank);
      if (invalid) return { ok: false, error: invalid };
    }
    const result = await saveTierBenefits(g.ctx.storeId, benefits);
    log(result.error ? "error" : "info", "saveTierBenefits", result.error ? `บันทึกสิทธิ์ตามระดับไม่สำเร็จ: ${result.error}` : "บันทึกสิทธิ์ตามระดับ", g.ctx, g.user.id, {
      benefits: benefits.length,
    });
    if (result.error !== null) return { ok: false, error: result.error };
    revalidatePath("/settings/member-tiers");
    revalidatePath("/customers");
    return { ok: true, error: null };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "บันทึกไม่สำเร็จ" };
  }
}
