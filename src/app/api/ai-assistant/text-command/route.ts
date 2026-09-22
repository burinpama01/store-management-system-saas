// PR2 — POST /api/ai-assistant/text-command
//
// ด่านเดียวที่ข้อความจาก POS ไปถึง tool ได้ ลำดับตายตัว:
//   auth → permission pos.use → package gate (aiAssistant) → rate limit (route layer) →
//   kill switch → validate body →
//     โหมดข้อความ: deterministic parser → AI ทางสำรอง (quota reserve/settle) → orchestrator →
//                 dispatcher ของ PR1 (permission/entitlement/risk/idempotency/audit ครบ) → ตอบเฉพาะ result/codes
//     โหมด read-tool: client เรียก tool อ่านที่ allowlist ไว้เท่านั้น ผ่าน dispatcher เดิม
//
// สิ่งที่ห้ามหลุดออกจากไฟล์นี้: ข้อความของผู้ใช้ (ไม่ echo, ไม่ log, ไม่ลง system_event_logs)
// log ได้เฉพาะรหัสผล (reason code) เท่านั้น

import { NextResponse } from "next/server";
import { z } from "zod";
import { createHash } from "node:crypto";
import { getResolvedCurrentPermissions } from "@/modules/auth/guards";
import { getOrganizationBillingState } from "@/modules/billing/billing-service";
import { canUseFeature, DEFAULT_BILLING_STATE } from "@/modules/billing/types";
import { AI_DEFAULT_MODEL, isAiEnabled } from "@/modules/ai/gateway";
import { AI_MAX_OUTPUT_TOKENS, reserveQuota, settleUsage } from "@/modules/ai/quota";
import { logSystemEvent } from "@/modules/system/event-log";
import { VOICE_INTENT_MAX_UTTERANCE } from "@/modules/ai/voice-intent";
import { readAssistantConfig } from "@/modules/ai-assistant/config";
import { ToolRegistry } from "@/modules/ai-assistant/foundation";
import { createServerAssistantDispatcher } from "@/modules/ai-assistant/server";
import { DurableIdempotencyStore } from "@/modules/ai-assistant/durable-idempotency";
import { createSupabaseServiceClient } from "@/server/integrations/supabase/server";
import { DurableAssistantSessionStore } from "@/modules/ai-assistant/durable-session";
import { createFixedWindowRateLimiter } from "@/modules/ai-assistant/rate-limit";
import { createTextInterpreter, runTextCommand, type TextFailureReason } from "@/modules/ai-assistant/orchestrator";
import { interpretTextIntent } from "@/modules/ai-assistant/text-intent";
import type { AiVoiceIntentEnvelope } from "@/modules/voice-pos/ai-intent-schema";
import { MVP_TOOL_NAMES, registerPosTools } from "@/modules/ai-assistant/tools/pos-tools";
import { createServerPosToolDeps } from "@/modules/ai-assistant/tools/pos-tools-server";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;
const QUOTA_FEATURE = "aiAssistantText";

/** tool อ่านที่ client เรียกตรงได้ — นอกจากนี้ต้องเดินผ่านโหมดข้อความ (ห้าม generic execute) */
const DIRECT_READ_TOOLS = ["pos.search_product", "catalog.search", "pos.get_current_order"] as const;

function readRateLimitPerMinute(): number {
  const raw = Number(process.env.AI_ASSISTANT_TEXT_RATE_LIMIT_PER_MINUTE);
  return Number.isSafeInteger(raw) && raw >= 1 ? Math.round(raw) : 20;
}

// composition ครั้งเดียวต่อ process — idempotency ledger / session store / rate limiter
// ต้องมีชีวิตยาวกว่า 1 request เพื่อให้ replay ข้าม request ยังเดดูพลิเคตได้
const registry = new ToolRegistry(readAssistantConfig(process.env).environment);
registerPosTools(registry, createServerPosToolDeps());
const rateLimiter = createFixedWindowRateLimiter({
  limitPerWindow: readRateLimitPerMinute(),
  windowMs: 60_000,
});

