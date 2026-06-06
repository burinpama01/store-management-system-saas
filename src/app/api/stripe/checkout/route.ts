import { NextResponse } from "next/server";
import { AuthorizationError, requirePermission } from "@/modules/auth/guards";
import { getCurrentUser, getUserStores, resolveCurrentStore } from "@/modules/auth/session";
import {
  getStripeCustomerId,
  upsertStripeCustomer,
} from "@/modules/billing/billing-service";
import {
  findOrCreateStripeCustomer,
  createCheckoutSession,
} from "@/modules/billing/stripe-service";
import { createSupabaseServiceClient } from "@/server/integrations/supabase/server";

const ALLOWED_PRICE_IDS = new Set([
  process.env.STRIPE_PRICE_STARTER,
  process.env.STRIPE_PRICE_STANDARD,
  process.env.STRIPE_PRICE_PREMIUM,
  process.env.STRIPE_PRICE_ENTERPRISE,
].filter(Boolean));

export async function POST(req: Request) {
  try {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { organizations, stores, memberships } = await getUserStores();
    const ctx = await resolveCurrentStore(stores, organizations, memberships);
    if (!ctx) return NextResponse.json({ error: "No store context" }, { status: 400 });

    await requirePermission("billing.manage");

    const body = await req.json().catch(() => ({}));
    const priceId: string = body.priceId ?? "";

    if (!priceId || !ALLOWED_PRICE_IDS.has(priceId)) {
      return NextResponse.json({ error: "Invalid price" }, { status: 400 });
    }

    // Resolve organization details for customer name/email
    const serviceClient = await createSupabaseServiceClient();
    const { data: orgRow } = await serviceClient
      .from("organizations")
      .select("name")
      .eq("id", ctx.organizationId)
      .maybeSingle();
    const orgName = orgRow?.name ?? "Organization";

    const userEmail = user.email ?? user.id;

    let stripeCustomerId = await getStripeCustomerId(ctx.organizationId);
    stripeCustomerId = await findOrCreateStripeCustomer(
      stripeCustomerId,
      ctx.organizationId,
      userEmail,
      orgName,
    );
    await upsertStripeCustomer(ctx.organizationId, stripeCustomerId);

    const appUrl = process.env.APP_URL ?? "http://localhost:3000";
    const checkoutUrl = await createCheckoutSession(
      stripeCustomerId,
      priceId,
      ctx.organizationId,
      `${appUrl}/settings/billing?checkout=success`,
      `${appUrl}/settings/billing?checkout=cancel`,
    );

    return NextResponse.json({ url: checkoutUrl });
  } catch (e) {
    if (e instanceof AuthorizationError) {
      return NextResponse.json({ error: "Missing billing permission" }, { status: 403 });
    }
    console.error("[stripe/checkout]", e);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
