import { NextResponse } from "next/server";
import { logActionError } from "@/modules/system/event-log";
import {
  AuthorizationError,
  getOptionalResolvedCurrentPermissions,
} from "@/modules/auth/guards";
import { isPaidTier, type BillingDuration, type PaidTier } from "@/modules/billing/pricing";
import { parseBusinessConfigJson } from "@/modules/billing/business-plan";
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
    const discountCodeRaw = form.get("discountCode");
    const discountCode = typeof discountCodeRaw === "string" ? discountCodeRaw : undefined;

    if (typeof plan !== "string" || (plan !== "business" && !isPaidTier(plan as PaidTier))) {
      return NextResponse.json({ error: "Invalid plan" }, { status: 400 });
    }
    if (duration !== "30d" && duration !== "1y") {
      return NextResponse.json({ error: "Invalid duration" }, { status: 400 });
    }
    if (!(slip instanceof File) || slip.size === 0) {
      return NextResponse.json({ error: "กรุณาแนบสลิป" }, { status: 400 });
    }
    const businessConfig =
      plan === "business" ? parseBusinessConfigJson(form.get("businessConfig")) : null;
    if (plan === "business" && !businessConfig) {
      return NextResponse.json(
        { error: "กรุณาเลือกที่นั่ง/สาขา/ฟีเจอร์ของแพ็กเกจ Business" },
        { status: 400 },
      );
    }

    const base64 = Buffer.from(await slip.arrayBuffer()).toString("base64");
    const result = await submitPromptPayPayment({
      organizationId: perms.ctx.organizationId,
      plan: plan as PaidTier | "business",
      duration: duration as BillingDuration,
      submittedByUserId: perms.user.id,
      businessConfig,
      discountCode,
      slipImageBase64: base64,
      slipImageContentType: slip.type || "image/jpeg",
    });

    return NextResponse.json({ ...result, ok: result.status === "verified" });
  } catch (e) {
    if (e instanceof AuthorizationError) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    logActionError({ source: "billing.verify-slip", action: "POST", error: e });
    console.error("[billing/verify-slip]", e);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
