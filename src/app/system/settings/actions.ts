"use server";

import { revalidatePath } from "next/cache";
import { AuthorizationError, requireSystemAccess } from "@/modules/auth/guards";
import { updatePlatformPromptPay } from "@/modules/billing/platform-settings";

export interface PlatformSettingsState {
  error: string | null;
  ok: boolean;
}

export async function updatePlatformSettingsAction(
  _prev: PlatformSettingsState,
  formData: FormData,
): Promise<PlatformSettingsState> {
  let user;
  try {
    user = await requireSystemAccess();
  } catch (e) {
    if (e instanceof AuthorizationError) return { ok: false, error: "ต้องเป็นผู้ดูแลแพลตฟอร์ม" };
    throw e;
  }

  const billingProvider = formData.get("billingProvider") === "stripe" ? "stripe" : "promptpay";
  const promptpayId = ((formData.get("promptpayId") as string | null) ?? "").trim() || null;
  const promptpayName = ((formData.get("promptpayName") as string | null) ?? "").trim() || null;
  const promptpayQrImagePath =
    ((formData.get("promptpayQrImagePath") as string | null) ?? "").trim() || null;

  const res = await updatePlatformPromptPay(
    { billingProvider, promptpayId, promptpayName, promptpayQrImagePath },
    user.id,
  );
  if (!res.ok) return { ok: false, error: res.error?.userMessage ?? "บันทึกไม่สำเร็จ" };

  revalidatePath("/system/settings");
  return { ok: true, error: null };
}
