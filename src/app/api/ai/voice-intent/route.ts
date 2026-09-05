// P4 (v0.44.3) — POST /api/ai/voice-intent
//
// ด่านเดียวที่คำพูดจาก POS จะไปถึงผู้ให้บริการ AI ได้ ลำดับตายตัว:
//   auth → permission pos.use → package gate → AI enabled → validate body →
//   reserve quota (deny-before-call) → provider → settle → ตอบเฉพาะ envelope/เหตุผล
//
// สิ่งที่ห้ามหลุดออกจากไฟล์นี้:
//   - transcript (ไม่ echo กลับ, ไม่ log, ไม่ลง system_event_logs)
//   - ข้อความ error ดิบของผู้ให้บริการ (ตอบเป็น reason code เท่านั้น)
import { NextResponse } from "next/server";
import { z } from "zod";
import { getResolvedCurrentPermissions } from "@/modules/auth/guards";
import { getOrganizationBillingState } from "@/modules/billing/billing-service";
import { canUseFeature } from "@/modules/billing/types";
import { AI_DEFAULT_MODEL, isAiEnabled } from "@/modules/ai/gateway";
import {
  VOICE_INTENT_LOCALES,
  VOICE_INTENT_MAX_UTTERANCE,
  VOICE_INTENT_ORIGINS,
  interpretVoiceIntent,
} from "@/modules/ai/voice-intent";
import { AI_MAX_OUTPUT_TOKENS, reserveQuota, settleUsage } from "@/modules/ai/quota";
import { logSystemEvent } from "@/modules/system/event-log";
import { createHash } from "node:crypto";

export const dynamic = "force-dynamic";

/** feature ที่ใช้กับ ledger/quota (แยกจาก aiAssistant เพื่อดูต้นทุนของเสียงได้ตรง ๆ) */
const QUOTA_FEATURE = "aiVoiceIntent";
const NO_STORE = { "Cache-Control": "no-store" } as const;

const VoiceIntentRequestSchema = z
  .object({
    requestId: z.string().min(8).max(64),
    utterance: z.string().min(1).max(VOICE_INTENT_MAX_UTTERANCE),
    locale: z.enum(VOICE_INTENT_LOCALES),
    origin: z.enum(VOICE_INTENT_ORIGINS),
  })
  .strict();

function fail(reason: string, status: number, manualPath?: string) {
  return NextResponse.json({ ok: false, reason, manualPath }, { status, headers: NO_STORE });
}

export async function POST(request: Request) {
  const authz = await getResolvedCurrentPermissions();
  if (!authz) return fail("unauthorized", 401);
  const { ctx, user, resolved } = authz;
  if (!resolved.can("pos.use")) return fail("forbidden", 403);

  const billingState = (await getOrganizationBillingState(ctx.organizationId)) ?? undefined;
  if (billingState && !canUseFeature(billingState, "aiAssistant")) {
    return fail("ai_not_in_plan", 403, "แพ็กเกจนี้ยังไม่รวมผู้ช่วย AI — ใช้ปุ่มบนหน้าจอได้ตามปกติ");
  }
  if (!isAiEnabled()) {
    return fail("ai_disabled", 503, "ระบบ AI ยังไม่เปิดใช้ — พูดคำสั่งแบบสั้น หรือกดบนหน้าจอ");
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail("invalid_body", 400);
  }
  const parsed = VoiceIntentRequestSchema.safeParse(body);
  if (!parsed.success) return fail("invalid_body", 400);
  const input = parsed.data;

  // request hash ผูกกับ requestId เท่านั้น — ห้ามให้ transcript มีอิทธิพลกับสิ่งที่เก็บ
  const requestHash = createHash("sha256").update(input.requestId).digest("hex").slice(0, 16);

  const reserve = await reserveQuota({
    organizationId: ctx.organizationId,
    requestId: input.requestId,
    feature: QUOTA_FEATURE,
    maxTokens: AI_MAX_OUTPUT_TOKENS,
  });
  if (!reserve.granted) {
    return fail("quota_denied", 429, "โควตา AI หมด — เติมเงินที่ ตั้งค่า → เรียกเก็บเงิน หรือใช้ปุ่มบนหน้าจอได้ตามปกติ");
  }

  const result = await interpretVoiceIntent({
    utterance: input.utterance,
    locale: input.locale,
    approvedModelId: AI_DEFAULT_MODEL,
  });

  const settleBase = {
    organizationId: ctx.organizationId,
    requestId: input.requestId,
    feature: QUOTA_FEATURE,
    model: AI_DEFAULT_MODEL,
    storeId: ctx.storeId,
    userId: user.id,
    requestHash,
  } as const;

  if (!result.ok) {
    // timeout เก็บ reservation ไว้ให้ reconcile ตาม convention ของ quota module
    if (result.reason !== "ai_timeout") {
      await settleUsage({
        ...settleBase,
        tokens: 0,
        status: result.reason === "ai_disabled" ? "denied" : "error",
      });
    }
    // log ได้เฉพาะรหัสผล — ไม่มีคำพูดของผู้ใช้อยู่ในนี้
    await logSystemEvent({
      level: "warn",
      source: "ai.voice-intent",
      action: "interpret",
      message: `แปลคำสั่งเสียงด้วย AI ไม่สำเร็จ (${result.reason})`,
      organizationId: ctx.organizationId,
      storeId: ctx.storeId,
      actorUserId: user.id,
      context: { reason: result.reason, locale: input.locale, origin: input.origin },
    });
    const status = result.reason === "ai_timeout" ? 504 : result.reason === "ai_disabled" ? 503 : 502;
    return fail(result.reason, status, "ยังแปลคำสั่งนี้ไม่ได้ — ใช้ปุ่มหรือพูดแบบสั้นได้");
  }

  await settleUsage({ ...settleBase, tokens: result.tokens, status: "ok" });
  await logSystemEvent({
    level: "info",
    source: "ai.voice-intent",
    action: "interpret",
    message: `แปลคำสั่งเสียงด้วย AI สำเร็จ (${result.envelope.outcome}, ${result.envelope.commands.length} คำสั่ง)`,
    organizationId: ctx.organizationId,
    storeId: ctx.storeId,
    actorUserId: user.id,
    context: {
      outcome: result.envelope.outcome,
      reasonCode: result.envelope.reasonCode,
      confidence: result.envelope.confidence,
      commandCount: result.envelope.commands.length,
      locale: input.locale,
      origin: input.origin,
    },
  });

  return NextResponse.json({ ok: true, intent: result.envelope }, { headers: NO_STORE });
}
