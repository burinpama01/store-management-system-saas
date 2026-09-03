import { createSupabaseServiceClient } from "@/server/integrations/supabase/server";
import { logActionError, logSystemEvent } from "@/modules/system/event-log";
import { notifyOwnerNow } from "@/modules/notifications/dispatcher";
import { computeNewExpiry, type BillingDuration } from "./pricing";
import { getBusinessUpgradeQuote, getFreeTrialEligibility, getUpgradeQuote } from "./pricing-repository";
import { describeFreeTrialRejection } from "./free-trial";
import type { BusinessPlanConfig } from "./types";
import { getPlatformSettings } from "./platform-settings";
import { receiverMatches } from "./promptpay-provider";
import { describeDiscountRejection } from "./discount-code";
import {
  verifySlipByPayload,
  verifySlipByImageBase64,
  type Slip2goVerification,
} from "./slip2go";
import type { PaidTier } from "./pricing";

export interface PaymentEvaluation {
  ok: boolean;
  reason: string | null;
}

/**
 * Pure decision: should a slip verification credit the subscription?
 * Hard guards: verified by slip2go, amount ≥ expected, has a transaction ref.
 * Soft guard: receiver last-4 must match configured PromptPay id when both known.
 */
export function evaluatePaymentVerification(
  v: Slip2goVerification,
  expectedAmount: number,
  promptpayId: string | null,
): PaymentEvaluation {
  if (!v.ok) return { ok: false, reason: v.error ?? "ตรวจสลิปไม่สำเร็จ" };
  if (v.amount == null || v.amount < expectedAmount) {
    return { ok: false, reason: `ยอดโอนไม่ถูกต้อง (ต้องการ ${expectedAmount} บาท)` };
  }
  if (!v.transRef) return { ok: false, reason: "ไม่พบเลขอ้างอิงรายการในสลิป" };
  if (!receiverMatches(promptpayId, v.receiverAccount)) {
    return { ok: false, reason: "บัญชีผู้รับในสลิปไม่ตรงกับบัญชีรับเงิน" };
  }
  return { ok: true, reason: null };
}

export interface SubmitPaymentInput {
  organizationId: string;
  plan: PaidTier | "business";
  duration: BillingDuration;
  submittedByUserId: string;
  /** Required when plan = "business" (already normalized by the caller). */
  businessConfig?: BusinessPlanConfig | null;
  discountCode?: string;
  slipPayload?: string;
  slipImageBase64?: string;
  slipImageContentType?: string;
}

export interface SubmitPaymentResult {
  status: "verified" | "rejected" | "duplicate";
  reason: string | null;
  newExpiry: string | null;
}

export interface ClaimFreeTrialInput {
  organizationId: string;
  submittedByUserId: string;
}

export interface ClaimFreeTrialResult {
  status: "claimed" | "unavailable";
  reason: string | null;
  newExpiry: string | null;
}

/**
 * Verifies a PromptPay slip via slip2go and, on success, extends the org's
 * subscription. Records every attempt in payment_submissions and writes an
 * audit log on success. Service-client only; the caller MUST have re-checked
 * billing.manage before calling.
 */