// PR3 — composition root ปลด mutation ขั้นที่ (2): wire durable idempotency ผ่าน service client
// เดิมของ repo (RLS เลี่ยง — pattern เดียวกับ connect/pending / notifications cron) เข้า dispatcher
// durability "supabase" ทำให้เกต DURABLE_STORAGE_REQUIRED ผ่านได้ แต่การเขียนยังต้องผ่าน env
// AI_ASSISTANT_MUTATIONS_ENABLED=true อีกชั้น — wiring อย่างเดียวจึงยังไม่ปลด mutation
// (การ sweep ของแถวค้างทำงานเองตาม design ของ store: opportunistic ตอน claim ทุก 60 วิ/instance
// และล้มเหลวเงียบไม่กระทบ request — atomicity ของ claim มาจาก unique constraint เสมอ)
// client สร้างไม่ได้ (env supabase หาย) = throw ตาม convention ของ route อื่นที่ใช้ service client
type TextCommandDispatcher = ReturnType<typeof createServerAssistantDispatcher>;
let dispatchPromise: Promise<TextCommandDispatcher> | null = null;
function getDispatch(): Promise<TextCommandDispatcher> {
  dispatchPromise ??= createSupabaseServiceClient()
    .then((client) => {
      // P0 — session/terminal registry แบบ durable: อยู่รอดข้าม instance และแยกต่อเครื่อง
      // (ของเดิมอยู่ในหน่วยความจำ process เดียว + หนึ่ง user หนึ่ง session ⇒ เปิดสองแท็บ
      // แท็บที่สองผูกตะกร้าไม่ได้ และ replay ข้าม instance โดน IDEMPOTENCY_CONFLICT)
      const sessions = new DurableAssistantSessionStore(client, { allowedTools: [...MVP_TOOL_NAMES] });
      return createServerAssistantDispatcher({
        registry,
        resolveSession: (identity) => sessions.resolve(identity),
        resolveCartBinding: async (context, args) => {
          const parsed = args as { activeCartId?: unknown; cartVersion?: unknown } | null;
          if (!parsed || typeof parsed.activeCartId !== "string" || typeof parsed.cartVersion !== "number") return null;
          return sessions.bindCart(context, parsed.activeCartId, parsed.cartVersion);
        },
        idempotencyStore: new DurableIdempotencyStore(client),
      });
    })
    // สร้างไม่สำเร็จ = คืนโอกาสให้ request ถัดไปลองใหม่ (ไม่ memoize rejection ตลอดอายุ process)
    .catch((error: unknown) => {
      dispatchPromise = null;
      throw error;
    });
  return dispatchPromise;
}

const BodySchema = z.object({
  requestId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  text: z.string().min(1).max(VOICE_INTENT_MAX_UTTERANCE).optional(),
  tool: z.enum(DIRECT_READ_TOOLS).optional(),
  args: z.unknown().optional(),
  activeCartId: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/).optional(),
  cartVersion: z.number().int().min(0).optional(),
}).strict().refine((body) => (body.text ? 1 : 0) + (body.tool ? 1 : 0) === 1, { message: "ต้องส่ง text หรือ tool อย่างใดอย่างหนึ่ง" });

function fail(reason: string, status: number, manualPath?: string, headers: Record<string, string> = {}) {
  return NextResponse.json({ ok: false, reason, manualPath }, { status, headers: { ...NO_STORE, ...headers } });
}

const FAILURE_NOTES: Record<string, string> = {
  forbidden: "คำสั่งเรื่องการชำระเงิน/ส่วนลด/สิทธิ์ห้ามใช้ผ่านผู้ช่วย — ใช้หน้าจอแทน",
  empty: "ยังไม่ได้พิมพ์คำสั่ง",
  ai_disabled: "ระบบ AI ยังไม่เปิด — พิมพ์คำสั่งสั้น ๆ เช่น “เพิ่มลาเต้ 2 แก้ว” ได้เลย",
  quota_denied: "โควตา AI หมด — ใช้คำสั่งสั้น ๆ ตามตัวอย่างได้ หรือเติมโควตาที่หน้าตั้งค่า",
  ai_timeout: "แปลคำสั่งไม่ทัน — ลองพิมพ์ใหม่อีกครั้ง",
  ai_error: "เชื่อมต่อ AI มีปัญหา — ลองใหม่อีกครั้ง หรือใช้หน้าจอแทน",
  ai_invalid_output: "แปลคำสั่งไม่สำเร็จ — ลองพิมพ์ใหม่แบบสั้น ๆ",
};

