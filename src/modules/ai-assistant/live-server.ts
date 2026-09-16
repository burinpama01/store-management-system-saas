// PR3-Live (M3/M4) — composition ร่วมของ routes ภายใต้ /api/ai-assistant/live
//
// เหตุผลที่ต้องแยกไฟล์ (ไม่ซ้ำใน route เดิม): POST /live/session สร้างเซสชัน และ POST /live/tool
// ต้อง "เห็น live session store ก้อนเดียวกัน" บน instance เดียวกัน — module-level singleton
// ต่อ process (รูปแบบเดียวกับ composition ใน text-command route)
//
// ข้อจำกัด MVP (บันทึกใน checkpoint): store ทั้งหมดอยู่ในหน่วยความจำของ instance เดียว
// ถ้า provider สลับไป instance อื่นกลางเซสชัน browser จะโดน 403 live_session_invalid แบบ
// fail-closed (UI ให้กดปุ่มใหม่) — ทางแก้ถาวรคือตาราง live session บน supabase (residual)

import { ToolRegistry } from "./foundation";
import { canUseFeature } from "@/modules/billing/types";
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

function readLiveSessionRateLimitPerMinute(): number {
  const raw = Number(process.env.AI_ASSISTANT_LIVE_SESSION_RATE_LIMIT_PER_MINUTE);
  return Number.isSafeInteger(raw) && raw >= 1 ? Math.round(raw) : 10;
}

/** โทนสูงกว่าข้อความ (20/นาที) เพราะบทสนทนาเสียงเรียก tool ได้ต่อเนื่อง — ปรับด้วย env เดิมรูปแบบ */
function readLiveToolRateLimitPerMinute(): number {
  const raw = Number(process.env.AI_ASSISTANT_LIVE_TOOL_RATE_LIMIT_PER_MINUTE);
  return Number.isSafeInteger(raw) && raw >= 1 ? Math.round(raw) : 60;
}

const config = readAssistantConfig(process.env);

const registry = new ToolRegistry(config.environment);
registerPosTools(registry, createServerPosToolDeps());

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

export const liveComposition = {
  registry,
  liveSessions,
  sessionRateLimiter,
  toolRateLimiter,
  getLiveDispatch,
} as const;

// ── ด่านร่วมของทั้งสอง route (M3/M4) — ลำดับตายตัวตาม plan v2 §11 ────────────
// auth → pos.use → entitlement aiAssistant → pilot org → kill switch (liveEnabled)
// ต่างจากข้อความตรงที่ "pilot มาก่อน kill switch" ตาม spec M3: คนนอก pilot ต้องเจอ
// 403 live_pilot_only เสมอ ไม่ว่าระบบจะเปิดหรือปิด (กันเดาสาเหตุจาก env ข้างนอก)

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
      readonly reason: "unauthorized" | "forbidden" | "ai_not_in_plan" | "live_pilot_only" | "live_disabled";
    };

export async function resolveLiveAccess(): Promise<LiveAccessResult> {
  const authz = await getResolvedCurrentPermissions();
  if (!authz) return { ok: false, status: 401, reason: "unauthorized" };
  const { ctx, user, resolved } = authz;
  if (!resolved.can("pos.use")) return { ok: false, status: 403, reason: "forbidden" };

  const billingState = (await getOrganizationBillingState(ctx.organizationId)) ?? undefined;
  if (billingState && !canUseFeature(billingState, "aiAssistant")) {
    return { ok: false, status: 403, reason: "ai_not_in_plan" };
  }

  const config = readAssistantConfig(process.env);
  if (!config.livePilotOrgIds.includes(ctx.organizationId.toLowerCase())) {
    return { ok: false, status: 403, reason: "live_pilot_only" };
  }
  if (!config.liveEnabled) return { ok: false, status: 503, reason: "live_disabled" };
  return {
    ok: true,
    ctx: { organizationId: ctx.organizationId, storeId: ctx.storeId, userId: user.id },
    config,
  };
}
