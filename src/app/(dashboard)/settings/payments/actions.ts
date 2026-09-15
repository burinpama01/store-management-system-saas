"use server";

import { revalidatePath } from "next/cache";
import { requireFeature, requirePermission } from "@/modules/auth/guards";
import { getCurrentUser, getUserStores, resolveCurrentStore } from "@/modules/auth/session";
import { createSupabaseServerClient } from "@/server/integrations/supabase/server";
import { decodeTrueMoneyManualCredentials } from "@/modules/payments/credentials";
import { buildTrueMoneyShopStaticPayload } from "@/modules/payments/emv-qr";
import {
  disableTrueMoneyManualConfigForStore,
  saveTrueMoneyManualConfigForStore,
  testTrueMoneyManualConnection,
} from "@/modules/payments/service";
import type { TrueMoneyManualTestResult } from "@/modules/payments/types";

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

function resolvePayloadFromForm(
  formData: FormData,
  existingPayload: string | null,
): { payload: string; error: string | null } {
  const inputMode = ((formData.get("inputMode") as string | null) ?? "emv").trim();
  const pasted = (formData.get("staticEmvPayload") as string | null)?.trim() ?? "";
  const eWalletId = (formData.get("eWalletId") as string | null)?.trim() ?? "";
  const keepExisting = formData.get("keepExistingPayload") === "1";

  if (inputMode === "ewallet") {
    if (eWalletId) {
      const built = buildTrueMoneyShopStaticPayload(eWalletId);
      if (!built) {
        return { payload: "", error: "E-Wallet ID ไม่ถูกต้อง (ต้องเป็นตัวเลข 10–20 หลัก)" };
      }
      return { payload: built, error: null };
    }
    if (keepExisting && existingPayload) {
      return { payload: existingPayload, error: null };
    }
    return { payload: "", error: "กรุณาระบุ E-Wallet ID" };
  }

  // emv mode
  if (pasted) return { payload: pasted, error: null };
  if (keepExisting && existingPayload) return { payload: existingPayload, error: null };
  return { payload: "", error: "กรุณาวาง TrueMoney Shop QR (EMV payload)" };
}

export async function saveTrueMoneyManualConfigAction(
  _prev: { error: string | null; ok?: boolean },
  formData: FormData,
): Promise<{ error: string | null; ok?: boolean }> {
  try {
    await requirePermission("settings.manage_store");
    await requireFeature("byoPaymentGateway");
    const { user, ctx } = await getStoreContext();

    const existing = await loadExistingTrueMoneyPayload(ctx.storeId);
    const resolved = resolvePayloadFromForm(formData, existing);
    if (resolved.error || !resolved.payload) {
      return { error: resolved.error ?? "กรุณากรอกข้อมูล TrueMoney" };
    }

    const isEnabled = formData.get("isEnabled") === "1";
    const displayNameRaw = (formData.get("displayName") as string | null)?.trim() ?? "";
    const displayName = displayNameRaw || "TrueMoney Shop QR";

    const result = await saveTrueMoneyManualConfigForStore({
      organizationId: ctx.organizationId,
      storeId: ctx.storeId,
      staticEmvPayload: resolved.payload,
      isEnabled,
      displayName,
      actorUserId: user.id,
    });
    if (result.error) return { error: result.error };

    revalidatePath("/settings/payments");
    return { error: null, ok: true };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}

export async function testTrueMoneyManualConnectionAction(
  formData: FormData,
): Promise<TrueMoneyManualTestResult> {
  try {
    await requirePermission("settings.manage_store");
    await requireFeature("byoPaymentGateway");
    const { ctx } = await getStoreContext();

    const inputMode = ((formData.get("inputMode") as string | null) ?? "emv").trim();
    const pasted = (formData.get("staticEmvPayload") as string | null)?.trim() ?? "";
    const eWalletId = (formData.get("eWalletId") as string | null)?.trim() ?? "";
    const keepExisting = formData.get("keepExistingPayload") === "1";

    let staticEmvPayload: string | null = null;
    let eWallet: string | null = null;

    if (inputMode === "ewallet") {
      eWallet = eWalletId || null;
      if (!eWallet && keepExisting) {
        staticEmvPayload = null; // fall through to storeId load
      }
    } else {
      staticEmvPayload = pasted || null;
    }

    return await testTrueMoneyManualConnection({
      staticEmvPayload,
      eWalletId: eWallet,
      storeId: ctx.storeId,
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
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
