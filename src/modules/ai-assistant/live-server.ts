// PR3-Live (M3/M4) — composition ร่วมของ routes ภายใต้ /api/ai-assistant/live
//
// เหตุผลที่ต้องแยกไฟล์ (ไม่ซ้ำใน route เดิม): POST /live/session สร้างเซสชัน และ POST /live/tool
// ต้อง "เห็น live session store ก้อนเดียวกัน" บน instance เดียวกัน — module-level singleton
// ต่อ process (รูปแบบเดียวกับ composition ใน text-command route)
//
// ความถูกต้องของเซสชัน "ไม่" ขึ้นกับหน่วยความจำของ instance แล้ว (ดู live-session.ts):
// ตัวตนของเซสชันอยู่ใน session token ที่เซ็นด้วย HMAC — ที่เหลือในไฟล์นี้คือเพดานการใช้งาน
// (เซสชันพร้อมกันต่อร้าน / tool call ต่อเซสชัน / rate limit) ซึ่งเป็น best-effort ต่อ instance

import { ToolRegistry } from "./foundation";
import { canUseFeature, DEFAULT_BILLING_STATE } from "@/modules/billing/types";
import { getOrganizationBillingState } from "@/modules/billing/billing-service";
import { getResolvedCurrentPermissions } from "@/modules/auth/guards";
import { createAssistantSessionStore } from "./session";
import { createLiveSessionStore } from "./live-session";
import { readAssistantConfig } from "./config";
import { createServerAssistantDispatcher } from "./server";
import { DurableIdempotencyStore } from "./durable-idempotency";
import { createSupabaseServiceClient } from "@/server/integrations/supabase/server";
import { MVP_TOOL_NAMES, registerPosTools } from "./tools/pos-tools";
import { createServerPosToolDeps } from "./tools/pos-tools-server";
import { createFixedWindowRateLimiter } from "./rate-limit";
import type { SupabaseClient } from "@supabase/supabase-js";
import { recordLiveTranscriptTurns, type LiveTranscriptIdentity, type LiveTranscriptTurn } from "./live-transcripts";
import { logSystemEvent } from "@/modules/system/event-log";
import type {
  LiveTelemetryEventName,
  LiveTelemetryResult,
  LiveTelemetryStage,
} from "./live-telemetry-events";

function readLiveSessionRateLimitPerMinute(): number {
  const raw = Number(process.env.AI_ASSISTANT_LIVE_SESSION_RATE_LIMIT_PER_MINUTE);
  return Number.isSafeInteger(raw) && raw >= 1 ? Math.round(raw) : 10;
}

/** โทนสูงกว่าข้อความ (20/นาที) เพราะบทสนทนาเสียงเรียก tool ได้ต่อเนื่อง — ปรับด้วย env เดิมรูปแบบ */
function readLiveToolRateLimitPerMinute(): number {
  const raw = Number(process.env.AI_ASSISTANT_LIVE_TOOL_RATE_LIMIT_PER_MINUTE);
  return Number.isSafeInteger(raw) && raw >= 1 ? Math.round(raw) : 60;
}

/** จำนวนคำขอ telemetry ต่อนาทีต่อผู้ใช้ — ปรับได้ด้วย env รูปแบบเดียวกับช่องอื่น */
function readLiveTelemetryRateLimitPerMinute(): number {
  const raw = Number(process.env.AI_ASSISTANT_LIVE_TELEMETRY_RATE_LIMIT_PER_MINUTE);
  return Number.isSafeInteger(raw) && raw >= 1 ? Math.round(raw) : 120;
}

const config = readAssistantConfig(process.env);

const registry = new ToolRegistry(config.environment);
const posToolDeps = createServerPosToolDeps();
registerPosTools(registry, posToolDeps);

/** session ชั้น dispatcher (identity จาก auth cookie) — แยกจาก text route เพื่อไม่แตะโค้ดเดิม */
const assistantSessions = createAssistantSessionStore({ allowedTools: [...MVP_TOOL_NAMES] });

