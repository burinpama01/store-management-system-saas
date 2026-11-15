"use server";

import { revalidatePath } from "next/cache";
import {
  getCustomerPortalData,
  requestMemberOtp,
  signOutMemberSession,
  verifyMemberOtp,
} from "@/modules/customers/member-repository";
import { redeemRewardForCurrentCustomer } from "@/modules/loyalty/repository";
import { deliverMemberOtp, verifyProviderOtp } from "@/modules/notifications/smskub";
import { claimLoyaltyPointsWithCode } from "@/modules/loyalty/claim-repository";
import { logActionError, logSystemEvent } from "@/modules/system/event-log";
import { issueMemberRedeemCode } from "@/modules/members/repository";
import { cancelPassPurchase, checkPassPurchase, startPassPurchase } from "@/modules/prepaid-passes/member-portal";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type MemberActionResult = {
  error: string | null;
  otpId?: string;
  maskedPhone?: string;
  /** ข้อความบอกสถานะที่ไม่ใช่ข้อผิดพลาด เช่น เข้าบัญชีเดิมที่มีอยู่แล้ว */
  notice?: string | null;
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
  "ยืนยัน OTP ไม่สำเร็จ กรุณาลองใหม่อีกครั้ง",
  "กรุณารอ 60 วินาทีก่อนขอรหัส OTP ใหม่",
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
      deliverMemberOtp,
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
    const result = await verifyMemberOtp(
      {
        storeSlug,
        portalCode: text(formData, "portalCode"),
        otpId: text(formData, "otpId"),
        code: text(formData, "code"),
      },
      verifyProviderOtp,
    );
    if (result.error) return { error: publicMemberError(result.error, "ยืนยัน OTP ไม่สำเร็จ กรุณาลองใหม่หรือแจ้งร้านค้า") };
    revalidateMemberPortal(storeSlug);

    // เบอร์นี้เป็นสมาชิกอยู่แล้วและมีค่าที่กรอกใหม่ขัดกับของเดิม — บอกตามตรง
    // ดีกว่าทิ้งเงียบแล้วให้ลูกค้าสงสัยว่าทำไมข้อมูลไม่เปลี่ยน (audit ข้อ 10)
    const ignored = result.data?.ignoredFields ?? [];
    if (result.data?.matchedExisting && ignored.length > 0) {
      return {
        error: null,
        notice: `เบอร์นี้เป็นสมาชิกอยู่แล้ว จึงเข้าสู่ระบบบัญชีเดิม — ${ignored.join("และ")}ที่กรอกใหม่ไม่ถูกบันทึกทับ หากต้องการแก้ไขกรุณาแจ้งร้าน`,
      };
    }
    return { error: null, notice: null };
  } catch (e) {
    logPublicMemberActionError("verifyMemberOtp", e);
    return { error: "ยืนยัน OTP ไม่สำเร็จ กรุณาลองใหม่หรือแจ้งร้านค้า" };
  }
}

/**
 * ออกจากระบบสมาชิก (audit ข้อ 14) — ลบ session ที่ต้นทางไม่ใช่แค่ลืม cookie
 * ไม่ต้องมีสิทธิ์อะไร ใครถือ session อยู่ก็ออกจากระบบตัวเองได้
 */