/** จ่ายโควตา/บันทึก event พัง = ไม่เปลี่ยนผลลัพธ์ของ request (M4 review — กัน 500 ที่ไม่มี reason) */
async function safely(action: () => Promise<unknown>): Promise<void> {
  try {
    await action();
  } catch {
    // infra outage — ผู้เรียกตอบ typed reason แทน
  }
}

/** เรียก provider ผ่าน quota เดิมของระบบ (reserve ก่อนเรียก, settle หลังรู้ผล) — เหมือนเส้นทางเสียง */
async function callTextProvider(input: {
  readonly text: string;
  readonly organizationId: string;
  readonly storeId: string;
  readonly userId: string;
  readonly requestId: string;
}): Promise<{ ok: true; envelope: AiVoiceIntentEnvelope } | { ok: false; reason: TextFailureReason }> {
  const requestHash = createHash("sha256").update(input.requestId).digest("hex").slice(0, 16);
  const settleBase = {
    organizationId: input.organizationId,
    requestId: input.requestId,
    feature: QUOTA_FEATURE,
    model: AI_DEFAULT_MODEL,
    storeId: input.storeId,
    userId: input.userId,
    requestHash,
  } as const;
  try {
    const reserve = await reserveQuota({
      organizationId: input.organizationId,
      requestId: input.requestId,
      feature: QUOTA_FEATURE,
      maxTokens: AI_MAX_OUTPUT_TOKENS,
    });
    if (!reserve.granted) return { ok: false, reason: "quota_denied" };
  } catch {
    // ระบบโควตาล่ม — ตอบ typed failure ไม่ปล่อยเป็น 500 (log เฉพาะ reason กันช่องว่าง troubleshooting)
    await safely(() => logSystemEvent({
      level: "warn",
      source: "ai.assistant",
      action: "textCommand",
      message: "ระบบโควตา AI มีปัญหา (ai_error)",
      organizationId: input.organizationId,
      storeId: input.storeId,
      actorUserId: input.userId,
      context: { reason: "ai_error", mode: "text", stage: "quota_reserve" },
    }));
    return { ok: false, reason: "ai_error" };
  }
  let result: Awaited<ReturnType<typeof interpretTextIntent>>;
  try {
    result = await interpretTextIntent({ text: input.text, locale: "th-TH", approvedModelId: AI_DEFAULT_MODEL });
  } catch {
    await safely(() => settleUsage({ ...settleBase, tokens: 0, status: "error" }));
    await safely(() => logSystemEvent({
      level: "warn",
      source: "ai.assistant",
      action: "textCommand",
      message: "แปลคำสั่งข้อความด้วย AI ไม่สำเร็จ (ai_error)",
      organizationId: input.organizationId,
      storeId: input.storeId,
      actorUserId: input.userId,
      context: { reason: "ai_error", mode: "text" },
    }));
    return { ok: false, reason: "ai_error" };
  }
  if (!result.ok) {
    // timeout คง reservation ไว้ให้ reconcile ตาม convention ของ quota module
    if (result.reason !== "ai_timeout") {
      await safely(() => settleUsage({ ...settleBase, tokens: 0, status: result.reason === "ai_disabled" ? "denied" : "error" }));
    }
    await safely(() => logSystemEvent({
      level: "warn",
      source: "ai.assistant",
      action: "textCommand",
      message: `แปลคำสั่งข้อความด้วย AI ไม่สำเร็จ (${result.reason})`,
      organizationId: input.organizationId,
      storeId: input.storeId,
      actorUserId: input.userId,
      context: { reason: result.reason, mode: "text" },
    }));
    return result;
  }
  await safely(() => settleUsage({ ...settleBase, tokens: result.tokens, status: "ok" }));
  return { ok: true, envelope: result.envelope };
}

