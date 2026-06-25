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

type RedeemRewardActionResult = MemberActionResult & {
  voucher?: {
    code: string;
    rewardType: "discount" | "product";
    rewardName: string;
    discountKind: "amount" | "percentage" | null;
    discountValue: number | null;
    expiresAt: string;
  };
};

const PUBLIC_MEMBER_ERROR_MESSAGES = new Set([
  "ต้องเปิดจาก QR ของร้าน",
  "ไม่พบร้านนี้",
  "ระบบสมัครสมาชิก สะสมแต้ม และคูปองอยู่ในแพ็กเกจ Enterprise เท่านั้น",
  "ไม่สามารถตรวจสอบ QR ได้ กรุณาลองใหม่หรือแจ้งร้านค้า",
  "ไม่พบ QR สมัครสมาชิกนี้ กรุณาสแกน QR ล่าสุดจากร้าน",
  "ไม่พบสมาชิกของร้านนี้",
  "ต้องมีเบอร์โทรศัพท์เพื่อรับ OTP",
  "กรุณาระบุชื่อสำหรับสมัครสมาชิก",
  "กรุณาเข้าสู่ระบบหรือแจ้งร้านเพื่อยืนยันข้อมูลสมาชิก",
  "ขอ OTP บ่อยเกินไป กรุณารอสักครู่",
  "ส่ง OTP ไม่สำเร็จ กรุณาลองใหม่หรือแจ้งร้านค้า",
  "รหัส OTP ไม่ถูกต้องหรือหมดอายุ",
  "รหัส OTP ไม่ถูกต้อง",
  "รหัส OTP หมดอายุแล้ว กรุณาขอใหม่",
  "OTP นี้ถูกใช้แล้ว",
  "OTP หมดอายุแล้ว",
  "กรอก OTP ผิดเกินจำนวนที่กำหนด",
  "ไม่สามารถสร้างสมาชิกได้",
  "กรุณาเข้าสู่ระบบก่อนแลกของรางวัล",
  "ข้อมูลของรางวัลไม่ถูกต้อง",
  "idempotency key ไม่ถูกต้อง",
  "ไม่พบสมาชิกที่ใช้งาน",
  "ไม่พบของรางวัล",
  "แต้มสะสมไม่เพียงพอ",
  "ของรางวัลนี้ปิดใช้งานแล้ว",
  "ของรางวัลหมดแล้ว",
  "ของรางวัลหมด",
  "แต้มไม่พอแลกของรางวัล",
]);

function text(formData: FormData, key: string) {
  return String(formData.get(key) ?? "").trim();
}

function revalidateMemberPortal(storeSlug: string) {
  revalidatePath(`/member/${storeSlug}`, "page");
}

function logPublicMemberActionError(action: string, error: unknown) {
  console.warn("[member-portal] action failed", {
    action,
    error: error instanceof Error ? error.message : String(error),
  });
}

function publicMemberError(message: string | null | undefined, fallback: string) {
  if (!message) return fallback;
  if (PUBLIC_MEMBER_ERROR_MESSAGES.has(message)) return message;
  console.warn("[member-portal] internal error hidden", { message });
  return fallback;
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

    if (result.error || !result.data) {
      return { error: publicMemberError(result.error, "ส่ง OTP ไม่สำเร็จ กรุณาลองใหม่หรือแจ้งร้านค้า") };
    }
    return { error: null, otpId: result.data.otpId, maskedPhone: result.data.maskedPhone };
  } catch (e) {
    logPublicMemberActionError("requestMemberOtp", e);
    return { error: "ส่ง OTP ไม่สำเร็จ กรุณาลองใหม่หรือแจ้งร้านค้า" };
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
    if (result.error) return { error: publicMemberError(result.error, "ยืนยัน OTP ไม่สำเร็จ กรุณาลองใหม่หรือแจ้งร้านค้า") };
    revalidateMemberPortal(storeSlug);
    return { error: null };
  } catch (e) {
    logPublicMemberActionError("verifyMemberOtp", e);
    return { error: "ยืนยัน OTP ไม่สำเร็จ กรุณาลองใหม่หรือแจ้งร้านค้า" };
  }
}

export async function redeemMemberRewardAction(formData: FormData): Promise<RedeemRewardActionResult> {
  try {
    const storeSlug = text(formData, "storeSlug");
    const portalCode = text(formData, "portalCode");
    const rewardId = text(formData, "rewardId");
    if (!UUID_RE.test(rewardId)) return { error: "ข้อมูลของรางวัลไม่ถูกต้อง" };

    const portalData = await getCustomerPortalData(storeSlug, portalCode);
    if (!portalData.portalValid || !portalData.store) {
      return { error: publicMemberError(portalData.error, "ต้องเปิดจาก QR ของร้าน") };
    }
    if (!portalData.customer) return { error: "กรุณาเข้าสู่ระบบก่อนแลกของรางวัล" };

    const result = await redeemRewardForCurrentCustomer({
      organizationId: portalData.store.organizationId,
      storeId: portalData.store.id,
      customerId: portalData.customer.id,
      rewardId,
    });
    if (result.error) {
      return { error: publicMemberError(result.error.userMessage, "แลกของรางวัลไม่สำเร็จ กรุณาลองใหม่หรือแจ้งร้านค้า") };
    }

    revalidateMemberPortal(storeSlug);
    return {
      error: null,
      voucher: result.data
        ? {
            code: result.data.voucherCode,
            rewardType: result.data.rewardType,
            rewardName: result.data.rewardName,
            discountKind: result.data.discountKind,
            discountValue: result.data.discountValue,
            expiresAt: result.data.expiresAt,
          }
        : undefined,
    };
  } catch (e) {
    logPublicMemberActionError("redeemMemberReward", e);
    return { error: "แลกของรางวัลไม่สำเร็จ กรุณาลองใหม่หรือแจ้งร้านค้า" };
  }
}
