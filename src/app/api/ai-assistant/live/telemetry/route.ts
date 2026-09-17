// PR3-Live (diagnostics) — POST /api/ai-assistant/live/telemetry
//
// รับ event วินิจฉัยจากเบราว์เซอร์ (คำปลุก/ไมค์/WebRTC/เสียง/ตะกร้า) แล้วเขียนลง system_event_logs
// เพื่อให้ไล่ timeline หน้าร้านได้ว่า "พูดแล้ว AI ไม่ตอบ" พังตรงไหน
//
// ด่าน: auth → flag วินิจฉัยของร้าน → rate limit → ขนาด body → Zod (ชื่อ event เป็น allowlist ปิด)
//       → ตรวจฟิลด์ต้องห้าม (ปฏิเสธทั้งก้อน ไม่ strip เงียบ) → log
//
// สิ่งที่ห้ามหลุดเข้ามา (บังคับด้วย schema + ตัวตรวจคีย์): transcript, เสียง, args ดิบ,
// token/secret ทุกชนิด — และ **identity จาก browser ถูกเมินเสมอ** (org/store/user มาจาก session)

import { NextResponse } from "next/server";
import { z } from "zod";
import { logSystemEvent } from "@/modules/system/event-log";
import { liveComposition, resolveLiveIdentity, LIVE_ACCESS_NOTES } from "@/modules/ai-assistant/live-server";
import { readAssistantConfig } from "@/modules/ai-assistant/config";
import {
  LIVE_TELEMETRY_EVENTS,
  LIVE_TELEMETRY_LIMITS,
  LIVE_TELEMETRY_RESULTS,
  LIVE_TELEMETRY_STAGES,
  isForbiddenTelemetryKey,
} from "@/modules/ai-assistant/live-telemetry-events";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;
const SESSION_ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;
const CALL_ID_PATTERN = /^[A-Za-z0-9_-]{6,128}$/;

function fail(reason: string, status: number, manualPath?: string, headers: Record<string, string> = {}) {
  return NextResponse.json({ ok: false, reason, manualPath }, { status, headers: { ...NO_STORE, ...headers } });
}

/** log ล้มเหลวต้องไม่เปลี่ยนผลลัพธ์ของ request (pattern เดียวกับ route อื่นของ ai-assistant) */
async function safely(action: () => Promise<unknown>): Promise<void> {
  try {
    await action();
  } catch {
    // telemetry เป็น observability — ล้มเหลวแล้วต้องเงียบ
  }
}

const MetadataValueSchema = z.union([
  z.string().max(LIVE_TELEMETRY_LIMITS.maxMetadataValueLength),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);

const EventSchema = z.object({
  event: z.enum(LIVE_TELEMETRY_EVENTS),
  stage: z.enum(LIVE_TELEMETRY_STAGES),
  result: z.enum(LIVE_TELEMETRY_RESULTS),
  sessionId: z.string().regex(SESSION_ID_PATTERN).optional(),
  callId: z.string().regex(CALL_ID_PATTERN).optional(),
  reason: z.string().min(1).max(LIVE_TELEMETRY_LIMITS.maxReasonLength).optional(),
  durationMs: z.number().int().min(0).max(24 * 60 * 60 * 1000).optional(),
  cartVersion: z.number().int().min(0).max(1_000_000).optional(),
  metadata: z.record(
    z.string().min(1).max(LIVE_TELEMETRY_LIMITS.maxMetadataKeyLength),
    MetadataValueSchema,
  ).optional(),
}).strict();

const BodySchema = z.object({
  events: z.array(EventSchema).min(1).max(LIVE_TELEMETRY_LIMITS.maxEventsPerRequest),
}).strict();

/**
 * ตรวจฟิลด์ต้องห้ามทั้ง event และ metadata
 *
 * เลือก "ปฏิเสธ" แทน "strip" ตามแผน: คนเขียนโค้ดต้องรู้ทันทีตอน dev ว่าเผลอส่งของที่ห้ามเก็บ
 * (strip เงียบ ๆ จะทำให้ของหลุดเข้ามาเรื่อย ๆ โดยไม่มีใครรู้จนกว่าจะมีคนไปอ่าน log)
 */
function findForbiddenKey(events: readonly z.infer<typeof EventSchema>[]): string | null {
  for (const event of events) {
    for (const key of Object.keys(event)) {
      if (key !== "metadata" && isForbiddenTelemetryKey(key)) return key;
    }
    for (const key of Object.keys(event.metadata ?? {})) {
      if (isForbiddenTelemetryKey(key)) return key;
    }
    if (event.metadata && Object.keys(event.metadata).length > LIVE_TELEMETRY_LIMITS.maxMetadataKeys) {
      return "metadata";
    }
  }
  return null;
}

export async function POST(request: Request) {
  // identity มาจาก session ฝั่ง server เท่านั้น — ค่าที่ browser ส่งมาไม่มีผลใด ๆ (schema ก็ไม่รับอยู่แล้ว)
  const identity = await resolveLiveIdentity();
  if (!identity.ok) return fail(identity.reason, identity.status, LIVE_ACCESS_NOTES[identity.reason]);
  const { ctx } = identity;

  // โหมดวินิจฉัยเปิดเฉพาะร้านที่ต้องการ (pilot) — ร้านอื่นไม่ต้องมี event ละเอียดขึ้น server
  const config = readAssistantConfig(process.env);
  if (!config.liveDiagnosticsEnabled) {
    return fail("diagnostics_disabled", 503, "โหมดวินิจฉัยปิดอยู่");
  }

  const limit = liveComposition.telemetryRateLimiter.check(`${ctx.organizationId}|${ctx.storeId}|${ctx.userId}`);
  if (!limit.allowed) {
    return fail("rate_limited", 429, "ส่งข้อมูลวินิจฉัยถี่เกินไป", {
      "Retry-After": String(Math.ceil(limit.retryAfterMs / 1000)),
    });
  }

  // อ่านเป็นข้อความก่อนเพื่อคุมขนาดจริง (JSON.parse ของก้อนใหญ่ = เสียแรงเปล่า)
  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return fail("invalid_body", 400);
  }
  if (raw.length > LIVE_TELEMETRY_LIMITS.maxBodyBytes) return fail("payload_too_large", 400);

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return fail("invalid_body", 400);
  }
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) return fail("invalid_body", 400);

  const forbidden = findForbiddenKey(parsed.data.events);
  if (forbidden) return fail("forbidden_field", 400, "ห้ามส่งข้อมูลที่เป็นความลับ/ข้อความผู้ใช้ในข้อมูลวินิจฉัย");

  for (const event of parsed.data.events) {
    await safely(() => logSystemEvent({
      level: event.result === "failed" || event.result === "blocked" ? "warn" : "info",
      source: "ai.assistant",
      action: "liveDiag",
      message: `เสียงสด: ${event.event}`,
      organizationId: ctx.organizationId,
      storeId: ctx.storeId,
      actorUserId: ctx.userId,
      context: {
        event: event.event,
        stage: event.stage,
        result: event.result,
        ...(event.reason ? { reason: event.reason } : {}),
        ...(event.sessionId ? { sessionId: event.sessionId } : {}),
        ...(event.callId ? { callId: event.callId } : {}),
        ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
        ...(event.cartVersion !== undefined ? { cartVersion: event.cartVersion } : {}),
        ...(event.metadata ?? {}),
      },
    }));
  }

  return NextResponse.json({ ok: true, accepted: parsed.data.events.length }, { headers: NO_STORE });
}
