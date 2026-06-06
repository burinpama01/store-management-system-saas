import Stripe from "stripe";
import type { BillingPlan, BillingStatus } from "./types";

let _stripe: Stripe | undefined;
function getStripe(): Stripe {
  if (_stripe) return _stripe;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY is not set");
  _stripe = new Stripe(key, { apiVersion: "2026-04-22.dahlia" });
  return _stripe;
}

export async function findOrCreateStripeCustomer(
  stripeCustomerId: string | null,
  organizationId: string,
  email: string,
  name: string,
): Promise<string> {
  const stripe = getStripe();
  if (stripeCustomerId) {
    // Verify it still exists
    try {
      const cus = await stripe.customers.retrieve(stripeCustomerId);
      if (!cus.deleted) return stripeCustomerId;
    } catch {
      // Fall through to create
    }
  }
  const customer = await stripe.customers.create({
    email,
    name,
    metadata: { organization_id: organizationId },
  });
  return customer.id;
}

export async function createCheckoutSession(
  stripeCustomerId: string,
  priceId: string,
  organizationId: string,
  successUrl: string,
  cancelUrl: string,
): Promise<string> {
  const stripe = getStripe();
  const session = await stripe.checkout.sessions.create({
    customer: stripeCustomerId,
    mode: "subscription",
    line_items: [{ price: priceId, quantity: 1 }],
    subscription_data: {
      metadata: { organization_id: organizationId },
    },
    success_url: successUrl,
    cancel_url: cancelUrl,
  });
  if (!session.url) throw new Error("Stripe returned no checkout URL");
  return session.url;
}

export async function createPortalSession(
  stripeCustomerId: string,
  returnUrl: string,
): Promise<string> {
  const stripe = getStripe();
  const session = await stripe.billingPortal.sessions.create({
    customer: stripeCustomerId,
    return_url: returnUrl,
  });
  return session.url;
}

export function constructWebhookEvent(
  rawBody: Buffer,
  signature: string,
): Stripe.Event {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new Error("STRIPE_WEBHOOK_SECRET is not set");
  const stripe = getStripe();
  return stripe.webhooks.constructEvent(rawBody, signature, secret);
}

export function mapStripePlan(
  priceId: string | null | undefined,
  priceLookupKey: string | null | undefined,
): BillingPlan {
  const starterPrice = process.env.STRIPE_PRICE_STARTER;
  const standardPrice = process.env.STRIPE_PRICE_STANDARD;
  const premiumPrice = process.env.STRIPE_PRICE_PREMIUM;
  const enterprisePrice = process.env.STRIPE_PRICE_ENTERPRISE;

  const id = priceId ?? "";
  const key = priceLookupKey ?? "";

  if (starterPrice && id === starterPrice) return "starter";
  if (standardPrice && id === standardPrice) return "standard";
  if (premiumPrice && id === premiumPrice) return "premium";
  if (enterprisePrice && id === enterprisePrice) return "enterprise";
  // Lookup key fallback (when price env vars are not configured)
  if (key === "starter") return "starter";
  if (key === "standard") return "standard";
  if (key === "premium") return "premium";
  if (key === "enterprise") return "enterprise";
  // Unknown price ID — throw so caller can return 500 and let Stripe retry
  throw new Error(`Cannot map unknown priceId "${id}" / lookupKey "${key}" to a plan`);
}

export function mapStripeStatus(
  stripeStatus: Stripe.Subscription.Status,
): BillingStatus {
  switch (stripeStatus) {
    case "active":
      return "active";
    case "trialing":
      return "trialing";
    case "past_due":
      return "past_due";
    case "incomplete":
      return "incomplete";
    case "incomplete_expired":
      return "incomplete_expired";
    case "unpaid":
      return "unpaid";
    case "canceled":
      return "canceled";
    case "paused":
      return "paused";
    default:
      return "incomplete";
  }
}

export function toTimestamp(epoch: number | null | undefined): string | null {
  if (epoch == null) return null;
  return new Date(epoch * 1000).toISOString();
}
