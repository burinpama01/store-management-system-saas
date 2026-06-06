"use server";

import { revalidatePath } from "next/cache";
import { AuthorizationError, getResolvedCurrentPermissions } from "@/modules/auth/guards";
import { getPlatformSettings } from "@/modules/billing/platform-settings";
import { resolveSubscriptionQr, type SubscriptionQr } from "@/modules/billing/promptpay-provider";
import { getSubscriptionPrice, isPaidTier, type BillingDuration, type PaidTier } from "@/modules/billing/pricing";
import { submitPromptPayPayment, type SubmitPaymentResult } from "@/modules/billing/subscription-service";

function parsePlan(value: unknown): PaidTier | null {
  return typeof value === "string" && isPaidTier(value as never) ? (value as PaidTier) : null;
}
function parseDuration(value: unknown): BillingDuration | null {
  return value === "30d" || value === "1y" ? value : null;
}

export interface PaymentQrResult {
  ok: boolean;
  amount: number | null;
  qr: SubscriptionQr | null;
  error: string | null;
}

export async function getPaymentQrAction(
  plan: string,
  duration: string,
): Promise<PaymentQrResult> {
  try {
    const { resolved } = await getResolvedCurrentPermissions();
    if (!resolved.can("billing.manage")) {
      return { ok: false, amount: null, qr: null, error: "ไม่มีสิทธิ์จัดการการชำระเงิน" };
    }
    const p = parsePlan(plan);
    const d = parseDuration(duration);
    if (!p || !d) return { ok: false, amount: null, qr: null, error: "แพ็กเกจหรือระยะเวลาไม่ถูกต้อง" };

    const amount = getSubscriptionPrice(p, d);
    if (amount == null) return { ok: false, amount: null, qr: null, error: "ไม่พบราคาแพ็กเกจ" };

    const settings = await getPlatformSettings();
    return { ok: true, amount, qr: resolveSubscriptionQr(settings, amount), error: null };
  } catch (e) {
    if (e instanceof AuthorizationError) {
      return { ok: false, amount: null, qr: null, error: "ไม่มีสิทธิ์" };
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

    const result = await submitPromptPayPayment({
      organizationId: ctx.organizationId,
      plan: p,
      duration: d,
      submittedByUserId: user.id,
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
