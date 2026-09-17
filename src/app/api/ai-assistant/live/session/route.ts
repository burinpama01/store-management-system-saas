// PR3-Live (M3) — POST /api/ai-assistant/live/session (สร้างเซสชัน) + DELETE (ปิดเซสชัน)
//
// ด่านของ POST เรียงตายตัวตาม plan v2 §11 / ADR note ของ PR3-Live:
//   auth → permission pos.use → package gate (aiAssistant) → pilot org (403 live_pilot_only)
//   → kill switch AI_ASSISTANT_LIVE_ENABLED (+ AI_ASSISTANT_KILL_SWITCH กลาง) → rate limit
//   → body → concurrent cap ต่อร้าน (จาก store) → provider (OPENAI_API_KEY ฝั่ง server)
//
// สิ่งที่ห้ามหลุดออกจากไฟล์นี้:
//   - OPENAI_API_KEY / AI_ASSISTANT_LIVE_TOKEN_SECRET (อยู่ฝั่ง server เท่านั้น, ไม่ print ไม่ log)
//   - ข้อความหรือเสียงของผู้ใช้ (route นี้ไม่รับทั้งคู่อยู่แล้ว — รับแค่ activeCartId)
//
// สิ่งที่ route นี้ "ไม่" ทำ: ไม่สร้างตะกร้า ไม่ตรวจสินค้า ไม่ execute tool ใด ๆ —
// tool ทั้งหมดเดินผ่าน POST /live/tool (dispatcher เดิม + durable idempotency) เท่านั้น

import { NextResponse } from "next/server";
import { z } from "zod";
import { logSystemEvent } from "@/modules/system/event-log";
import { MVP_TOOL_NAMES } from "@/modules/ai-assistant/tools/pos-tools";
import {
  LIVE_OPENAI_TOOLS,
  buildLiveSessionInstructions,
  createLiveEphemeralSession,
} from "@/modules/ai-assistant/live-openai-tools";
import { buildMenuInstructions, buildTranscriptionPrompt } from "@/modules/ai-assistant/menu-context";
import {
  createLiveSessionToken,
  resolveLiveTokenSecret,
  verifyLiveSessionToken,
} from "@/modules/ai-assistant/live-session";
import { liveComposition, logLiveEvent, resolveLiveAccess, resolveLiveIdentity, LIVE_ACCESS_NOTES } from "@/modules/ai-assistant/live-server";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;
const CART_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const SESSION_ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;
/** คีย์ provider ต้องยาวพอสมควร — ค่าที่สั้นกว่านี้คือค่าผิด/ค่าว่าง ไม่ใช่ key จริง */
const MIN_PROVIDER_KEY_LENGTH = 16;

const ACCESS_NOTES = LIVE_ACCESS_NOTES;

function fail(reason: string, status: number, manualPath?: string, headers: Record<string, string> = {}) {
  return NextResponse.json({ ok: false, reason, manualPath }, { status, headers: { ...NO_STORE, ...headers } });
}

/** log ล้มเหลวต้องไม่เปลี่ยนผลลัพธ์ของ request (pattern เดียวกับ text-command route) */
async function safely(action: () => Promise<unknown>): Promise<void> {
  try {
    await action();
  } catch {
    // infra outage — ผู้เรียกตอบ typed reason อยู่แล้ว
  }
}

function readProviderKey(env: Readonly<Record<string, string | undefined>>): string | null {
  const key = env.OPENAI_API_KEY;
  return typeof key === "string" && key.length >= MIN_PROVIDER_KEY_LENGTH ? key : null;
}

const CreateSchema = z.object({
  /** ตะกร้าที่แท็บนี้ถืออยู่ — server ผูกให้ session ใบเดียวตลอดอายุ (client สร้าง id เอง) */
  activeCartId: z.string().regex(CART_ID_PATTERN),
}).strict();

const EndSchema = z.object({
  sessionId: z.string().regex(SESSION_ID_PATTERN),
  // token เป็น payload ที่เซ็นแล้ว (ไม่ใช่แค่ลายเซ็น) จึงยาวกว่ารุ่นก่อน — เพดานกันข้อความยาวผิดปกติ
  sessionToken: z.string().min(8).max(2048),
}).strict();

