import { NextResponse } from "next/server";
import {
  AuthorizationError,
  getOptionalResolvedCurrentPermissions,
} from "@/modules/auth/guards";
import { isPaidTier, type BillingDuration, type PaidTier } from "@/modules/billing/pricing";
import { submitPromptPayPayment } from "@/modules/billing/subscription-service";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const perms = await getOptionalResolvedCurrentPermissions();
    if (!perms) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (!perms.resolved.can("billing.manage")) {
      return NextResponse.json({ error: "Missing billing permission" }, { status: 403 });
    }

    const form = await req.formData();
    const plan = form.get("plan");
    const duration = form.get("duration");
    const slip = form.get("slip");

    if (typeof plan !== "string" || !isPaidTier(plan as PaidTier)) {
      return NextResponse.json({ error: "Invalid plan" }, { status: 400 });
    }
    if (duration !== "30d" && duration !== "1y") {
      return NextResponse.json({ error: "Invalid duration" }, { status: 400 });
    }
    if (!(slip instanceof File) || slip.size === 0) {
      return NextResponse.json({ error: "กรุณาแนบสลิป" }, { status: 400 });
    }

    const base64 = Buffer.from(await slip.arrayBuffer()).toString("base64");
    const result = await submitPromptPayPayment({
      organizationId: perms.ctx.organizationId,
      plan: plan as PaidTier,
      duration: duration as BillingDuration,
      submittedByUserId: perms.user.id,
      slipImageBase64: base64,
      slipImageContentType: slip.type || "image/jpeg",
    });

    return NextResponse.json({ ...result, ok: result.status === "verified" });
  } catch (e) {
    if (e instanceof AuthorizationError) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    console.error("[billing/verify-slip]", e);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
