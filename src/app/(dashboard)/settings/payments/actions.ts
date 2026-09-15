"use server";

import { revalidatePath } from "next/cache";
import { requireFeature, requirePermission } from "@/modules/auth/guards";
import { getCurrentUser, getUserStores, resolveCurrentStore } from "@/modules/auth/session";
import { createSupabaseServerClient } from "@/server/integrations/supabase/server";
import { decodeTrueMoneyManualCredentials } from "@/modules/payments/credentials";
import {
  disableTrueMoneyManualConfigForStore,
  saveTrueMoneyManualConfigForStore,
} from "@/modules/payments/service";

async function getStoreContext() {
  const user = await getCurrentUser();
  if (!user) throw new Error("ไม่มีสิทธิ์เข้าถึง");
  const { organizations, stores, memberships } = await getUserStores();
  const ctx = await resolveCurrentStore(stores, organizations, memberships);
  if (!ctx) throw new Error("ไม่พบข้อมูลร้านค้า");
  return { user, ctx };
}

async function loadExistingTrueMoneyPayload(storeId: string): Promise<string | null> {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase
    .from("payment_provider_configs")
    .select("credentials_encrypted")
    .eq("store_id", storeId)
    .eq("provider_key", "truemoney")
    .eq("mode", "manual")
    .maybeSingle();
  const creds = decodeTrueMoneyManualCredentials(
    (data as { credentials_encrypted?: string | null } | null)?.credentials_encrypted,
  );
  return creds?.staticEmvPayload ?? null;
}

export async function saveTrueMoneyManualConfigAction(
  _prev: { error: string | null; ok?: boolean },
  formData: FormData,
): Promise<{ error: string | null; ok?: boolean }> {
  try {
    await requirePermission("settings.manage_store");
    await requireFeature("byoPaymentGateway");
    const { user, ctx } = await getStoreContext();

    const pasted = (formData.get("staticEmvPayload") as string | null)?.trim() ?? "";
    const keepExisting = formData.get("keepExistingPayload") === "1";
    const isEnabled = formData.get("isEnabled") === "1";

    let payload = pasted;
    if (!payload && keepExisting) {
      payload = (await loadExistingTrueMoneyPayload(ctx.storeId)) ?? "";
    }
    if (!payload) {
      return { error: "กรุณาวาง TrueMoney Shop QR (EMV payload)" };
    }

    const result = await saveTrueMoneyManualConfigForStore({
      organizationId: ctx.organizationId,
      storeId: ctx.storeId,
      staticEmvPayload: payload,
      isEnabled,
      actorUserId: user.id,
    });
    if (result.error) return { error: result.error };

    revalidatePath("/settings/payments");
    return { error: null, ok: true };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}

export async function disableTrueMoneyManualConfigAction(): Promise<{ error: string | null }> {
  try {
    await requirePermission("settings.manage_store");
    await requireFeature("byoPaymentGateway");
    const { user, ctx } = await getStoreContext();
    const result = await disableTrueMoneyManualConfigForStore({
      organizationId: ctx.organizationId,
      storeId: ctx.storeId,
      actorUserId: user.id,
    });
    if (result.error) return { error: result.error };
    revalidatePath("/settings/payments");
    return { error: null };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}