export async function POST(request: Request) {
  const access = await resolveLiveAccess();
  if (!access.ok) {
    // ทุกด่านที่ปฏิเสธต้องมีร่องรอย ไม่ใช่ 403 เงียบ ๆ (identity อาจไม่มีเลยเมื่อยังไม่ล็อกอิน)
    await logLiveEvent({ event: "live.access_denied", stage: "session", result: "blocked", reason: access.reason });
    return fail(access.reason, access.status, ACCESS_NOTES[access.reason]);
  }
  const { ctx, config } = access;
  await logLiveEvent({ event: "live.access_granted", stage: "session", result: "success", ctx });

  // rate limit ที่ route layer ก่อนแตะ provider/slot — กันสปามสร้างเซสชันซ้ำ
  const limit = liveComposition.sessionRateLimiter.check(`${ctx.organizationId}|${ctx.storeId}|${ctx.userId}`);
  if (!limit.allowed) {
    await safely(() => logSystemEvent({
      level: "warn",
      source: "ai.assistant",
      action: "liveSession",
      message: "ขอเปิดเซสชันเสียงสดเกินอัตราที่กำหนด",
      organizationId: ctx.organizationId,
      storeId: ctx.storeId,
      actorUserId: ctx.userId,
      context: { reason: "rate_limited", stage: "create" },
    }));
    await logLiveEvent({ event: "live.access_denied", stage: "session", result: "blocked", reason: "rate_limited", ctx });
    return fail("rate_limited", 429, "เปิดโหมดเสียงสดถี่เกินไป — รอแป๊บเดียวแล้วลองใหม่", {
      "Retry-After": String(Math.ceil(limit.retryAfterMs / 1000)),
    });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail("invalid_body", 400);
  }
  const parsed = CreateSchema.safeParse(body);
  if (!parsed.success) return fail("invalid_body", 400);

  // server ต้องมีทั้งความลับสำหรับ session token และ provider key — ขาดอย่างใดอย่างหนึ่ง = ปิดโหมด (fail closed)
  const secret = resolveLiveTokenSecret(process.env);
  const apiKey = readProviderKey(process.env);
  if (!secret || !apiKey) {
    await logLiveEvent({
      event: "live.session_create_failed", stage: "session", result: "failed", reason: "live_unconfigured", ctx,
    });
    return fail("live_unconfigured", 503, "โหมดเสียงสดยังตั้งค่าไม่ครบ — แจ้งผู้ดูแลระบบ");
  }

  await logLiveEvent({ event: "live.session_create_started", stage: "session", result: "started", ctx });

  // concurrent cap ต่อร้านถูกบังคับที่ store เอง (ไม่ใช่ check-then-set)
  const created = liveComposition.liveSessions.create(
    { organizationId: ctx.organizationId, storeId: ctx.storeId, userId: ctx.userId },
    {
      ttlMs: config.liveMaxSessionMinutes * 60_000,
      activeCartId: parsed.data.activeCartId,
      allowedTools: [...MVP_TOOL_NAMES],
    },
  );
  if (!created.ok) {
    if (created.reason === "store_busy") {
      await safely(() => logSystemEvent({
        level: "warn",
        source: "ai.assistant",
        action: "liveSession",
        message: "ร้านนี้เปิดเซสชันเสียงสดครบเพดานแล้ว",
        organizationId: ctx.organizationId,
        storeId: ctx.storeId,
        actorUserId: ctx.userId,
        context: { reason: "live_store_busy", stage: "create" },
      }));
      await logLiveEvent({
        event: "live.session_create_failed", stage: "session", result: "blocked", reason: "live_store_busy", ctx,
      });
      return fail("live_store_busy", 429, "ร้านนี้เปิดโหมดเสียงสดอยู่ครบจำนวนแล้ว — ปิดเซสชันเดิมก่อน");
    }
    await logLiveEvent({
      event: "live.session_create_failed", stage: "session", result: "failed", reason: created.reason, ctx,
    });
    return fail("invalid_body", 400);
  }

  // session config ทั้งก้อน (instructions ไทย + voice + tools ตาม allowlist) ถูกส่งไปตอนสร้าง
  // ephemeral secret — browser ได้แค่ token ชั่วคราว ไม่เคยเห็น OPENAI_API_KEY
  //
  // เมนูจริงของร้าน (ชื่อ/ตัวเลือก/ค่าเริ่มต้น) ต่อท้าย instructions ให้ model รู้ตั้งแต่เริ่มคุย —
  // โหลดไม่ได้ = เปิดเซสชันต่อโดยไม่มีรายการเมนู (tool ค้นหายังตอบตัวเลือกได้) ไม่ปิดโหมดทั้งหมด
  let products: Awaited<ReturnType<typeof liveComposition.loadCatalog>>["products"] = [];
  try {
    products = (await liveComposition.loadCatalog(ctx.storeId)).products;
  } catch {
    products = [];
  }
  const menuInstructions = buildMenuInstructions(products);
  const providerStartedAt = Date.now();
  await logLiveEvent({
    event: "provider.client_secret_started", stage: "provider", result: "started", ctx,
    sessionId: created.session.id,
    metadata: {
      model: config.liveModel,
      speechSpeed: config.liveSpeechSpeed,
      menuChars: menuInstructions?.length ?? 0,
      transcripts: config.liveTranscriptsEnabled,
    },
  });
  const providerBase = {
    apiKey,
    model: config.liveModel,
    instructions: buildLiveSessionInstructions(menuInstructions),
    tools: LIVE_OPENAI_TOOLS,
  };
  let provider = await createLiveEphemeralSession({
    ...providerBase,
    speechSpeed: config.liveSpeechSpeed,
    // ถอดเสียงผู้ใช้เฉพาะตอนเก็บบทสนทนา (มีค่าใช้จ่ายต่อนาที และ model หลักฟังเสียงตรงอยู่แล้ว)
    ...(config.liveTranscriptsEnabled
      ? { transcription: { model: config.liveTranscribeModel, language: "th", prompt: buildTranscriptionPrompt(products) } }
      : {}),
  });
  if (!provider.ok && provider.reason === "provider_rejected") {
    // บทเรียน PR #49: config ที่ provider ไม่รับทำให้ Live ล่มทั้งระบบ — ถ้าส่วนเสียง (ความเร็ว/ถอดเสียง)
    // ถูกปฏิเสธ ให้เปิดแบบเดิมไปก่อน (ร้านยังใช้ได้) แล้วทิ้งร่องรอยไว้ให้แก้
    await logLiveEvent({
      event: "provider.client_secret_failed", stage: "provider", result: "failed", reason: "audio_config_rejected", ctx,
      sessionId: created.session.id,
    });
    await safely(() => logSystemEvent({
      level: "warn",
      source: "ai.assistant",
      action: "liveSession",
      message: "provider ไม่รับการตั้งค่าเสียง (ความเร็ว/ถอดเสียง) — เปิดเซสชันแบบไม่มีการตั้งค่าเสียงแทน",
      organizationId: ctx.organizationId,
      storeId: ctx.storeId,
      actorUserId: ctx.userId,
      context: { reason: "audio_config_rejected", stage: "provider" },
    }));
    provider = await createLiveEphemeralSession(providerBase);
  }
  if (!provider.ok) {
    // provider ปฏิเสธ/ล่ม = คืน slot ทันที ไม่งั้นร้านเปิดใหม่ไม่ได้จนกว่า TTL จะหมดเอง
    liveComposition.liveSessions.end(created.session.id);
    await safely(() => logSystemEvent({
      level: "warn",
      source: "ai.assistant",
      action: "liveSession",
      message: `สร้างเซสชันเสียงสดกับ provider ไม่สำเร็จ (${provider.reason})`,
      organizationId: ctx.organizationId,
      storeId: ctx.storeId,
      actorUserId: ctx.userId,
      context: { reason: provider.reason, stage: "provider" },
    }));
    await logLiveEvent({
      event: "provider.client_secret_failed", stage: "provider", result: "failed", reason: provider.reason, ctx,
      sessionId: created.session.id, durationMs: Date.now() - providerStartedAt,
    });
    return fail("live_provider_error", 502, "เชื่อมต่อผู้ให้บริการเสียงไม่สำเร็จ — ลองใหม่อีกครั้ง");
  }

  await logLiveEvent({
    event: "provider.client_secret_created", stage: "provider", result: "success", ctx,
    sessionId: created.session.id, durationMs: Date.now() - providerStartedAt,
  });
  await logLiveEvent({
    event: "live.session_created", stage: "session", result: "success", ctx, sessionId: created.session.id,
    metadata: { model: config.liveModel, sessionMinutes: config.liveMaxSessionMinutes },
  });

  // metering: metadata เท่านั้น (ไม่มีข้อความ/เสียง/transcript ทุกกรณี)
  await safely(() => logSystemEvent({
    level: "info",
    source: "ai.assistant",
    action: "liveSession",
    message: "เปิดเซสชันเสียงสด",
    organizationId: ctx.organizationId,
    storeId: ctx.storeId,
    actorUserId: ctx.userId,
    context: {
      reason: "created",
      stage: "create",
      sessionId: created.session.id,
      model: config.liveModel,
      sessionMinutes: config.liveMaxSessionMinutes,
      toolCallsPerSession: config.liveMaxToolCallsPerSession,
    },
  }));

  return NextResponse.json({
    ok: true,
    sessionId: created.session.id,
    // token ถือข้อมูลเซสชันครบ (org/store/user/ตะกร้า/อายุ/เพดาน) — relay จึงไม่ต้องพึ่ง state
    // ของ instance ใด instance หนึ่ง (แก้อาการหลุดกลางบทสนทนาเมื่อ request ตกคนละ instance)
    sessionToken: createLiveSessionToken({
      sessionId: created.session.id,
      organizationId: created.session.organizationId,
      storeId: created.session.storeId,
      userId: created.session.userId,
      activeCartId: created.session.activeCartId,
      allowedTools: created.session.allowedTools,
      maxToolCalls: created.session.maxToolCalls,
      expiresAt: created.session.expiresAt,
    }, secret),
    /** client secret ชั่วคราวสำหรับ WebRTC — อายุสั้นตาม provider */
    ephemeralToken: provider.ephemeralToken,
    openaiSessionId: provider.openaiSessionId,
    model: config.liveModel,
    /** epoch ms ฝั่ง server — UI ใช้ตั้ง idle/expiry timer ให้ตรงกับที่ server บังคับ */
    expiresAt: created.session.expiresAt,
    allowedTools: [...MVP_TOOL_NAMES],
    /** เครื่องส่งข้อความบทสนทนามาที่ /live/transcript เฉพาะเมื่อ server เปิดเก็บ */
    transcriptsEnabled: config.liveTranscriptsEnabled,
    caps: {
      sessionMinutes: config.liveMaxSessionMinutes,
      toolCallsPerSession: config.liveMaxToolCallsPerSession,
      concurrentSessionsPerStore: config.liveMaxConcurrentSessionsPerStore,
    },
  }, { headers: NO_STORE });
}

