// PR3-Live (M4) — POST /api/ai-assistant/live/tool (relay คำสั่ง tool จากบทสนทนาเสียงสด)
//
// บทบาท: browser เป็นเพียง "ท่อ" — เมื่อ data channel ของ Realtime ส่ง function_call มา
// browser ส่งต่อที่ route นี้เท่านั้น ห้าม execute อะไรเอง route จึงเป็นด่านเดียวที่ tool
// ถูกเรียก และเดินผ่าน dispatcher เดิม (permission/entitlement/risk/mutation/idempotency/audit)
//
// ลำดับด่าน (เหมือน session route ทุกข้อ + เฉพาะของ relay):
//   auth → pos.use → plan (aiAssistant) → pilot org → kill switch (re-read ทุก request)
//   → rate limit ของ relay → body → session token (HMAC) → session ยังไม่หมดอายุ + identity ตรง
//   → นับ tool call ของเซสชัน (นับ attempt รวมที่ถูกปฏิเสธ — กัน loop) → tool อยู่ใน allowedTools
//   → dispatcher เดิม (durable idempotency) → ตอบ result/typed code
//
// สิ่งที่ห้ามหลุดออกจากไฟล์นี้: ข้อความ/เสียง/transcript ของผู้ใช้ (route ไม่รับทั้งคู่อยู่แล้ว —
// รับแค่ชื่อ tool + args ที่ model สร้าง) และ OPENAI_API_KEY (อยู่ฝั่ง server เท่านั้น)
// metering ลง logSystemEvent ได้เฉพาะ metadata: callId (opaque), tool, outcome code, duration

import { NextResponse } from "next/server";
import { z } from "zod";
import { logSystemEvent } from "@/modules/system/event-log";
import { MVP_TOOL_NAMES, type MvpToolName } from "@/modules/ai-assistant/tools/pos-tools";
import { buildLiveToolArgs, type LiveInjectedCartContext } from "@/modules/ai-assistant/live-openai-tools";
import { resolveLiveTokenSecret, verifyLiveSessionToken } from "@/modules/ai-assistant/live-session";
import { liveComposition, resolveLiveAccess, LIVE_ACCESS_NOTES } from "@/modules/ai-assistant/live-server";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;
const SESSION_ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;
/** callId ของ provider เป็น opaque id — รับเฉพาะรูปทรงที่ปลอดภัยต่อ log/metadata */
const CALL_ID_PATTERN = /^[A-Za-z0-9_-]{6,128}$/;
/** idempotency key ต่อ 1 function_call — client สร้างจาก callId (รูปแบบเดียวกับ envelope) */
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

const ACCESS_NOTES = LIVE_ACCESS_NOTES;

const SummarySchema = z.object({
  itemCount: z.number().int().min(0).max(9999),
  total: z.number().min(0),
  locked: z.boolean(),
}).strict();

const BodySchema = z.object({
  sessionId: z.string().regex(SESSION_ID_PATTERN),
  // token เป็น payload ที่เซ็นแล้ว (ไม่ใช่แค่ลายเซ็น) จึงยาวกว่ารุ่นก่อน — เพดานกันข้อความยาวผิดปกติ
  sessionToken: z.string().min(8).max(2048),
  callId: z.string().regex(CALL_ID_PATTERN),
  tool: z.enum(MVP_TOOL_NAMES),
  args: z.unknown().optional(),
  idempotencyKey: z.string().regex(IDEMPOTENCY_KEY_PATTERN),
  /** cartRef ที่ client ถืออยู่ — server ฉีดเข้า args เอง ไม่เชื่อค่าที่ model ส่งมา */
  cartVersion: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  /** สรุปตะกร้าจาก client (ตะกร้าเป็น state ในเครื่อง) — ต้องมีสำหรับ pos.get_current_order */
  summary: SummarySchema.optional(),
}).strict();

function fail(reason: string, status: number, manualPath?: string, headers: Record<string, string> = {}) {
  return NextResponse.json({ ok: false, reason, manualPath }, { status, headers: { ...NO_STORE, ...headers } });
}

