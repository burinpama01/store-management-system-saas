import { createSupabaseServiceClient } from "@/server/integrations/supabase/server";
import { mapError } from "@/shared/utils/error";
import type { BillingState, BillingPlan, BillingStatus } from "./types";
import { normalizeBusinessConfig } from "./business-plan";
import { randomUUID } from "node:crypto";

export async function getOrganizationBillingState(
  organizationId: string,
): Promise<BillingState | null> {
  const supabase = await createSupabaseServiceClient();
  const { data } = await supabase
    .from("subscriptions")
    .select(
      "plan, status, current_period_end, cancel_at_period_end, trial_end, business_seats, business_stores, business_features",
    )
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (!data) return null;
  const business =
    data.plan === "business"
      ? normalizeBusinessConfig({
          seats: data.business_seats,
          stores: data.business_stores,
          features: data.business_features,
        })
      : null;
  return {
    plan: data.plan as BillingPlan,
    status: data.status as BillingStatus,
    currentPeriodEnd: data.current_period_end,
    cancelAtPeriodEnd: data.cancel_at_period_end,
    trialEnd: (data as Record<string, unknown>).trial_end as string | null,
    business,
  };
}

export async function getStripeCustomerId(
  organizationId: string,
): Promise<string | null> {
  const supabase = await createSupabaseServiceClient();
  const { data } = await supabase
    .from("billing_customers")
    .select("stripe_customer_id")
    .eq("organization_id", organizationId)
    .maybeSingle();
  return data?.stripe_customer_id ?? null;
}

export async function upsertStripeCustomer(
  organizationId: string,
  stripeCustomerId: string,
) {
  const supabase = await createSupabaseServiceClient();
  const { error } = await supabase.from("billing_customers").upsert(
    {
      organization_id: organizationId,
      stripe_customer_id: stripeCustomerId,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "organization_id" },
  );
  if (error) return { ok: false, error: mapError(error) };
  return { ok: true, error: null };
}

export type WebhookEventProcessingDecision = "process" | "skip" | "retry_later";
export type WebhookEventProcessingClaim = {
  decision: WebhookEventProcessingDecision;
  processingAttemptId: string | null;
};

const STALE_WEBHOOK_PROCESSING_MINUTES = 15;

/**
 * Claims a webhook event for processing without marking it processed.
 * Failed events can be claimed again on Stripe retry; processed events are skipped.
 */
export async function beginWebhookEventProcessing(
  stripeEventId: string,
  eventType: string,
): Promise<WebhookEventProcessingClaim> {
  const supabase = await createSupabaseServiceClient();
  const processingAttemptId = randomUUID();
  const { data, error } = await supabase.rpc("begin_billing_event_processing", {
    p_stripe_event_id: stripeEventId,
    p_event_type: eventType,
    p_processing_attempt_id: processingAttemptId,
    p_stale_after: `${STALE_WEBHOOK_PROCESSING_MINUTES} minutes`,
  });
  if (error) throw new Error(`billing_events processing claim failed: ${error.message}`);
  if (data === "process" || data === "skip" || data === "retry_later") {
    return {
      decision: data,
      processingAttemptId: data === "process" ? processingAttemptId : null,
    };
  }
  throw new Error(`billing_events processing claim returned invalid decision: ${String(data)}`);
}

export async function markWebhookEventProcessed(
  stripeEventId: string,
  processingAttemptId: string,
): Promise<void> {
  const supabase = await createSupabaseServiceClient();
  const { data, error } = await supabase
    .from("billing_events")
    .update({
      status: "processed",
      processed_at: new Date().toISOString(),
      failed_at: null,
      last_error: null,
    })
    .eq("stripe_event_id", stripeEventId)
    .eq("processing_attempt_id", processingAttemptId)
    .eq("status", "processing")
    .select("id")
    .maybeSingle();
  if (error) throw new Error(`billing_events mark processed failed: ${error.message}`);
  if (!data) throw new Error("billing_events mark processed failed: stale processing attempt");
}

export async function markWebhookEventFailed(
  stripeEventId: string,
  processingAttemptId: string,
  errorMessage: string,
): Promise<void> {
  const supabase = await createSupabaseServiceClient();
  const { data, error } = await supabase
    .from("billing_events")
    .update({
      status: "failed",
      failed_at: new Date().toISOString(),
      last_error: errorMessage.slice(0, 2000),
    })
    .eq("stripe_event_id", stripeEventId)
    .eq("processing_attempt_id", processingAttemptId)
    .eq("status", "processing")
    .select("id")
    .maybeSingle();
  if (error) throw new Error(`billing_events mark failed failed: ${error.message}`);
  if (!data) throw new Error("billing_events mark failed failed: stale processing attempt");
}

export async function upsertSubscription(
  organizationId: string,
  update: {
    plan: BillingPlan;
    status: BillingStatus;
    stripeSubscriptionId: string;
    stripePriceId: string | null;
    currentPeriodStart: string;
    currentPeriodEnd: string;
    cancelAtPeriodEnd: boolean;
    trialEnd: string | null;
  },
) {
  const supabase = await createSupabaseServiceClient();
  const { error } = await supabase.from("subscriptions").upsert(
    {
      organization_id: organizationId,
      plan: update.plan,
      status: update.status,
      stripe_subscription_id: update.stripeSubscriptionId,
      stripe_price_id: update.stripePriceId,
      current_period_start: update.currentPeriodStart,
      current_period_end: update.currentPeriodEnd,
      cancel_at_period_end: update.cancelAtPeriodEnd,
      trial_end: update.trialEnd,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "organization_id" },
  );
  if (error) return { ok: false, error: mapError(error) };
  return { ok: true, error: null };
}

export async function setSubscriptionStatus(
  organizationId: string,
  status: BillingStatus,
) {
  const supabase = await createSupabaseServiceClient();
  const { error } = await supabase
    .from("subscriptions")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("organization_id", organizationId);
  if (error) return { ok: false, error: mapError(error) };
  return { ok: true, error: null };
}