/**
 * ปิดเซสชัน (metering + คืน slot) — UI เรียกตอนแตะซ้ำ/ปิดแท็บ/จบก่อนกำหนด
 *
 * ด่านของ DELETE ต่างจาก POST โดยตั้งใจ: ตรวจแค่ "ล็อกอินอยู่" + session token (HMAC)
 * + เซสชันเป็นของ org/store/user นี้จริง — ไม่ผ่าน pilot / kill switch / แพ็กเกจ
 *
 * เหตุผล (เคสจริงที่รอบก่อนยังพลาด): ถ้าผู้ดูแลปิด AI_ASSISTANT_LIVE_ENABLED ระหว่างที่ร้าน
 * เปิดเซสชันอยู่ เส้นทางเดิมจะตอบ ended:false โดยไม่ลบเซสชันจริง → slot ของร้านค้างจนหมด TTL
 * แล้วเปิดใหม่เจอ live_store_busy ทั้งที่ไม่มีใครใช้ การคืนทรัพยากรที่สร้างไปแล้วจึงต้องทำได้เสมอ
 */
export async function DELETE(request: Request) {
  const identity = await resolveLiveIdentity();
  if (!identity.ok) return fail(identity.reason, identity.status, ACCESS_NOTES[identity.reason]);
  const { ctx } = identity;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail("invalid_body", 400);
  }
  const parsed = EndSchema.safeParse(body);
  if (!parsed.success) return fail("invalid_body", 400);

  const secret = resolveLiveTokenSecret(process.env);
  if (!secret) return fail("live_unconfigured", 503, "โหมดเสียงสดยังตั้งค่าไม่ครบ — แจ้งผู้ดูแลระบบ");

  // ตัวตนของเซสชันมาจาก token ที่เซ็นแล้ว (ไม่พึ่ง state ของ instance) — id ใน body ต้องตรงกันด้วย
  const claims = verifyLiveSessionToken(parsed.data.sessionToken, secret);
  if (!claims || claims.sessionId !== parsed.data.sessionId) {
    await logLiveEvent({
      event: "live.stop_failed", stage: "stop", result: "failed", reason: "live_session_invalid", ctx,
      sessionId: parsed.data.sessionId,
    });
    return fail("live_session_invalid", 403, "เซสชันเสียงสดนี้ไม่ถูกต้อง — เปิดใหม่จากปุ่ม AI Live");
  }
  await logLiveEvent({ event: "live.stop_requested", stage: "stop", result: "started", ctx, sessionId: claims.sessionId });
  // เซสชันต้องเป็นของผู้เรียกจริง ๆ (ระดับ org + store + user)
  if (claims.organizationId !== ctx.organizationId || claims.storeId !== ctx.storeId || claims.userId !== ctx.userId) {
    return fail("live_session_invalid", 403, "เซสชันเสียงสดนี้ไม่ถูกต้อง — เปิดใหม่จากปุ่ม AI Live");
  }

  // เพิกถอน token ที่ยังไม่หมดอายุ (กันสั่งงานต่อหลังปิด) แล้วคืน slot ของ instance นี้ถ้ามี
  liveComposition.liveSessions.revoke(claims.sessionId, claims.expiresAt);
  const summary = liveComposition.liveSessions.end(parsed.data.sessionId);
  if (summary) {
    await safely(() => logSystemEvent({
      level: "info",
      source: "ai.assistant",
      action: "liveSession",
      message: "ปิดเซสชันเสียงสด",
      organizationId: ctx.organizationId,
      storeId: ctx.storeId,
      actorUserId: ctx.userId,
      context: {
        reason: "ended",
        stage: "end",
        sessionId: summary.session.id,
        sessionSeconds: summary.sessionSeconds,
        toolCallsUsed: summary.toolCallsUsed,
      },
    }));
  }
  await logLiveEvent({
    event: "live.stopped", stage: "stop", result: "ended", ctx, sessionId: claims.sessionId,
    reason: summary ? "closed" : "already_closed",
    // เก็บเฉพาะค่าที่ instance นี้รู้จริง — ข้าม instance จะไม่มีตัวเลข ห้ามปั้นค่า
    metadata: summary
      ? { sessionSeconds: summary.sessionSeconds, toolCallsUsed: summary.toolCallsUsed }
      : {},
  });

  return NextResponse.json({
    // ended = instance นี้มีเซสชันให้ปิดจริงหรือไม่ (ปิดซ้ำ/เซสชันอยู่ instance อื่น = false)
    // ไม่ว่าค่าไหน token ก็ถูกเพิกถอนบน instance นี้แล้ว และ UI ปิดไมค์ในเครื่องเสมอ
    ok: true,
    ended: summary !== null,
    toolCallsUsed: summary?.toolCallsUsed ?? 0,
    sessionSeconds: summary?.sessionSeconds ?? 0,
  }, { headers: NO_STORE });
}
