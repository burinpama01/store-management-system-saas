// Task 11/E — POST /api/ai/menu-scan (multipart: file)
// นโยบายรูป: ไม่เก็บรูป — อ่านเข้าหน่วยความจำ ตรวจ MIME/ขนาด ส่งให้ AI แล้วทิ้ง
// Governance: catalog.manage + feature gate aiVision + quota (deny-before-call)
import { NextResponse } from "next/server";
import { getResolvedCurrentPermissions } from "@/modules/auth/guards";
import { getOrganizationBillingState } from "@/modules/billing/billing-service";
import { canUseFeature } from "@/modules/billing/types";
import { AI_DEFAULT_MODEL, isAiEnabled } from "@/modules/ai/gateway";
import { extractMenuFromImage, sniffImageMime, MAX_IMAGE_BYTES } from "@/modules/ai/menu-scan";
import { AI_MAX_OUTPUT_TOKENS, reserveQuota, settleUsage } from "@/modules/ai/quota";
import { createHash } from "node:crypto";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const authz = await getResolvedCurrentPermissions();
  if (!authz) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { ctx, user, resolved } = authz;
  if (!resolved.can("catalog.manage")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const billingState = await getOrganizationBillingState(ctx.organizationId) ?? undefined;
  if (billingState && !canUseFeature(billingState, "aiVision")) {
    return NextResponse.json({ ok: false, reason: "ai_disabled", manualPath: "แพ็กเกจปัจจุบันยังไม่รวม AI อ่านเมนู" }, { status: 403 });
  }
  if (!isAiEnabled()) {
    return NextResponse.json({ ok: false, reason: "ai_disabled", manualPath: "ระบบ AI ยังไม่เปิดใช้ — เพิ่มเมนูด้วยมือตามปกติ" }, { status: 503 });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "invalid_form" }, { status: 400 });
  }
  const file = form.get("image");
  if (!(file instanceof File)) return NextResponse.json({ error: "missing_image" }, { status: 400 });
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    return NextResponse.json({ error: "image_too_large", maxBytes: MAX_IMAGE_BYTES }, { status: 413 });
  }
  const mime = sniffImageMime(bytes);
  if (!mime) return NextResponse.json({ error: "unsupported_image" }, { status: 415 });

  const requestId = crypto.randomUUID();
  const requestHash = createHash("sha256").update(requestId).digest("hex").slice(0, 16);
  const reserve = await reserveQuota({ organizationId: ctx.organizationId, requestId, feature: "aiVision", maxTokens: AI_MAX_OUTPUT_TOKENS });
  if (!reserve.granted) {
    return NextResponse.json({ ok: false, reason: "quota_denied", manualPath: "ครบโควตา AI — เพิ่มเมนูด้วยมือตามปกติ" }, { status: 429 });
  }

  try {
    const imageBase64 = Buffer.from(bytes).toString("base64");
    const items = await extractMenuFromImage(imageBase64, mime, AI_DEFAULT_MODEL);
    await settleUsage({
      organizationId: ctx.organizationId,
      requestId,
      feature: "aiVision",
      model: AI_DEFAULT_MODEL,
      storeId: ctx.storeId,
      userId: user.id,
      tokens: AI_MAX_OUTPUT_TOKENS,
      status: "ok",
      requestHash,
    });
    return NextResponse.json({ ok: true, items, note: "รูปถูกประมวลผลแล้วทิ้ง ระบบไม่เก็บรูป" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "error";
    const reason = message === "ai_timeout" ? "ai_timeout" : message === "ai_disabled" ? "ai_disabled" : "error";
    if (reason !== "ai_timeout") {
      await settleUsage({
        organizationId: ctx.organizationId,
        requestId,
        feature: "aiVision",
        model: AI_DEFAULT_MODEL,
        storeId: ctx.storeId,
        userId: user.id,
        tokens: 0,
        status: reason === "ai_disabled" ? "denied" : "error",
        requestHash,
      });
    }
    const manualPath =
      reason === "ai_timeout"
        ? "AI ใช้เวลานานเกินไป — ลองใหม่ หรือเพิ่มเมนูด้วยมือ"
        : "เกิดข้อผิดพลาด — เพิ่มเมนูด้วยมือตามปกติ";
    return NextResponse.json({ ok: false, reason, manualPath }, { status: reason === "ai_timeout" ? 504 : 500 });
  }
}