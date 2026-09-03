"use server";

import { revalidatePath } from "next/cache";
import { logActionError } from "@/modules/system/event-log";
import { getResolvedCurrentPermissions } from "@/modules/auth/guards";
import { getOrganizationBillingState } from "@/modules/billing/billing-service";
import {
  DEFAULT_BILLING_STATE,
  canUseFeature,
  explainFeatureLock,
} from "@/modules/billing/types";
import { buildUniqueSlug } from "@/modules/auth/registration";
import { createSupabaseServiceClient } from "@/server/integrations/supabase/server";
import { mapError, type AppError } from "@/shared/utils/error";

export interface BranchActionState {
  error: string | null;
  ok?: boolean;
}

function formatBranchError(error: AppError): string {
  if (error.code === "23505") return "มีสาขาที่ใช้รหัสนี้แล้ว กรุณาใช้ชื่อสาขาอื่น";
  if (error.code === "42501" || error.code === "PGRST301") {
    return "บัญชีนี้ไม่มีสิทธิ์เพิ่มสาขา กรุณาตรวจสิทธิ์ผู้ใช้หรือใช้บัญชีเจ้าขององค์กร";
  }
  return "เพิ่มสาขาไม่สำเร็จ กรุณาลองอีกครั้ง";
}

async function createBranchStoreForAction(input: { organizationId: string; name: string }) {
  const supabase = await createSupabaseServiceClient();
  const { error } = await supabase
    .from("stores")
    .insert({
      organization_id: input.organizationId,
      name: input.name,
      slug: buildUniqueSlug(input.name, "store"),
      currency_code: "THB",
      timezone: "Asia/Bangkok",
      locale: "th-TH",
      is_active: true,
    })
    .select("id")
    .eq("organization_id", input.organizationId)
    .single();
  if (error) return { ok: false, error: mapError(error) };
  return { ok: true, error: null };
}

export async function createBranchAction(
  _prev: BranchActionState,
  formData: FormData,
): Promise<BranchActionState> {
  const { ctx, resolved } = await getResolvedCurrentPermissions();
  if (!resolved.can("settings.manage_store")) return { error: "คุณไม่มีสิทธิ์เพิ่มสาขา" };

  try {
    const billingState =
      (await getOrganizationBillingState(ctx.organizationId)) ??
      DEFAULT_BILLING_STATE;
    if (!canUseFeature(billingState, "multiBranchReporting")) {
      return {
        error:
          explainFeatureLock(billingState, "multiBranchReporting") ??
          "แพ็กเกจปัจจุบันยังไม่รองรับหลายสาขา",
      };
    }

    const name = ((formData.get("name") as string | null) ?? "").trim();
    if (!name) return { error: "กรุณากรอกชื่อสาขา" };
    if (name.length > 80) return { error: "ชื่อสาขายาวเกินไป" };

    const result = await createBranchStoreForAction({ organizationId: ctx.organizationId, name });
    if (result.error) return { error: formatBranchError(result.error) };

    revalidatePath("/settings/branches");
    revalidatePath("/settings/store");
    revalidatePath("/dashboard");
    return { error: null, ok: true };
  } catch (e) {
    logActionError({
      source: "settings.branches",
      action: "createBranchAction",
      error: e,
      organizationId: ctx.organizationId,
    });
    console.error("[branches] create branch failed", e);
    return { error: "เพิ่มสาขาไม่สำเร็จ กรุณาลองอีกครั้ง" };
  }
}
