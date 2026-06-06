"use server";

import { revalidatePath } from "next/cache";
import { AuthorizationError, requireSystemAccess } from "@/modules/auth/guards";
import { getPlatformSettings, updatePlatformPromptPay } from "@/modules/billing/platform-settings";
import { decodeQrPayloadFromImage } from "@/modules/billing/qr-decode";
import { looksLikePromptPayPayload } from "@/modules/billing/promptpay-provider";

export interface PlatformSettingsState {
  error: string | null;
  ok: boolean;
  decodedPayload: string | null;
}

export async function updatePlatformSettingsAction(
  _prev: PlatformSettingsState,
  formData: FormData,
): Promise<PlatformSettingsState> {
  let user;
  try {
    user = await requireSystemAccess();
  } catch (e) {
    if (e instanceof AuthorizationError) {
      return { ok: false, error: "ต้องเป็นผู้ดูแลแพลตฟอร์ม", decodedPayload: null };
    }
    throw e;
  }

  const billingProvider = formData.get("billingProvider") === "stripe" ? "stripe" : "promptpay";
  const promptpayId = ((formData.get("promptpayId") as string | null) ?? "").trim() || null;
  const promptpayName = ((formData.get("promptpayName") as string | null) ?? "").trim() || null;

  const existing = await getPlatformSettings();
  let staticPayload = existing.promptpayStaticPayload;
  let decodedPayload: string | null = null;

  // If a QR image was uploaded, decode it to extract the EMVCo payload string.
  const file = formData.get("qrImage");
  if (file instanceof File && file.size > 0) {
    const buffer = Buffer.from(await file.arrayBuffer());
    const decoded = await decodeQrPayloadFromImage(buffer);
    if (!decoded) {
      return { ok: false, error: "อ่าน QR Code จากรูปไม่สำเร็จ กรุณาใช้รูปที่ชัดเจน", decodedPayload: null };
    }
    if (!looksLikePromptPayPayload(decoded)) {
      return { ok: false, error: "รูปนี้ไม่ใช่ QR PromptPay/EMVCo ที่ถูกต้อง", decodedPayload: null };
    }
    staticPayload = decoded;
    decodedPayload = decoded;
  }

  // Clearing the stored static payload (e.g. switching to a PromptPay id).
  if (formData.get("clearStaticPayload") === "1") {
    staticPayload = null;
  }

  const res = await updatePlatformPromptPay(
    {
      billingProvider,
      promptpayId,
      promptpayName,
      promptpayStaticPayload: staticPayload,
    },
    user.id,
  );
  if (!res.ok) return { ok: false, error: res.error?.userMessage ?? "บันทึกไม่สำเร็จ", decodedPayload: null };

  revalidatePath("/system/settings");
  return { ok: true, error: null, decodedPayload };
}
