// AI Live — POST /api/ai-assistant/live/transcript (บันทึกบทสนทนาไว้วิเคราะห์)
//
// browser ส่งข้อความถอดเสียงจาก provider (คำที่พนักงานพูด + คำที่ผู้ช่วยพูด) มาเป็นชุดเล็ก ๆ
// server เก็บลง ai_live_conversation_turns เฉพาะเมื่อ AI_ASSISTANT_LIVE_TRANSCRIPTS_ENABLED=true
//
// ด่าน: auth → pos.use → แพ็กเกจ → pilot → kill switch (resolveLiveAccess เดียวกับ tool route)
//       → rate limit → body (Zod, จำกัดขนาด) → session token (HMAC) + identity ตรงผู้เรียก → บันทึก
// identity ทุกตัวมาจาก token ที่ server เซ็นไว้ — browser ปลอม org/store/user ไม่ได้
// ข้อความไม่ถูกเขียนลง system_event_logs เด็ดขาด (log นั้นเปิดให้ผู้ดูแลทุกคนเห็น)

import { NextResponse } from "next/server";
import { z } from "zod";
import { resolveLiveTokenSecret, verifyLiveSessionToken } from "@/modules/ai-assistant/live-session";
import { liveComposition, resolveLiveAccess, LIVE_ACCESS_NOTES } from "@/modules/ai-assistant/live-server";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;
const SESSION_ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;
const ITEM_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

const BodySchema = z.object({
  sessionId: z.string().regex(SESSION_ID_PATTERN),
  sessionToken: z.string().min(8).max(2048),
  turns: z.array(z.object({
    role: z.enum(["user", "assistant"]),
    text: z.string().min(1).max(4000),
    itemId: z.string().regex(ITEM_ID_PATTERN).optional(),
    seq: z.number().int().min(0).max(100_000).optional(),
  }).strict()).min(1).max(20),
}).strict();

function fail(reason: string, status: number, manualPath?: string) {
  return NextResponse.json({ ok: false, reason, manualPath }, { status, headers: NO_STORE });
}

export async function POST(request: Request) {
  const access = await resolveLiveAccess();
  if (!access.ok) return fail(access.reason, access.status, LIVE_ACCESS_NOTES[access.reason]);
  const { ctx, config } = access;
  if (!config.liveTranscriptsEnabled) {
    // ปิดเก็บอยู่ = ตอบสำเร็จแต่ไม่เก็บ (เครื่องที่เปิดเซสชันไว้ก่อนผู้ดูแลปิด flag จะเลิกส่งเอง)
    return NextResponse.json({ ok: true, stored: 0, enabled: false }, { headers: NO_STORE });
  }

  const limit = liveComposition.telemetryRateLimiter.check(`transcript|${ctx.organizationId}|${ctx.storeId}|${ctx.userId}`);
  if (!limit.allowed) return fail("rate_limited", 429);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail("invalid_body", 400);
  }
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) return fail("invalid_body", 400);
  const input = parsed.data;

  const secret = resolveLiveTokenSecret(process.env);
  if (!secret) return fail("live_unconfigured", 503);
  const claims = verifyLiveSessionToken(input.sessionToken, secret);
  if (!claims || claims.sessionId !== input.sessionId
    || claims.organizationId !== ctx.organizationId || claims.storeId !== ctx.storeId || claims.userId !== ctx.userId) {
    return fail("live_session_invalid", 403);
  }

  const stored = await liveComposition.recordTranscript(
    { organizationId: claims.organizationId, storeId: claims.storeId, userId: claims.userId, sessionId: claims.sessionId },
    input.turns.map((turn) => ({
      role: turn.role,
      content: turn.text,
      clientSeq: turn.seq ?? null,
      providerItemId: turn.itemId ?? null,
    })),
  );
  return NextResponse.json({ ok: true, stored, enabled: true }, { headers: NO_STORE });
}