/** log ล้มเหลวต้องไม่เปลี่ยนผลลัพธ์ของ request (pattern เดียวกับ route อื่นของ ai-assistant) */
async function safely(action: () => Promise<unknown>): Promise<void> {
  try {
    await action();
  } catch {
    // infra outage — ผู้เรียกตอบ typed reason อยู่แล้ว
  }
}

export async function POST(request: Request) {
  const access = await resolveLiveAccess();
  if (!access.ok) return fail(access.reason, access.status, ACCESS_NOTES[access.reason]);
  const { ctx } = access;

  // rate limit ที่ route layer ก่อนแตะ session/dispatcher — กันสปามกลางบทสนทนา
  const limit = liveComposition.toolRateLimiter.check(`${ctx.organizationId}|${ctx.storeId}|${ctx.userId}`);
  if (!limit.allowed) {
    await safely(() => logSystemEvent({
      level: "warn",
      source: "ai.assistant",
      action: "liveTool",
      message: "relay คำสั่งเสียงสดเกินอัตราที่กำหนด",
      organizationId: ctx.organizationId,
      storeId: ctx.storeId,
      actorUserId: ctx.userId,
      context: { reason: "rate_limited", stage: "relay" },
    }));
    return fail("rate_limited", 429, "มีคำสั่งเข้ามาถี่เกินไป — รอแป๊บเดียวแล้วพูดใหม่", {
      "Retry-After": String(Math.ceil(limit.retryAfterMs / 1000)),
    });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail("invalid_body", 400);
  }
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) return fail("invalid_body", 400);
  const input = parsed.data;

  // ความลับของ session token — ไม่มี = ปิดโหมด (fail closed, ไม่มีทาง verify ได้เลย)
  const secret = resolveLiveTokenSecret(process.env);
  if (!secret) return fail("live_unconfigured", 503, "โหมดเสียงสดยังตั้งค่าไม่ครบ — แจ้งผู้ดูแลระบบ");

  // ตัวตนของเซสชันทั้งหมดอยู่ใน token ที่ server เซ็นไว้ (org/store/user/ตะกร้า/อายุ/เพดาน)
  // จึงไม่ต้องหาเซสชันจากหน่วยความจำของ instance — request ที่ตกคนละ instance ยังคุยต่อได้
  // (ของเดิมตอบ 403 live_session_invalid กลางบทสนทนาเมื่อ instance ไม่ตรงกัน)
  const claims = verifyLiveSessionToken(input.sessionToken, secret);
  if (!claims || claims.sessionId !== input.sessionId) {
    return fail("live_session_invalid", 403, "เซสชันเสียงสดหมดอายุแล้ว — แตะปุ่ม AI Live เปิดใหม่");
  }
  // เซสชันต้องเป็นของ identity ผู้เรียกเท่านั้น (ระดับ org + store + user)
  if (claims.organizationId !== ctx.organizationId || claims.storeId !== ctx.storeId || claims.userId !== ctx.userId) {
    return fail("live_session_invalid", 403, "เซสชันเสียงสดนี้ไม่ถูกต้อง — เปิดใหม่จากปุ่ม AI Live");
  }

  // ปิดเซสชันไปแล้ว = ห้ามสั่งงานต่อแม้ token จะยังไม่หมดอายุ (best-effort ต่อ instance)
  if (liveComposition.liveSessions.isRevoked(claims.sessionId)) {
    return fail("live_session_invalid", 403, "เซสชันเสียงสดนี้ปิดไปแล้ว — แตะปุ่ม AI Live เปิดใหม่");
  }

  // เพดาน tool call ต่อเซสชันนับที่ instance นี้ (best-effort เหมือน rate limiter) — ถ้าเซสชัน
  // ถูกสร้างบน instance อื่น ให้รับเข้ามานับต่อจากข้อมูลใน token ที่ตรวจลายเซ็นแล้ว
  const session = liveComposition.liveSessions.adopt({
    id: claims.sessionId,
    organizationId: claims.organizationId,
    storeId: claims.storeId,
    userId: claims.userId,
    activeCartId: claims.activeCartId,
    allowedTools: claims.allowedTools,
    startedAt: Date.now(),
    expiresAt: claims.expiresAt,
    maxToolCalls: claims.maxToolCalls,
  });

  // นับ "ความพยายามเรียก tool" รวมที่ถูกปฏิเสธ — loop ของ model ต้องหยุดที่เพดานนี้
  const budget = liveComposition.liveSessions.consumeToolCall(input.sessionId);
  if (!budget.ok) {
    if (budget.reason === "cap_reached") {
      await safely(() => logSystemEvent({
        level: "warn",
        source: "ai.assistant",
        action: "liveTool",
        message: "เซสชันเสียงสดใช้จำนวนคำสั่งครบเพดานแล้ว",
        organizationId: ctx.organizationId,
        storeId: ctx.storeId,
        actorUserId: ctx.userId,
        context: { reason: "live_tool_cap_reached", stage: "relay", sessionId: input.sessionId, tool: input.tool },
      }));
      return fail("live_tool_cap_reached", 429, "ใช้จำนวนคำสั่งของเซสชันนี้ครบแล้ว — แตะปุ่ม AI Live เปิดเซสชันใหม่");
    }
    return fail("live_session_invalid", 403, "เซสชันเสียงสดหมดอายุแล้ว — แตะปุ่ม AI Live เปิดใหม่");
  }

  // allowlist ของเซสชันเป็นด่านกลาง (route สร้าง session ด้วย MVP set — เช็คซ้ำกันกรณี allowlist ถูกจำกัดต่อร้าน)
  if (!session.allowedTools.includes(input.tool)) {
    return fail("live_tool_not_allowed", 403, "คำสั่งนี้ยังไม่เปิดใช้ในโหมดเสียงสด");
  }

  // dispatcher เดิมของระบบ (durable idempotency + audit + ทุกเกต) — สร้างไม่ได้ = typed 503
  let dispatch: Awaited<ReturnType<typeof liveComposition.getLiveDispatch>>;
  try {
    dispatch = await liveComposition.getLiveDispatch();
  } catch {
    return fail("assistant_unavailable", 503, "ผู้ช่วยยังใช้ไม่ได้ชั่วคราว — ลองใหม่อีกครั้ง");
  }

  // activeCartId มาจาก session ที่ server ผูกไว้, cartVersion/summary มาจาก client เจ้าของตะกร้า
  const injected: LiveInjectedCartContext = {
    activeCartId: claims.activeCartId,
    cartVersion: input.cartVersion,
    ...(input.summary ? { summary: input.summary } : {}),
  };
  const toolArgs = buildLiveToolArgs(input.tool as MvpToolName, input.args, injected);
  const startedAt = Date.now();
  const result = await dispatch({ tool: input.tool, args: toolArgs, idempotencyKey: input.idempotencyKey });
  const durationMs = Date.now() - startedAt;

  // metering: metadata เท่านั้น — ไม่มีข้อความผู้ใช้/transcript/args ดิบ
  await safely(() => logSystemEvent({
    level: "info",
    source: "ai.assistant",
    action: "liveTool",
    message: "relay คำสั่งเสียงสด",
    organizationId: ctx.organizationId,
    storeId: ctx.storeId,
    actorUserId: ctx.userId,
    context: {
      reason: result.ok ? "relayed" : "denied",
      stage: "relay",
      sessionId: input.sessionId,
      callId: input.callId,
      tool: input.tool,
      outcome: result.ok ? "success" : result.code,
      durationMs,
      toolCallsUsed: budget.used,
    },
  }));

  // ตอบ 200 เสมอเมื่อถึง dispatcher แล้ว — ผลของ tool (สำเร็จหรือ code) ต้องถึง model
  // เพื่อให้ผู้ใช้ได้ยินคำอธิบายที่ตรงจริง; non-200 สงวนไว้ให้ gate ที่ไม่มีผล tool
  return NextResponse.json({
    ok: true,
    callId: input.callId,
    tool: input.tool,
    outcome: result,
    toolCallsUsed: budget.used,
    toolCallsCap: session.maxToolCalls,
  }, { headers: NO_STORE });
}