export async function POST(request: Request) {
  const authz = await getResolvedCurrentPermissions();
  if (!authz) return fail("unauthorized", 401);
  const { ctx, user, resolved } = authz;
  if (!resolved.can("pos.use")) return fail("forbidden", 403, "ต้องมีสิทธิ์ใช้ POS จึงใช้ผู้ช่วยได้");

  // อ่านแพ็กเกจไม่ได้/ยังไม่มีแถว subscription = ถือเป็นแพ็กฟรี (fail closed) ไม่ใช่ข้ามด่าน
  const billingState = (await getOrganizationBillingState(ctx.organizationId)) ?? DEFAULT_BILLING_STATE;
  if (!canUseFeature(billingState, "aiAssistant")) {
    return fail("ai_not_in_plan", 403, "แพ็กเกจนี้ยังไม่รวมผู้ช่วย AI — ใช้หน้าจอได้ตามปกติ");
  }

  // rate limit ระดับ route ก่อนแตะ provider/dispatcher (residual risk ของ PR1 — session ใหม่เติม backstop ได้)
  const identityKey = `${ctx.organizationId}|${ctx.storeId}|${user.id}`;
  const limit = rateLimiter.check(identityKey);
  if (!limit.allowed) {
    await logSystemEvent({
      level: "warn",
      source: "ai.assistant",
      action: "textCommand",
      message: "คำสั่งข้อความเกินอัตราที่กำหนด",
      organizationId: ctx.organizationId,
      storeId: ctx.storeId,
      actorUserId: user.id,
      context: { reason: "rate_limited" },
    });
    return fail("rate_limited", 429, "ส่งคำสั่งถี่เกินไป — รอแป๊บเดียวแล้วลองใหม่", { "Retry-After": String(Math.ceil(limit.retryAfterMs / 1000)) });
  }

  if (!readAssistantConfig(process.env).enabled) {
    return fail("assistant_disabled", 503, "ผู้ช่วย AI ยังปิดใช้งาน");
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

  // dispatcher (รวม durable idempotency store) สร้าง lazy แบบ memoize ครั้งเดียวต่อ process —
  // สร้างไม่ได้ (env supabase ผิดพลาด) = ตอบ typed 503 ไม่ปล่อย 500 ที่ไม่มี reason (review fix)
  let dispatch: Awaited<ReturnType<typeof getDispatch>>;
  try {
    dispatch = await getDispatch();
  } catch {
    return fail("assistant_unavailable", 503, "ผู้ช่วยยังใช้ไม่ได้ชั่วคราว — ลองใหม่อีกครั้ง");
  }

  // ── โหมด read-tool: เรียก tool อ่านตรง (search / current order) ผ่าน dispatcher เดิมทุกด่าน ──
  if (input.tool) {
    const result = await dispatch({ tool: input.tool, args: input.args ?? {}, idempotencyKey: input.requestId });
    const outcome = result.ok
      ? { kind: "tool" as const, ok: true, tool: input.tool, result: result.data }
      : { kind: "error" as const, ok: false, tool: input.tool, code: result.code };
    return NextResponse.json({ ok: true, requestId: input.requestId, outcomes: [outcome] }, { headers: NO_STORE });
  }

  // ── โหมดข้อความ ──
  const cart = input.activeCartId && input.cartVersion !== undefined
    ? { activeCartId: input.activeCartId, cartVersion: input.cartVersion }
    : null;
  const interpret = createTextInterpreter({
    aiEnabled: () => isAiEnabled(),
    callProvider: (text) => callTextProvider({
      text,
      organizationId: ctx.organizationId,
      storeId: ctx.storeId,
      userId: user.id,
      requestId: input.requestId,
    }),
  });
  const run = await runTextCommand(input.text!, { interpret, dispatch, cart, requestId: input.requestId });
  if (!run.ok) {
    // ความล้มเหลวระดับเนื้อหา (คำต้องห้าม/AI ล่ม/โควตาหมด) = 200 พร้อมเหตุผล เพื่อให้ UI แนะนำทางออกได้
    return NextResponse.json({ ok: true, requestId: input.requestId, outcomes: [], failure: run.reason, note: FAILURE_NOTES[run.reason] ?? FAILURE_NOTES.ai_error }, { headers: NO_STORE });
  }
  return NextResponse.json({ ok: true, requestId: input.requestId, outcomes: run.outcomes, note: run.note }, { headers: NO_STORE });
}