export async function signOutMemberAction(formData: FormData): Promise<MemberActionResult> {
  const storeSlug = String(formData.get("storeSlug") ?? "").trim();
  if (!storeSlug) return { error: "ออกจากระบบไม่สำเร็จ" };
  try {
    await signOutMemberSession(storeSlug);
    revalidatePath(`/member/${storeSlug}`);
    return { error: null };
  } catch (e) {
    logActionError({ source: "member.portal", action: "signOutMemberAction", error: e });
    return { error: "ออกจากระบบไม่สำเร็จ" };
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
    if (portalData.passesOnly) return { error: "ร้านปิดระบบแลกของรางวัลแล้ว" };

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

/**
 * ลูกค้ากดรับแต้มจาก QR ท้ายใบเสร็จ
 * ต้องล็อกอินสมาชิกก่อน (RPC ตรวจซ้ำอีกชั้นว่าลูกค้าอยู่ร้านนี้จริง)
 */
export async function claimReceiptPointsAction(formData: FormData): Promise<{
  error: string | null;
  claimed: { points: number; balance: number; orderNumber: string } | null;
}> {
  try {
    const storeSlug = text(formData, "storeSlug");
    const portalCode = text(formData, "portalCode");
    const claimCode = text(formData, "claimCode").trim().toUpperCase();
    if (!/^[0-9A-F]{8}$/.test(claimCode)) return { error: "รหัสรับแต้มไม่ถูกต้อง", claimed: null };

    const portalData = await getCustomerPortalData(storeSlug, portalCode);
    if (!portalData.portalValid || !portalData.store) {
      return { error: publicMemberError(portalData.error, "ต้องเปิดจาก QR ของร้าน"), claimed: null };
    }
    if (!portalData.customer) return { error: "กรุณาเข้าสู่ระบบก่อนรับแต้ม", claimed: null };
    if (portalData.passesOnly) return { error: "ร้านปิดระบบสะสมแต้มแล้ว", claimed: null };

    const result = await claimLoyaltyPointsWithCode({
      storeId: portalData.store.id,
      code: claimCode,
      customerId: portalData.customer.id,
    });
    if (result.error) {
      return { error: publicMemberError(result.error.userMessage, "รับแต้มไม่สำเร็จ"), claimed: null };
    }
    if (!result.data) return { error: "รับแต้มไม่สำเร็จ", claimed: null };
    if (result.data.status !== "claimed") return { error: result.data.message, claimed: null };

    revalidateMemberPortal(storeSlug);
    return {
      error: null,
      claimed: {
        points: result.data.points,
        balance: result.data.balance,
        orderNumber: result.data.orderNumber,
      },
    };
  } catch (e) {
    logPublicMemberActionError("claimReceiptPoints", e);
    return { error: "รับแต้มไม่สำเร็จ กรุณาลองใหม่หรือแจ้งร้านค้า", claimed: null };
  }
}

/**
 * ลูกค้าขอรหัสใช้สิทธิ์ 6 หลัก (อายุ 5 นาที ใช้ได้ครั้งเดียว) เพื่อให้แคชเชียร์สแกน/พิมพ์ที่ POS
 * ต้องล็อกอินสมาชิกก่อน และสาขาต้องเปิดสวิตช์ + เป็น Enterprise
 */
export async function issueMemberRedeemCodeAction(formData: FormData): Promise<{
  error: string | null;
  code?: string;
  expiresAt?: string;
}> {
  try {
    const storeSlug = text(formData, "storeSlug");
    const portalCode = text(formData, "portalCode");
    const portalData = await getCustomerPortalData(storeSlug, portalCode);
    if (!portalData.portalValid || !portalData.store) {
      return { error: publicMemberError(portalData.error, "ต้องเปิดจาก QR ของร้าน") };
    }
    if (!portalData.customer) return { error: "กรุณาเข้าสู่ระบบก่อนขอรหัสใช้สิทธิ์" };
    if (!portalData.memberCodeEnabled) return { error: "สาขานี้ยังไม่เปิดใช้รหัสสมาชิก" };

    const result = await issueMemberRedeemCode({
      organizationId: portalData.store.organizationId,
      storeId: portalData.store.id,
      customerId: portalData.customer.id,
    });
    if (result.error || !result.data) {
      void logSystemEvent({
        level: result.status === "rate_limited" ? "warn" : "error",
        source: "member.code",
        action: "issueMemberRedeemCodeAction",
        message: `ออกรหัสสมาชิกไม่สำเร็จ: ${result.status ?? "rpc_error"}`,
        organizationId: portalData.store.organizationId,
        storeId: portalData.store.id,
        context: { status: result.status ?? null, customerId: portalData.customer.id },
      });
      return { error: result.error ?? "ขอรหัสไม่สำเร็จ กรุณาลองใหม่" };
    }

    void logSystemEvent({
      level: "info",
      source: "member.code",
      action: "issueMemberRedeemCodeAction",
      message: "ออกรหัสสมาชิก 5 นาที",
      organizationId: portalData.store.organizationId,
      storeId: portalData.store.id,
      context: { customerId: portalData.customer.id, expiresAt: result.data.expiresAt },
    });
    return { error: null, code: result.data.code, expiresAt: result.data.expiresAt };
  } catch (e) {
    logPublicMemberActionError("issueMemberRedeemCode", e);
    return { error: "ขอรหัสไม่สำเร็จ กรุณาลองใหม่" };
  }
}

const PASS_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** ลูกค้าซื้อแพ็กเองผ่าน Beam — ต้องล็อกอินและติ๊กยอมรับเงื่อนไข (ไม่คืนเงิน) */
export async function startPassPurchaseAction(formData: FormData): Promise<{
  error: string | null;
  purchaseId?: string;
  planName?: string;
  qr?: { qrPayload: string | null; qrImageBase64: string | null; amount: number; expiresAt: string | null };
}> {
  try {
    const storeSlug = text(formData, "storeSlug");
    const portalCode = text(formData, "portalCode");
    const planId = text(formData, "planId");
    if (!PASS_ID_RE.test(planId)) return { error: "ข้อมูลแพ็กไม่ถูกต้อง" };
    const portalData = await getCustomerPortalData(storeSlug, portalCode);
    if (!portalData.portalValid || !portalData.store) {
      return { error: publicMemberError(portalData.error, "ต้องเปิดจาก QR ของร้าน") };
    }
    if (!portalData.customer) return { error: "กรุณาเข้าสู่ระบบก่อนซื้อแพ็ก" };
    if (!portalData.memberPrivileges) return { error: "ร้านนี้ยังไม่เปิดขายแพ็กออนไลน์" };

    const result = await startPassPurchase({
      organizationId: portalData.store.organizationId,
      storeId: portalData.store.id,
      customerId: portalData.customer.id,
      planId,
      termsAccepted: text(formData, "termsAccepted") === "yes",
    });
    void logSystemEvent({
      level: result.error ? "warn" : "info",
      source: "prepaid-pass.online",
      action: "startPassPurchase",
      message: result.error ? `เริ่มซื้อแพ็กออนไลน์ไม่สำเร็จ: ${result.error}` : "ลูกค้าเริ่มซื้อแพ็กออนไลน์ (ยอมรับเงื่อนไขแล้ว)",
      organizationId: portalData.store.organizationId,
      storeId: portalData.store.id,
      context: { planId, customerId: portalData.customer.id, purchaseId: result.data?.purchaseId ?? null },
    });
    if (result.error !== null) return { error: result.error };
    return {
      error: null,
      purchaseId: result.data.purchaseId,
      planName: result.data.planName,
      qr: {
        qrPayload: result.data.qr.qrPayload,
        qrImageBase64: result.data.qr.qrImageBase64,
        amount: result.data.qr.amount,
        expiresAt: result.data.qr.expiresAt,
      },
    };
  } catch (e) {
    logPublicMemberActionError("startPassPurchase", e);
    return { error: "เริ่มซื้อแพ็กไม่สำเร็จ กรุณาลองใหม่" };
  }
}

export async function checkPassPurchaseAction(formData: FormData): Promise<{
  status: "pending" | "paid" | "failed" | "review";
  error: string | null;
}> {
  try {
    const storeSlug = text(formData, "storeSlug");
    const portalCode = text(formData, "portalCode");
    const purchaseId = text(formData, "purchaseId");
    if (!PASS_ID_RE.test(purchaseId)) return { status: "failed", error: "ข้อมูลไม่ถูกต้อง" };
    const portalData = await getCustomerPortalData(storeSlug, portalCode);
    if (!portalData.store || !portalData.customer) return { status: "failed", error: "กรุณาเข้าสู่ระบบอีกครั้ง" };
    const result = await checkPassPurchase({ storeId: portalData.store.id, customerId: portalData.customer.id, purchaseId });
    if (result.status === "paid") {
      void logSystemEvent({
        level: "info",
        source: "prepaid-pass.online",
        action: "checkPassPurchase",
        message: "ลูกค้าเห็นแพ็กเข้าบัญชีแล้ว (จ่าย Beam สำเร็จ)",
        organizationId: portalData.store.organizationId,
        storeId: portalData.store.id,
        context: { purchaseId },
      });
      revalidateMemberPortal(storeSlug);
    }
    return result;
  } catch (e) {
    logPublicMemberActionError("checkPassPurchase", e);
    return { status: "pending", error: null };
  }
}

export async function cancelPassPurchaseAction(formData: FormData): Promise<{ error: string | null }> {
  try {
    const storeSlug = text(formData, "storeSlug");
    const portalCode = text(formData, "portalCode");
    const purchaseId = text(formData, "purchaseId");
    if (!PASS_ID_RE.test(purchaseId)) return { error: "ข้อมูลไม่ถูกต้อง" };
    const portalData = await getCustomerPortalData(storeSlug, portalCode);
    if (!portalData.store || !portalData.customer) return { error: "กรุณาเข้าสู่ระบบอีกครั้ง" };
    const result = await cancelPassPurchase({ storeId: portalData.store.id, customerId: portalData.customer.id, purchaseId });
    void logSystemEvent({
      level: result.error ? "warn" : "info",
      source: "prepaid-pass.online",
      action: "cancelPassPurchase",
      message: result.error ? `ยกเลิกซื้อแพ็กออนไลน์ไม่สำเร็จ: ${result.error}` : "ลูกค้ายกเลิกซื้อแพ็กออนไลน์",
      organizationId: portalData.store.organizationId,
      storeId: portalData.store.id,
      context: { purchaseId, customerId: portalData.customer.id },
    });
    return result;
  } catch (e) {
    logPublicMemberActionError("cancelPassPurchase", e);
    return { error: "ยกเลิกไม่สำเร็จ" };
  }
}
