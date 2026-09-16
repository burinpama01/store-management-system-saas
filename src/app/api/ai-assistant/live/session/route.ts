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
  LIVE_SESSION_INSTRUCTIONS,
  createLiveEphemeralSession,
} from "@/modules/ai-assistant/live-openai-tools";
import {
  createLiveSessionToken,
  resolveLiveTokenSecret,
  verifyLiveSessionToken,
} from "@/modules/ai-assistant/live-session";
import { liveComposition, resolveLiveAccess, LIVE_ACCESS_NOTES } from "@/modules/ai-assistant/live-server";

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
  sessionToken: z.string().min(8).max(256),
}).strict();

export async function POST(request: Request) {
  const access = await resolveLiveAccess();
  if (!access.ok) return fail(access.reason, access.status, ACCESS_NOTES[access.reason]);
  const { ctx, config } = access;

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
    return fail("live_unconfigured", 503, "โหมดเสียงสดยังตั้งค่าไม่ครบ — แจ้งผู้ดูแลระบบ");
  }

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
      return fail("live_store_busy", 429, "ร้านนี้เปิดโหมดเสียงสดอยู่ครบจำนวนแล้ว — ปิดเซสชันเดิมก่อน");
    }
    return fail("invalid_body", 400);
  }

  // session config ทั้งก้อน (instructions ไทย + voice + tools ตาม allowlist) ถูกส่งไปตอนสร้าง
  // ephemeral secret — browser ได้แค่ token ชั่วคราว ไม่เคยเห็น OPENAI_API_KEY
  const provider = await createLiveEphemeralSession({
    apiKey,
    model: config.liveModel,
    instructions: LIVE_SESSION_INSTRUCTIONS,
    tools: LIVE_OPENAI_TOOLS,
  });
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
    return fail("live_provider_error", 502, "เชื่อมต่อผู้ให้บริการเสียงไม่สำเร็จ — ลองใหม่อีกครั้ง");
  }

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
    sessionToken: createLiveSessionToken(created.session.id, created.session.expiresAt, secret),
    /** client secret ชั่วคราวสำหรับ WebRTC — อายุสั้นตาม provider */
    ephemeralToken: provider.ephemeralToken,
    openaiSessionId: provider.openaiSessionId,
    model: config.liveModel,
    /** epoch ms ฝั่ง server — UI ใช้ตั้ง idle/expiry timer ให้ตรงกับที่ server บังคับ */
    expiresAt: created.session.expiresAt,
    allowedTools: [...MVP_TOOL_NAMES],
    caps: {
      sessionMinutes: config.liveMaxSessionMinutes,
      toolCallsPerSession: config.liveMaxToolCallsPerSession,
      concurrentSessionsPerStore: config.liveMaxConcurrentSessionsPerStore,
    },
  }, { headers: NO_STORE });
}

/**
 * ปิดเซสชัน (metering + คืน slot) — UI เรียกตอนแตะซ้ำ/ปิดแท็บ/จบก่อนกำหนด
 * จงใจไม่เช็ค pilot/kill switch ที่นี่: การปิดต้องทำได้เสมอแม้ผู้ดูแลเพิ่งปิดโหมด
 * (ไม่งั้นเซสชัน/ไมค์ที่ค้างจะปิดผ่านเส้นทางนี้ไม่ได้) — ความเป็นเจ้าของยังต้องผ่านครบ
 */
export async function DELETE(request: Request) {
  const access = await resolveLiveAccess();
  // ปิดเซสชันไม่ใช่สิทธิ์พิเศษ: ต้องมี pilot + kill switch เหมือนเส้นทางอื่นเพื่อไม่ให้
  // route นี้กลายเป็นช่องที่คนนอก pilot เรียกได้ — ผู้ใช้ที่เปิดเซสชันไว้จะยังปิดได้เพราะ
  // สถานะ pilot/kill switch ถูกตรวจ ณ เวลาเปิด (และปิดในเครื่องได้เสมอแม้ API ปฏิเสธ)
  if (!access.ok) {
    if (access.reason === "live_disabled" || access.reason === "live_pilot_only") {
      // ปิดฝั่ง client ได้อยู่แล้ว — ตอบ 200 แบบไม่มีอะไรให้ปิด เพื่อไม่ให้ UI ค้างสถานะ error
      return NextResponse.json({ ok: true, ended: false, reason: access.reason }, { headers: NO_STORE });
    }
    return fail(access.reason, access.status, ACCESS_NOTES[access.reason]);
  }
  const { ctx } = access;

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

  if (!verifyLiveSessionToken(parsed.data.sessionToken, parsed.data.sessionId, secret)) {
    return fail("live_session_invalid", 403, "เซสชันเสียงสดนี้ไม่ถูกต้อง — เปิดใหม่จากปุ่ม AI Live");
  }

  const session = liveComposition.liveSessions.get(parsed.data.sessionId);
  // หมดอายุ/TTL เก็บไปแล้ว = ถือว่าจบแล้ว (idempotent close ไม่ใช่ error)
  if (!session) return NextResponse.json({ ok: true, ended: false }, { headers: NO_STORE });
  if (session.organizationId !== ctx.organizationId || session.storeId !== ctx.storeId || session.userId !== ctx.userId) {
    return fail("live_session_invalid", 403, "เซสชันเสียงสดนี้ไม่ถูกต้อง — เปิดใหม่จากปุ่ม AI Live");
  }

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
  return NextResponse.json({
    ok: true,
    ended: true,
    toolCallsUsed: summary?.toolCallsUsed ?? 0,
    sessionSeconds: summary?.sessionSeconds ?? 0,
  }, { headers: NO_STORE });
}
