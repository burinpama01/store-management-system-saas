import { createSupabaseServiceClient } from "@/server/integrations/supabase/server";
import { getSubscriptionPrice, computeNewExpiry, type BillingDuration } from "./pricing";
import { getPlatformSettings } from "./platform-settings";
import { receiverMatches } from "./promptpay-provider";
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
  plan: PaidTier;
  duration: BillingDuration;
  submittedByUserId: string;
  slipPayload?: string;
  slipImageBase64?: string;
  slipImageContentType?: string;
}

export interface SubmitPaymentResult {
  status: "verified" | "rejected" | "duplicate";
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
  const expected = getSubscriptionPrice(input.plan, input.duration);
  if (expected == null) {
    return { status: "rejected", reason: "แพ็กเกจนี้ชำระผ่าน PromptPay ไม่ได้", newExpiry: null };
  }

  const settings = await getPlatformSettings();

  const verification = input.slipImageBase64
    ? await verifySlipByImageBase64(input.slipImageBase64, input.slipImageContentType)
    : input.slipPayload
      ? await verifySlipByPayload(input.slipPayload)
      : ({ ok: false, amount: null, receiverName: null, receiverAccount: null, transRef: null, raw: null, error: "ไม่พบข้อมูลสลิป" } as Slip2goVerification);

  const evaluation = evaluatePaymentVerification(verification, expected, settings.promptpayId);

  if (!evaluation.ok) {
    await recordSubmission(supabase, input, expected, verification, "rejected", evaluation.reason);
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

  return { status: "verified", reason: null, newExpiry };
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
    verified_at: null,
  });
}