/** session ของช่องทาง Live — concurrent cap ต่อร้าน + tool call cap ต่อเซสชัน */
const liveSessions = createLiveSessionStore({
  maxConcurrentPerStore: config.liveMaxConcurrentSessionsPerStore,
  maxToolCallsPerSession: config.liveMaxToolCallsPerSession,
});

const sessionRateLimiter = createFixedWindowRateLimiter({
  limitPerWindow: readLiveSessionRateLimitPerMinute(),
  windowMs: 60_000,
});

/** rate limit ของ relay tool (แยกจากช่องสร้างเซสชัน) — กันโดนสปามกลางบทสนทนา */
const toolRateLimiter = createFixedWindowRateLimiter({
  limitPerWindow: readLiveToolRateLimitPerMinute(),
  windowMs: 60_000,
});

/**
 * rate limit ของ telemetry — สูงกว่าช่องอื่นเพราะ event วินิจฉัยมาถี่โดยธรรมชาติ
 * (browser ส่งเป็นชุดทุก 2 วินาที) แต่ยังมีเพดานกันแท็บที่พังยิงรัว
 */
const telemetryRateLimiter = createFixedWindowRateLimiter({
  limitPerWindow: readLiveTelemetryRateLimitPerMinute(),
  windowMs: 60_000,
});

type LiveDispatcher = ReturnType<typeof createServerAssistantDispatcher>;
let dispatchPromise: Promise<LiveDispatcher> | null = null;

/** dispatcher เดิมของระบบ (durable idempotency + audit + ทุกเกต) แบบ lazy memoize — รูปแบบเดียวกับ text route */
function getLiveDispatch(): Promise<LiveDispatcher> {
  dispatchPromise ??= createSupabaseServiceClient()
    .then((client) =>
      createServerAssistantDispatcher({
        registry,
        resolveSession: (identity) => assistantSessions.resolve(identity),
        resolveCartBinding: async (context, args) => {
          const parsed = args as { activeCartId?: unknown; cartVersion?: unknown } | null;
          if (!parsed || typeof parsed.activeCartId !== "string" || typeof parsed.cartVersion !== "number") return null;
          return assistantSessions.bindCart(context, parsed.activeCartId, parsed.cartVersion);
        },
        idempotencyStore: new DurableIdempotencyStore(client),
      }),
    )
    .catch((error: unknown) => {
      dispatchPromise = null;
      throw error;
    });
  return dispatchPromise;
}

let serviceClientPromise: ReturnType<typeof createSupabaseServiceClient> | null = null;

/**
 * บันทึกบทสนทนา (เปิดเฉพาะ AI_ASSISTANT_LIVE_TRANSCRIPTS_ENABLED) — ปิดอยู่ = ไม่แตะ DB เลย
 * ล้มเหลวต้องเงียบ: การบันทึกเพื่อวิเคราะห์ห้ามทำให้บทสนทนาหน้าร้านสะดุด
 */
async function recordTranscript(identity: LiveTranscriptIdentity, turns: readonly LiveTranscriptTurn[]): Promise<number> {
  const current = readAssistantConfig(process.env);
  if (!current.liveTranscriptsEnabled || turns.length === 0) return 0;
  try {
    serviceClientPromise ??= createSupabaseServiceClient();
    const client = await serviceClientPromise;
    return await recordLiveTranscriptTurns(client as unknown as SupabaseClient, identity, turns, {
      retentionDays: current.liveTranscriptRetentionDays,
    });
  } catch {
    serviceClientPromise = null;
    return 0;
  }
}

export const liveComposition = {
  registry,
  /** เมนูจริงของร้าน (ชุดเดียวกับที่ tool ใช้) — ใช้สรุปเมนูให้ model ตอนเปิดเซสชัน */
  loadCatalog: (storeId: string) => posToolDeps.loadCatalog(storeId),
  recordTranscript,
  liveSessions,
  sessionRateLimiter,
  toolRateLimiter,
  telemetryRateLimiter,
  getLiveDispatch,
} as const;

