import { NextResponse } from "next/server";
import { getResolvedCurrentPermissions } from "@/modules/auth/guards";
import { canUseFeature } from "@/modules/billing/types";
import { getOrganizationBillingState } from "@/modules/billing/billing-service";
import { AI_DEFAULT_MODEL, isAiEnabled } from "@/modules/ai/gateway";
import { diagnoseDeviceError, buildManualPath, type DeviceDiagnosisResult } from "@/modules/ai/device-diagnosis";
import { AI_MAX_OUTPUT_TOKENS, reserveQuota, settleUsage } from "@/modules/ai/quota";
import { createHash } from "node:crypto";

/**
 * POST /api/ai/device-diagnosis — D1 (explain an error).
 * Governance path (Task 9): feature gate → quota reserve (deny-before-call)
 * → governed adapter → idempotent settle. On any failure the response carries
 * a manual path instead of a raw provider error.
 */
export async function POST(request: Request) {
  const authz = await getResolvedCurrentPermissions();
  if (!authz) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { ctx, user, resolved } = authz;
  if (!resolved.can("settings.manage_printer") && !resolved.can("settings.manage_store")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const billingState = await getOrganizationBillingState(ctx.organizationId) ?? undefined;
  if (billingState && !canUseFeature(billingState, "aiAssistant")) {
    return NextResponse.json(
      { ok: false, reason: "ai_disabled", manualPath: buildManualPath("ai_disabled") },
      { status: 403 },
    );
  }
  if (!isAiEnabled()) {
    return NextResponse.json(
      { ok: false, reason: "ai_disabled", manualPath: buildManualPath("ai_disabled") },
      { status: 503 },
    );
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const requestId = typeof body.requestId === "string" && body.requestId.length <= 64 ? body.requestId : crypto.randomUUID();
  const requestHash = createHash("sha256").update(requestId).digest("hex").slice(0, 16);

  const reserve = await reserveQuota({ organizationId: ctx.organizationId, requestId, feature: "aiAssistant", maxTokens: AI_MAX_OUTPUT_TOKENS });
  if (!reserve.granted) {
    return NextResponse.json(
      { ok: false, reason: "quota_denied", quota: reserve.reason, manualPath: buildManualPath("quota_denied") },
      { status: 429 },
    );
  }

  try {
    const { advice, model } = await diagnoseDeviceError(
      {
        errorCode: String(body.errorCode ?? "unknown"),
        platform: String(body.platform ?? "other"),
        channel: String(body.channel ?? "browser"),
        printerModel: body.printerModel === undefined ? undefined : String(body.printerModel),
      },
      { approvedModelId: AI_DEFAULT_MODEL },
    );
    await settleUsage({
      organizationId: ctx.organizationId,
      requestId,
      feature: "aiAssistant",
      model,
      storeId: ctx.storeId,
      userId: user.id,
      tokens: AI_MAX_OUTPUT_TOKENS,
      status: "ok",
      requestHash,
    });
    return NextResponse.json({ ok: true, advice, requestId });
  } catch (error) {
    const message = error instanceof Error ? error.message : "error";
    const reason: NonNullable<Extract<DeviceDiagnosisResult, { ok: false }>["reason"]> =
      message === "ai_timeout" ? "ai_timeout" : message === "ai_disabled" ? "ai_disabled" : "error";
    if (reason !== "ai_timeout") {
      await settleUsage({
        organizationId: ctx.organizationId,
        requestId,
        feature: "aiAssistant",
        model: AI_DEFAULT_MODEL,
        storeId: ctx.storeId,
        userId: user.id,
        tokens: 0,
        status: reason === "ai_disabled" ? "denied" : "error",
        requestHash,
      });
    }
    return NextResponse.json({ ok: false, reason, manualPath: buildManualPath(reason) }, { status: reason === "ai_timeout" ? 504 : 500 });
  }
}