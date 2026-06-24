"use server";

import { revalidatePath } from "next/cache";
import {
  getCustomerPortalData,
  requestMemberOtp,
  verifyMemberOtp,
} from "@/modules/customers/member-repository";
import { redeemRewardForCurrentCustomer } from "@/modules/loyalty/repository";
import { sendSmskubOtp } from "@/modules/notifications/smskub";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type MemberActionResult = {
  error: string | null;
  otpId?: string;
  maskedPhone?: string;
};

function text(formData: FormData, key: string) {
  return String(formData.get(key) ?? "").trim();
}

function revalidateMemberPortal(storeSlug: string) {
  revalidatePath(`/member/${storeSlug}`, "page");
}

export async function requestMemberOtpAction(formData: FormData): Promise<MemberActionResult> {
  try {
    const storeSlug = text(formData, "storeSlug");
    const portalCode = text(formData, "portalCode");
    const mode = text(formData, "mode") === "login" ? "login" : "register";
    const result = await requestMemberOtp(
      {
        storeSlug,
        portalCode,
        mode,
        name: text(formData, "name"),
        phone: text(formData, "phone"),
        email: text(formData, "email"),
        identifier: text(formData, "identifier"),
      },
      sendSmskubOtp,
    );

    if (result.error || !result.data) return { error: result.error ?? "ส่ง OTP ไม่สำเร็จ" };
    return { error: null, otpId: result.data.otpId, maskedPhone: result.data.maskedPhone };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}

export async function verifyMemberOtpAction(formData: FormData): Promise<MemberActionResult> {
  try {
    const storeSlug = text(formData, "storeSlug");
    const result = await verifyMemberOtp({
      storeSlug,
      portalCode: text(formData, "portalCode"),
      otpId: text(formData, "otpId"),
      code: text(formData, "code"),
    });
    if (result.error) return { error: result.error };
    revalidateMemberPortal(storeSlug);
    return { error: null };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}

export async function redeemMemberRewardAction(formData: FormData): Promise<MemberActionResult> {
  try {
    const storeSlug = text(formData, "storeSlug");
    const portalCode = text(formData, "portalCode");
    const rewardId = text(formData, "rewardId");
    if (!UUID_RE.test(rewardId)) return { error: "ข้อมูลของรางวัลไม่ถูกต้อง" };

    const portalData = await getCustomerPortalData(storeSlug, portalCode);
    if (!portalData.portalValid || !portalData.store) return { error: portalData.error ?? "ต้องเปิดจาก QR ของร้าน" };
    if (!portalData.customer) return { error: "กรุณาเข้าสู่ระบบก่อนแลกของรางวัล" };

    const result = await redeemRewardForCurrentCustomer({
      organizationId: portalData.store.organizationId,
      storeId: portalData.store.id,
      customerId: portalData.customer.id,
      rewardId,
    });
    if (result.error) return { error: result.error.userMessage };

    revalidateMemberPortal(storeSlug);
    return { error: null };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}