export async function submitPromptPayPayment(
  input: SubmitPaymentInput,
): Promise<SubmitPaymentResult> {
  const supabase = await createSupabaseServiceClient();
  const isBusiness = input.plan === "business";
  if (isBusiness && !input.businessConfig) {
    return { status: "rejected", reason: "กรุณาเลือกที่นั่ง/สาขา/ฟีเจอร์ของแพ็กเกจ Business", newExpiry: null };
  }
  const quote = isBusiness
    ? await getBusinessUpgradeQuote(input.organizationId, input.businessConfig!, input.duration, input.discountCode)
    : await getUpgradeQuote(input.organizationId, input.plan, input.duration, input.discountCode);
  if (!quote) {
    return { status: "rejected", reason: "แพ็กเกจนี้ชำระผ่าน PromptPay ไม่ได้", newExpiry: null };
  }
  // A supplied code that no longer applies (expired, limit reached, etc.) is
  // rejected before charging so the tenant is not quietly billed the full price.
  if (quote.discountRejection) {
    return { status: "rejected", reason: describeDiscountRejection(quote.discountRejection), newExpiry: null };
  }
  const expected = quote.finalAmount;

  const settings = await getPlatformSettings();

  const verification = input.slipImageBase64
    ? await verifySlipByImageBase64(input.slipImageBase64, input.slipImageContentType)
    : input.slipPayload
      ? await verifySlipByPayload(input.slipPayload)
      : ({ ok: false, amount: null, receiverName: null, receiverAccount: null, transRef: null, raw: null, error: "ไม่พบข้อมูลสลิป" } as Slip2goVerification);

  const evaluation = evaluatePaymentVerification(verification, expected, settings.promptpayId);

  if (!evaluation.ok) {
    await recordSubmission(supabase, input, expected, verification, "rejected", evaluation.reason);
    void logSystemEvent({
      level: "warn",
      source: "billing.promptpay",
      action: "slipRejected",
      message: `สลิปไม่ผ่าน: ${evaluation.reason}`,
      organizationId: input.organizationId,
      actorUserId: input.submittedByUserId,
      context: { plan: input.plan, duration: input.duration, expected, verifiedAmount: verification.amount },
    });
    return { status: "rejected", reason: evaluation.reason, newExpiry: null };
  }

  // Claim the slip ref by inserting the verified row first. The partial unique
  // index (verified rows only) atomically rejects a slip that was already credited.
  const now = new Date();
  const { error: claimErr } = await supabase.from("payment_submissions").insert({
    organization_id: input.organizationId,
    plan: input.plan,
    duration: input.duration,
    amount_expected: expected,
    verified_amount: verification.amount,
    slip_ref: verification.transRef,
    slip2go_raw: (verification.raw ?? null) as never,
    status: "verified",
    reason: null,
    submitted_by: input.submittedByUserId,
    discount_code_id: quote.discountCode?.id ?? null,
    discount_amount: quote.discount,
    business_seats: input.businessConfig?.seats ?? null,
    business_stores: input.businessConfig?.stores ?? null,
    business_features: (input.businessConfig?.features ?? []) as never,
    verified_at: now.toISOString(),
  });
  if (claimErr) {
    await recordSubmission(supabase, input, expected, verification, "duplicate", "สลิปนี้ถูกใช้ไปแล้ว");
    return { status: "duplicate", reason: "สลิปนี้ถูกใช้ไปแล้ว", newExpiry: null };
  }

  // Extend subscription from the later of now / current expiry.
  const { data: current } = await supabase
    .from("subscriptions")
    .select("current_period_end")
    .eq("organization_id", input.organizationId)
    .maybeSingle();
  const newExpiry = computeNewExpiry(current?.current_period_end ?? null, input.duration, now);

  const { error: subErr } = await supabase.from("subscriptions").upsert(
    {
      organization_id: input.organizationId,
      plan: input.plan,
      status: "active",
      current_period_start: now.toISOString(),
      current_period_end: newExpiry,
      cancel_at_period_end: false,
      trial_end: null,
      // ซื้อจริงแล้วไม่ใช่สิทธิ์โปรทดลองอีกต่อไป
      promo_trial_code: null,
      // Business config follows the purchased plan; cleared when moving to a fixed tier.
      business_seats: input.businessConfig?.seats ?? null,
      business_stores: input.businessConfig?.stores ?? null,
      business_features: (input.businessConfig?.features ?? []) as never,
      updated_at: now.toISOString(),
    },
    { onConflict: "organization_id" },
  );
  if (subErr) {
    return { status: "rejected", reason: "บันทึก subscription ไม่สำเร็จ", newExpiry: null };
  }

  await supabase.from("audit_logs").insert({
    organization_id: input.organizationId,
    store_id: null,
    actor_user_id: input.submittedByUserId,
    target_user_id: null,
    action: "subscription.payment_verified",
    reason: `${input.plan}/${input.duration} ถึง ${newExpiry}`,
  });

  // ยืนยันกลับให้ร้านเห็นในศูนย์แจ้งเตือน — เดิมจ่ายเงินแล้วเงียบสนิท
  // ไม่ await เพราะการแจ้งเตือนต้องไม่ทำให้การชำระเงินที่สำเร็จแล้วช้าหรือพัง
  void notifyOwnerNow({
    type: "subscription_expiring",
    destination: "owner",
    title: "ต่ออายุแพ็กเกจสำเร็จ",
    message: `ชำระเงินสำเร็จ · แพ็กเกจ ${input.plan} (${input.duration}) ใช้งานได้ถึง ${formatThaiDay(newExpiry)}`,
    organizationId: input.organizationId,
    metadata: { plan: input.plan, duration: input.duration, newExpiry },
  });

  void logSystemEvent({
    level: "info",
    source: "billing.promptpay",
    action: "submitPromptPayPayment",
    message: `ต่ออายุสำเร็จ ${input.plan}/${input.duration} ถึง ${newExpiry}`,
    organizationId: input.organizationId,
    actorUserId: input.submittedByUserId,
    context: { amount: expected, discount: quote.discount, slipRef: verification.transRef },
  });

  return { status: "verified", reason: null, newExpiry };
}

