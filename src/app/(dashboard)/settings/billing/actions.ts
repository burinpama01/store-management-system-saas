"use server";

import { revalidatePath } from "next/cache";
import { AuthorizationError, getResolvedCurrentPermissions } from "@/modules/auth/guards";
import { getPlatformSettings } from "@/modules/billing/platform-settings";
import { resolveSubscriptionQr, type SubscriptionQr } from "@/modules/billing/promptpay-provider";
import { isPaidTier, type BillingDuration, type PaidTier } from "@/modules/billing/pricing";
import {
  getBusinessUpgradeQuote,
  getUpgradeQuote,
} from "@/modules/billing/pricing-repository";
import { describeDiscountRejection } from "@/modules/billing/discount-code";
import { parseBusinessConfigJson } from "@/modules/billing/business-plan";
import {
  claimFreeTrial,
  submitPromptPayPayment,
  type ClaimFreeTrialResult,
  type SubmitPaymentResult,
} from "@/modules/billing/subscription-service";

function parsePlan(value: unknown): PaidTier | "business" | null {
  if (value === "business") return "business";
  return typeof value === "string" && isPaidTier(value as never) ? (value as PaidTier) : null;
}
function parseDuration(value: unknown): BillingDuration | null {
  return value === "30d" || value === "1y" ? value : null;
}

export interface PaymentQrResult {
  ok: boolean;
  amount: number | null;
  basePrice: number | null;
  credit: number;
  promotionLabel: string | null;
  discount: number;
  discountLabel: string | null;
  qr: SubscriptionQr | null;
  error: string | null;
}

export async function getPaymentQrAction(
  plan: string,
  duration: string,
  discountCode?: string,
  businessConfigJson?: string,
): Promise<PaymentQrResult> {
  try {
    const { ctx, resolved } = await getResolvedCurrentPermissions();
    const base = {
      ok: false as const,
      amount: null,
      basePrice: null,
      credit: 0,
      promotionLabel: null,
      discount: 0,
      discountLabel: null,
      qr: null,
    };
    if (!resolved.can("billing.manage")) {
      return { ...base, error: "ไม่มีสิทธิ์จัดการการชำระเงิน" };
    }
    const p = parsePlan(plan);
    const d = parseDuration(duration);
    if (!p || !d) return { ...base, error: "แพ็กเกจหรือระยะเวลาไม่ถูกต้อง" };

    const businessConfig = p === "business" ? parseBusinessConfigJson(businessConfigJson) : null;
    if (p === "business" && !businessConfig) {
      return { ...base, error: "กรุณาเลือกที่นั่ง/สาขา/ฟีเจอร์ของแพ็กเกจ Business" };
    }

    const quote =
      p === "business"
        ? await getBusinessUpgradeQuote(ctx.organizationId, businessConfig!, d, discountCode)
        : await getUpgradeQuote(ctx.organizationId, p, d, discountCode);
    if (!quote) return { ...base, error: "ไม่พบราคาแพ็กเกจ" };
    // A supplied code that does not apply blocks QR creation so the tenant can fix it.
    if (quote.discountRejection) {
      return { ...base, error: describeDiscountRejection(quote.discountRejection) };
    }
    const settings = await getPlatformSettings();
    return {
      ok: true,
      amount: quote.finalAmount,
      basePrice: quote.price,
      credit: quote.credit,
      promotionLabel: quote.promotion ? `${quote.promotion.description} (-${quote.promotion.percentOff}%)` : null,
      discount: quote.discount,
      discountLabel: quote.discountCode
        ? `${quote.discountCode.description} (${quote.discountCode.normalizedCode})`
        : null,
      qr: resolveSubscriptionQr(settings, quote.finalAmount),
      error: null,
    };
  } catch (e) {
    if (e instanceof AuthorizationError) {
      return { ok: false, amount: null, basePrice: null, credit: 0, promotionLabel: null, discount: 0, discountLabel: null, qr: null, error: "ไม่มีสิทธิ์" };
    }
    throw e;
  }
}

export interface SubmitPaymentActionResult extends SubmitPaymentResult {
  ok: boolean;
  error: string | null;
}

export async function submitPaymentAction(input: {
  plan: string;
  duration: string;
  discountCode?: string;
  businessConfigJson?: string;
  slipImageBase64?: string;
  slipPayload?: string;
}): Promise<SubmitPaymentActionResult> {
  try {
    const { ctx, user, resolved } = await getResolvedCurrentPermissions();
    if (!resolved.can("billing.manage")) {
      return { ok: false, status: "rejected", reason: null, newExpiry: null, error: "ไม่มีสิทธิ์จัดการการชำระเงิน" };
    }
    const p = parsePlan(input.plan);
    const d = parseDuration(input.duration);
    if (!p || !d) {
      return { ok: false, status: "rejected", reason: null, newExpiry: null, error: "แพ็กเกจหรือระยะเวลาไม่ถูกต้อง" };
    }
    if (!input.slipImageBase64 && !input.slipPayload) {
      return { ok: false, status: "rejected", reason: null, newExpiry: null, error: "กรุณาแนบสลิป" };
    }
    const businessConfig = p === "business" ? parseBusinessConfigJson(input.businessConfigJson) : null;
    if (p === "business" && !businessConfig) {
      return { ok: false, status: "rejected", reason: null, newExpiry: null, error: "กรุณาเลือกที่นั่ง/สาขา/ฟีเจอร์ของแพ็กเกจ Business" };
    }

    const result = await submitPromptPayPayment({
      organizationId: ctx.organizationId,
      plan: p,
      duration: d,
      submittedByUserId: user.id,
      businessConfig,
      discountCode: input.discountCode,
      slipImageBase64: input.slipImageBase64,
      slipPayload: input.slipPayload,
    });

    revalidatePath("/settings/billing");
    return { ...result, ok: result.status === "verified", error: null };
  } catch (e) {
    if (e instanceof AuthorizationError) {
      return { ok: false, status: "rejected", reason: null, newExpiry: null, error: "ไม่มีสิทธิ์" };
    }
    throw e;
  }
}

export interface ClaimFreeTrialActionResult extends ClaimFreeTrialResult {
  ok: boolean;
  error: string | null;
}

/** กดรับสิทธิ์ทดลอง Enterprise ฟรี 30 วัน (0 บาท ไม่ต้องแนบสลิป). */
export async function claimFreeTrialAction(): Promise<ClaimFreeTrialActionResult> {
  try {
    const { ctx, user, resolved } = await getResolvedCurrentPermissions();
    if (!resolved.can("billing.manage")) {
      return { ok: false, status: "unavailable", reason: null, newExpiry: null, error: "ไม่มีสิทธิ์จัดการการชำระเงิน" };
    }

    const result = await claimFreeTrial({
      organizationId: ctx.organizationId,
      submittedByUserId: user.id,
    });

    revalidatePath("/settings/billing");
    return { ...result, ok: result.status === "claimed", error: null };
  } catch (e) {
    if (e instanceof AuthorizationError) {
      return { ok: false, status: "unavailable", reason: null, newExpiry: null, error: "ไม่มีสิทธิ์" };
    }
    throw e;
  }
}