// ── ด่านร่วมของทั้งสอง route (M3/M4) — ลำดับตายตัวตาม plan v2 §11 ────────────
// auth → pos.use → entitlement aiAssistant → pilot org → kill switch (liveEnabled)
// ต่างจากข้อความตรงที่ "pilot มาก่อน kill switch" ตาม spec M3: คนนอก pilot ต้องเจอ
// 403 live_pilot_only เสมอ ไม่ว่าระบบจะเปิดหรือปิด (กันเดาสาเหตุจาก env ข้างนอก)

/**
 * เขียน event วินิจฉัยฝั่ง server ด้วยคำศัพท์ชุดเดียวกับฝั่ง browser
 *
 * ต่างจาก log เดิม (liveSession/liveTool) ตรงที่ชื่อ event เป็น taxonomy กลาง — ทำให้
 * timeline ของทั้งเส้นทาง (คำปลุก → ไมค์ → เซสชัน → provider → WebRTC → tool → ตะกร้า)
 * อ่านต่อกันได้ใน /system/logs โดยกรองจาก action เดียว
 *
 * ล้มเหลวต้องเงียบเสมอ: telemetry ห้ามเปลี่ยนผลลัพธ์ของ request (observability เท่านั้น)
 */
export async function logLiveEvent(input: {
  readonly event: LiveTelemetryEventName;
  readonly stage: LiveTelemetryStage;
  readonly result: LiveTelemetryResult;
  readonly ctx?: LiveAccessContext | null;
  readonly reason?: string;
  readonly sessionId?: string;
  readonly callId?: string;
  readonly durationMs?: number;
  readonly metadata?: Record<string, string | number | boolean | null>;
}): Promise<void> {
  try {
    await logSystemEvent({
      level: input.result === "failed" || input.result === "blocked" ? "warn" : "info",
      source: "ai.assistant",
      action: "liveDiag",
      message: `เสียงสด: ${input.event}`,
      organizationId: input.ctx?.organizationId,
      storeId: input.ctx?.storeId,
      actorUserId: input.ctx?.userId,
      context: {
        event: input.event,
        stage: input.stage,
        result: input.result,
        ...(input.reason ? { reason: input.reason } : {}),
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        ...(input.callId ? { callId: input.callId } : {}),
        ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
        ...(input.metadata ?? {}),
      },
    });
  } catch {
    // infra ล่ม — เส้นทางหลักตอบ typed reason ของตัวเองอยู่แล้ว
  }
}

export interface LiveAccessContext {
  readonly organizationId: string;
  readonly storeId: string;
  readonly userId: string;
}

export type LiveAccessResult =
  | { readonly ok: true; readonly ctx: LiveAccessContext; readonly config: ReturnType<typeof readAssistantConfig> }
  | {
      readonly ok: false;
      readonly status: 401 | 403 | 503;
      readonly reason: "unauthorized" | "forbidden" | "ai_not_in_plan" | "live_pilot_only" | "live_disabled" | "ai_disabled";
    };

/** ข้อความบอกทางออก (ภาษาไทย) ของด่านร่วม — route ทั้งสองใช้ชุดเดียวกัน ไม่โชว์ code ดิบ */
export const LIVE_ACCESS_NOTES: Record<Extract<LiveAccessResult, { ok: false }>["reason"], string> = {
  unauthorized: "กรุณาเข้าสู่ระบบใหม่",
  forbidden: "ต้องมีสิทธิ์ใช้ POS จึงเปิดโหมดเสียงสดได้",
  ai_not_in_plan: "แพ็กเกจนี้ยังไม่รวมผู้ช่วย AI — ใช้หน้าจอได้ตามปกติ",
  live_pilot_only: "โหมดเสียงสดเปิดให้เฉพาะร้านที่เข้าร่วมทดลอง — ใช้ปุ่มเสียงหรือหน้าจอได้ตามปกติ",
  live_disabled: "โหมดเสียงสดยังปิดใช้งาน",
  ai_disabled: "ผู้ช่วย AI ปิดใช้งานอยู่ — แจ้งผู้ดูแลระบบ",
};