/**
 * เปิดใช้งานสิทธิ์ทดลอง Enterprise ฟรี 30 วัน (0 บาท ไม่ต้องแนบสลิป).
 * ตรวจสิทธิ์ซ้ำอีกชั้นใน RPC แบบ atomic กันกดพร้อมกันหลายแท็บ.
 */
export async function claimFreeTrial(
  input: ClaimFreeTrialInput,
): Promise<ClaimFreeTrialResult> {
  const supabase = await createSupabaseServiceClient();
  const offer = await getFreeTrialEligibility(input.organizationId, input.submittedByUserId);
  if (!offer.available) {
    return {
      status: "unavailable",
      reason: describeFreeTrialRejection(offer.unavailableReason),
      newExpiry: null,
    };
  }

  const { data, error } = await supabase.rpc("claim_free_trial", {
    p_organization_id: input.organizationId,
    p_user_id: input.submittedByUserId,
  });
  if (error) {
    logActionError({
      source: "billing.free-trial",
      action: "claimFreeTrial",
      error,
      organizationId: input.organizationId,
      actorUserId: input.submittedByUserId,
    });
    return { status: "unavailable", reason: describeFreeTrialRejection(null), newExpiry: null };
  }

  const row = data?.[0] ?? null;
  if (!row?.ok) {
    return { status: "unavailable", reason: describeFreeTrialRejection(row?.code ?? null), newExpiry: null };
  }

  void logSystemEvent({
    level: "info",
    source: "billing.free-trial",
    action: "claimFreeTrial",
    message: `เปิดสิทธิ์ทดลอง Enterprise ฟรี ถึง ${row.new_expiry}`,
    organizationId: input.organizationId,
    actorUserId: input.submittedByUserId,
  });

  return { status: "claimed", reason: null, newExpiry: row.new_expiry };
}

async function recordSubmission(
  supabase: Awaited<ReturnType<typeof createSupabaseServiceClient>>,
  input: SubmitPaymentInput,
  expected: number,
  verification: Slip2goVerification,
  status: "rejected" | "duplicate",
  reason: string | null,
) {
  await supabase.from("payment_submissions").insert({
    organization_id: input.organizationId,
    plan: input.plan,
    duration: input.duration,
    amount_expected: expected,
    verified_amount: verification.amount,
    slip_ref: verification.transRef ?? null,
    slip2go_raw: (verification.raw ?? null) as never,
    status,
    reason,
    submitted_by: input.submittedByUserId,
    business_seats: input.businessConfig?.seats ?? null,
    business_stores: input.businessConfig?.stores ?? null,
    business_features: (input.businessConfig?.features ?? []) as never,
    verified_at: null,
  });
}

/** วันที่แบบไทยสำหรับข้อความแจ้งเตือน (คนอ่าน ไม่ใช่เครื่องอ่าน) */
function formatThaiDay(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("th-TH", {
    timeZone: "Asia/Bangkok",
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(d);
}
