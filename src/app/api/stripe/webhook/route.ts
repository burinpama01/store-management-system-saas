import { NextResponse } from "next/server";
import {
  constructWebhookEvent,
  mapStripePlan,
  mapStripeStatus,
  toTimestamp,
} from "@/modules/billing/stripe-service";
import {
  beginWebhookEventProcessing,
  markWebhookEventFailed,
  markWebhookEventProcessed,
  upsertSubscription,
  setSubscriptionStatus,
  getStripeCustomerId,
  upsertStripeCustomer,
} from "@/modules/billing/billing-service";
import { createSupabaseServiceClient } from "@/server/integrations/supabase/server";
import { isPromptPayActive } from "@/modules/billing/platform-settings";
import type Stripe from "stripe";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (await isPromptPayActive()) {
    return NextResponse.json({ error: "Stripe billing is disabled" }, { status: 404 });
  }
  const sig = req.headers.get("stripe-signature") ?? "";
  const rawBody = Buffer.from(await req.arrayBuffer());

  let event: Stripe.Event;
  try {
    event = constructWebhookEvent(rawBody, sig);
  } catch (e) {
    console.error("[stripe/webhook] signature verification failed", e);
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  let processingAttemptId: string | null = null;
  try {
    const claim = await beginWebhookEventProcessing(event.id, event.type);
    const decision = claim.decision;
    processingAttemptId = claim.processingAttemptId;
    if (decision === "skip") {
      return NextResponse.json({ received: true });
    }
    if (decision === "retry_later") {
      return NextResponse.json({ error: "Webhook already processing" }, { status: 500 });
    }

    await handleEvent(event);
    if (!processingAttemptId) {
      throw new Error("Webhook processing attempt id missing");
    }
    await markWebhookEventProcessed(event.id, processingAttemptId);
  } catch (e) {
    if (processingAttemptId) {
      await markWebhookEventFailed(
        event.id,
        processingAttemptId,
        e instanceof Error ? e.message : "Unknown webhook error",
      ).catch((markError) => {
        console.error(`[stripe/webhook] failed to mark ${event.type} failed`, markError);
      });
    }
    console.error(`[stripe/webhook] failed to handle ${event.type}`, e);
    return NextResponse.json({ error: "Handler failed" }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}

async function resolveOrgFromCustomer(stripeCustomerId: string): Promise<string | null> {
  const supabase = await createSupabaseServiceClient();
  const { data } = await supabase
    .from("billing_customers")
    .select("organization_id")
    .eq("stripe_customer_id", stripeCustomerId)
    .maybeSingle();
  return data?.organization_id ?? null;
}

async function verifyOrgExists(organizationId: string): Promise<boolean> {
  const supabase = await createSupabaseServiceClient();
  const { data } = await supabase
    .from("organizations")
    .select("id")
    .eq("id", organizationId)
    .maybeSingle();
  return !!data;
}

function assertBillingWrite(result: { ok: boolean; error: unknown }, operation: string): void {
  if (result.ok) return;
  const message = result.error instanceof Error
    ? result.error.message
    : JSON.stringify(result.error);
  throw new Error(`${operation} failed: ${message}`);
}

async function handleEvent(event: Stripe.Event): Promise<void> {
  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      if (session.mode !== "subscription") return;
      const organizationId = session.metadata?.organization_id;
      if (!organizationId) {
        console.error("[stripe/webhook] checkout.session.completed missing organization_id");
        return;
      }
      if (!await verifyOrgExists(organizationId)) {
        console.error("[stripe/webhook] checkout.session.completed unknown org", organizationId);
        return;
      }
      const customerId = typeof session.customer === "string" ? session.customer : null;
      if (!customerId) {
        console.warn("[stripe/webhook] checkout.session.completed has no string customer id");
        return;
      }
      assertBillingWrite(await upsertStripeCustomer(organizationId, customerId), "upsertStripeCustomer");
      break;
    }

    case "customer.subscription.created":
    case "customer.subscription.updated": {
      const sub = event.data.object as Stripe.Subscription;
      const customerId = typeof sub.customer === "string" ? sub.customer : null;
      if (!customerId) return;

      const organizationId = sub.metadata?.organization_id
        ?? await resolveOrgFromCustomer(customerId);
      if (!organizationId) {
        console.error("[stripe/webhook] cannot resolve organizationId for customer", customerId);
        return;
      }
      if (!await verifyOrgExists(organizationId)) {
        console.error("[stripe/webhook] unknown org from subscription", organizationId);
        return;
      }

      const item = sub.items.data[0];
      const priceId = item?.price?.id ?? null;
      const lookupKey = item?.price?.lookup_key ?? null;
      const plan = mapStripePlan(priceId, lookupKey);
      const status = mapStripeStatus(sub.status);

      // current_period_start/end moved to SubscriptionItem in API 2026-04-22.dahlia
      const periodStart = item?.current_period_start ?? sub.start_date;
      const rawPeriodEnd = item?.current_period_end;
      if (!rawPeriodEnd) {
        throw new Error(`No current_period_end for subscription ${sub.id}`);
      }

      assertBillingWrite(await upsertSubscription(organizationId, {
        plan,
        status,
        stripeSubscriptionId: sub.id,
        stripePriceId: priceId,
        currentPeriodStart: toTimestamp(periodStart)!,
        currentPeriodEnd: toTimestamp(rawPeriodEnd)!,
        cancelAtPeriodEnd: sub.cancel_at_period_end,
        trialEnd: toTimestamp(sub.trial_end),
      }), "upsertSubscription");

      if (!await getStripeCustomerId(organizationId)) {
        assertBillingWrite(await upsertStripeCustomer(organizationId, customerId), "upsertStripeCustomer");
      }
      break;
    }

    case "customer.subscription.deleted": {
      const sub = event.data.object as Stripe.Subscription;
      const customerId = typeof sub.customer === "string" ? sub.customer : null;
      if (!customerId) return;
      const organizationId = sub.metadata?.organization_id
        ?? await resolveOrgFromCustomer(customerId);
      if (!organizationId) return;
      assertBillingWrite(await setSubscriptionStatus(organizationId, "canceled"), "setSubscriptionStatus");
      break;
    }

    case "invoice.payment_succeeded": {
      const invoice = event.data.object as Stripe.Invoice;
      const customerId = typeof invoice.customer === "string" ? invoice.customer : null;
      if (!customerId) return;
      const organizationId = await resolveOrgFromCustomer(customerId);
      if (!organizationId) return;
      // Status kept in sync via subscription.updated
      break;
    }

    case "invoice.payment_failed": {
      const invoice = event.data.object as Stripe.Invoice;
      const customerId = typeof invoice.customer === "string" ? invoice.customer : null;
      if (!customerId) return;
      const organizationId = await resolveOrgFromCustomer(customerId);
      if (!organizationId) return;
      console.warn("[stripe/webhook] payment failed for org", organizationId);
      break;
    }

    default:
      break;
  }
}