/**
 * ตัวตนของผู้เรียก (auth อย่างเดียว) — ใช้กับ "การปิดเซสชัน" เท่านั้น
 *
 * เหตุผลที่แยกจาก resolveLiveAccess: การคืนทรัพยากรที่ถูกสร้างไปแล้วต้องทำได้เสมอ
 * ถ้าผูกการปิดไว้กับ kill switch / pilot / แพ็กเกจ แล้วผู้ดูแลปิด Live ระหว่างที่ร้าน
 * ยังคุยอยู่ เซสชันจะค้างกินสิทธิ์ของร้าน (live_store_busy) จน TTL หมดเองทั้งที่ไม่มีใครใช้
 * ความปลอดภัยของเส้นทางนี้มาจาก session token (HMAC) + ตรวจ org/store/user ให้ตรงกับเซสชัน
 */
export type LiveIdentityResult =
  | { readonly ok: true; readonly ctx: LiveAccessContext }
  | { readonly ok: false; readonly status: 401; readonly reason: "unauthorized" };

export async function resolveLiveIdentity(): Promise<LiveIdentityResult> {
  const authz = await getResolvedCurrentPermissions();
  if (!authz) return { ok: false, status: 401, reason: "unauthorized" };
  const { ctx, user } = authz;
  return { ok: true, ctx: { organizationId: ctx.organizationId, storeId: ctx.storeId, userId: user.id } };
}

export async function resolveLiveAccess(): Promise<LiveAccessResult> {
  const authz = await getResolvedCurrentPermissions();
  if (!authz) return { ok: false, status: 401, reason: "unauthorized" };
  const { ctx, user, resolved } = authz;
  if (!resolved.can("pos.use")) return { ok: false, status: 403, reason: "forbidden" };

  // อ่านแพ็กเกจไม่ได้/ยังไม่มีแถว subscription = ถือเป็นแพ็กฟรี (fail closed) ไม่ใช่ข้ามด่าน
  // รูปแบบเดียวกับ requireFeature ใน auth/guards.ts — ของเดิมข้ามด่านเมื่อค่าเป็น null
  const billingState = (await getOrganizationBillingState(ctx.organizationId)) ?? DEFAULT_BILLING_STATE;
  if (!canUseFeature(billingState, "aiAssistant")) {
    return { ok: false, status: 403, reason: "ai_not_in_plan" };
  }

  const config = readAssistantConfig(process.env);
  if (!config.livePilotOrgIds.includes(ctx.organizationId.toLowerCase())) {
    return { ok: false, status: 403, reason: "live_pilot_only" };
  }
  if (!config.liveEnabled) return { ok: false, status: 503, reason: "live_disabled" };
  // Live เป็น "ช่องทางหนึ่ง" ของผู้ช่วย AI ไม่ใช่ระบบแยก — tool ทุกตัวเดินผ่าน dispatcher เดิม
  // ซึ่งปฏิเสธด้วย FEATURE_DISABLED เมื่อ AI_ASSISTANT_ENABLED ไม่ใช่ "true"
  // ถ้าไม่ตรวจตรงนี้ ผู้ใช้จะเปิดไมค์/จ่ายค่าเซสชันกับ provider ได้ แล้วทุกคำสั่งพังทีหลัง
  if (!config.enabled) return { ok: false, status: 503, reason: "ai_disabled" };
  return {
    ok: true,
    ctx: { organizationId: ctx.organizationId, storeId: ctx.storeId, userId: user.id },
    config,
  };
}
