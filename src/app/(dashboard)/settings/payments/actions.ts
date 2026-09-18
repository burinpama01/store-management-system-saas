"use server";

import { revalidatePath } from "next/cache";
import { requireFeature, requirePermission } from "@/modules/auth/guards";
import { getCurrentUser, getUserStores, resolveCurrentStore } from "@/modules/auth/session";
import { createSupabaseServerClient } from "@/server/integrations/supabase/server";
import { decodeTrueMoneyManualCredentials } from "@/modules/payments/credentials";
import { buildTrueMoneyShopStaticPayload } from "@/modules/payments/emv-qr";
import {
  cancelTrueMoneyManualPending,
  disableTrueMoneyManualConfigForStore,
  disableTrueMoneyOpenApiConfigForStore,
  recordTrueMoneyExternalRefund,
  saveTrueMoneyManualConfigForStore,
  saveTrueMoneyOpenApiConfigForStore,
  testTrueMoneyManualConnection,
  testTrueMoneyOpenApiConnection,
} from "@/modules/payments/service";
import {
  disableBeamConfigForStore,
  saveBeamConfigForStore,
  testBeamConnection,
} from "@/modules/payments/beam-service";
import type {
  BeamTestResult,
  TrueMoneyManualTestResult,
  TrueMoneyOpenApiTestResult,
} from "@/modules/payments/types";

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


export async function cancelTrueMoneyPendingAction(
  paymentId: string,
  reason: string,
): Promise<{ error: string | null; ok?: boolean }> {
  try {
    await requirePermission("settings.manage_store");
    await requireFeature("byoPaymentGateway");
    const { user, ctx } = await getStoreContext();
    const result = await cancelTrueMoneyManualPending({
      gatewayPaymentId: paymentId,
      storeId: ctx.storeId,
      organizationId: ctx.organizationId,
      actorUserId: user.id,
      reason,
    });
    if (!result.ok) return { error: result.error };
    revalidatePath("/settings/payments");
    return { error: null, ok: true };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}

export async function recordTrueMoneyExternalRefundAction(
  paymentId: string,
  note: string,
): Promise<{ error: string | null; ok?: boolean }> {
  try {
    await requirePermission("settings.manage_store");
    await requireFeature("byoPaymentGateway");
    const { user, ctx } = await getStoreContext();
    const result = await recordTrueMoneyExternalRefund({
      gatewayPaymentId: paymentId,
      storeId: ctx.storeId,
      organizationId: ctx.organizationId,
      actorUserId: user.id,
      note,
    });
    if (!result.ok) return { error: result.error };
    revalidatePath("/settings/payments");
    return { error: null, ok: true };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}


export async function saveTrueMoneyOpenApiConfigAction(
  _prev: { error: string | null; ok?: boolean },
  formData: FormData,
): Promise<{ error: string | null; ok?: boolean }> {
  try {
    await requirePermission("settings.manage_store");
    await requireFeature("byoPaymentGateway");
    const { user, ctx } = await getStoreContext();

    const webhookSecret = (formData.get("webhookSecret") as string | null)?.trim() ?? "";
    const keepExisting = formData.get("keepExistingSecret") === "1";
    const isEnabled = formData.get("isEnabled") === "1";
    const displayNameRaw = (formData.get("displayName") as string | null)?.trim() ?? "";
    const displayName = displayNameRaw || "TrueMoney Open API";

    if (!keepExisting && !webhookSecret) {
      return { error: "กรุณาวาง Webhook Secret จากแอป TrueMoney" };
    }

    const result = await saveTrueMoneyOpenApiConfigForStore({
      organizationId: ctx.organizationId,
      storeId: ctx.storeId,
      webhookSecret,
      keepExistingSecret: keepExisting && !webhookSecret,
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

export async function testTrueMoneyOpenApiConnectionAction(
  formData: FormData,
): Promise<TrueMoneyOpenApiTestResult> {
  try {
    await requirePermission("settings.manage_store");
    await requireFeature("byoPaymentGateway");
    const { ctx } = await getStoreContext();
    const webhookSecret = (formData.get("webhookSecret") as string | null)?.trim() ?? "";
    return await testTrueMoneyOpenApiConnection({
      storeId: ctx.storeId,
      webhookSecret: webhookSecret || null,
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}

export async function disableTrueMoneyOpenApiConfigAction(): Promise<{ error: string | null }> {
  try {
    await requirePermission("settings.manage_store");
    await requireFeature("byoPaymentGateway");
    const { user, ctx } = await getStoreContext();
    const result = await disableTrueMoneyOpenApiConfigForStore({
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


export async function saveBeamConfigAction(
  _prev: { error: string | null; ok?: boolean },
  formData: FormData,
): Promise<{ error: string | null; ok?: boolean }> {
  try {
    await requirePermission("settings.manage_store");
    await requireFeature("byoPaymentGateway");
    const { user, ctx } = await getStoreContext();
    const environment = formData.get("environment") === "test" ? "test" : "live";
    const result = await saveBeamConfigForStore({
      organizationId: ctx.organizationId,
      storeId: ctx.storeId,
      merchantId: ((formData.get("merchantId") as string | null) ?? "").trim(),
      apiKey: ((formData.get("apiKey") as string | null) ?? "").trim() || null,
      webhookHmacKey: ((formData.get("webhookHmacKey") as string | null) ?? "").trim() || null,
      environment,
      isEnabled: formData.get("isEnabled") === "1",
      actorUserId: user.id,
    });
    if (result.error) return { error: result.error };
    revalidatePath("/settings/payments");
    revalidatePath("/pos");
    return { error: null, ok: true };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}

export async function testBeamConnectionAction(formData: FormData): Promise<BeamTestResult> {
  try {
    await requirePermission("settings.manage_store");
    await requireFeature("byoPaymentGateway");
    const { ctx } = await getStoreContext();
    return await testBeamConnection({
      storeId: ctx.storeId,
      merchantId: ((formData.get("merchantId") as string | null) ?? "").trim() || null,
      apiKey: ((formData.get("apiKey") as string | null) ?? "").trim() || null,
      environment: formData.get("environment") === "test" ? "test" : "live",
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}

export async function disableBeamConfigAction(): Promise<{ error: string | null }> {
  try {
    await requirePermission("settings.manage_store");
    const { user, ctx } = await getStoreContext();
    const result = await disableBeamConfigForStore({
      organizationId: ctx.organizationId,
      storeId: ctx.storeId,
      actorUserId: user.id,
    });
    if (result.error) return result;
    revalidatePath("/settings/payments");
    revalidatePath("/pos");
    return { error: null };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}
