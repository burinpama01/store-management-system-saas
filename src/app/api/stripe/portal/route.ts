import { NextResponse } from "next/server";
import { AuthorizationError, requirePermission } from "@/modules/auth/guards";
import { getCurrentUser, getUserStores, resolveCurrentStore } from "@/modules/auth/session";
import { getStripeCustomerId } from "@/modules/billing/billing-service";
import { createPortalSession } from "@/modules/billing/stripe-service";
import { isPromptPayActive } from "@/modules/billing/platform-settings";

export async function POST() {
  try {
    if (await isPromptPayActive()) {
      return NextResponse.json({ error: "Stripe billing is disabled" }, { status: 404 });
    }
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { organizations, stores, memberships } = await getUserStores();
    const ctx = await resolveCurrentStore(stores, organizations, memberships);
    if (!ctx) return NextResponse.json({ error: "No store context" }, { status: 400 });

    await requirePermission("billing.manage");

    const stripeCustomerId = await getStripeCustomerId(ctx.organizationId);
    if (!stripeCustomerId) {
      return NextResponse.json(
        { error: "No billing account found. Start a subscription first." },
        { status: 404 },
      );
    }

    const appUrl = process.env.APP_URL ?? "http://localhost:3000";
    const portalUrl = await createPortalSession(
      stripeCustomerId,
      `${appUrl}/settings/billing`,
    );

    return NextResponse.json({ url: portalUrl });
  } catch (e) {
    if (e instanceof AuthorizationError) {
      return NextResponse.json({ error: "Missing billing permission" }, { status: 403 });
    }
    console.error("[stripe/portal]", e);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
