import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveLiveTokenSecret, verifyLiveSessionToken } from "@/modules/ai-assistant/live-session";

// PR3-Live (M3) — route gate test ของ POST/DELETE /api/ai-assistant/live/session
// ทุกเคส mock auth/billing/provider (global fetch) จึงไม่มี network และไม่แตะ Supabase

interface Identity {
  organizationId: string;
  storeId: string;
  userId: string;
}

const CART = "cart-12345678";

async function loadRoute(options: {
  authed?: boolean;
  canUsePos?: boolean;
  planHasAi?: boolean;
  /** AI_ASSISTANT_ENABLED — Live เป็นช่องทางหนึ่งของผู้ช่วย ไม่ใช่ระบบแยก */
  assistantEnabled?: boolean;
  /** null = อ่านแพ็กเกจไม่ได้/ไม่มีแถว subscription */
  billingState?: { plan: string; status: string } | null;
  liveEnabled?: boolean;
  pilotOrg?: string;
  openaiKey?: string;
  concurrentCap?: number;
  /** ลำดับ status ที่ provider (global fetch) จะตอบ — ตัวสุดท้ายถูกใช้ซ้ำ */
  providerStatuses?: number[];
} = {}) {
  const {
    authed = true,
    canUsePos = true,
    planHasAi = true,
    assistantEnabled = true,
    billingState = { plan: "enterprise", status: "active" } as { plan: string; status: string } | null,
    liveEnabled = true,
    pilotOrg = "org-1",
    openaiKey = "sk-test-abcdefgh123456",
    concurrentCap,
    providerStatuses = [200],
  } = options;

  vi.resetModules();
  const logSystemEvent = vi.fn().mockResolvedValue(undefined);
  const providerCalls: Array<{ url: string; init: RequestInit }> = [];
  // route เซสชันไม่ dispatch tool — ถ้ามีใครแตะ service client ถือว่าผิดดีไซน์
  const serviceClient = vi.fn(async () => {
    throw new Error("fake db: session route must not touch supabase");
  });

  let identity: Identity | null = { organizationId: "org-1", storeId: "store-1", userId: "user-1" };
  const setIdentity = (next: Identity | null) => { identity = next; };

  vi.doMock("@/modules/auth/guards", () => ({
    getResolvedCurrentPermissions: vi.fn(async () => {
      if (!authed || !identity) return null;
      return {
        ctx: { organizationId: identity.organizationId, storeId: identity.storeId, userId: identity.userId, role: "owner" },
        user: { id: identity.userId },
        resolved: { can: () => canUsePos, organizationId: identity.organizationId, storeId: identity.storeId },
      };
    }),
  }));
  vi.doMock("@/modules/billing/billing-service", () => ({
    getOrganizationBillingState: vi.fn().mockResolvedValue(billingState),
  }));
  vi.doMock("@/modules/billing/types", async () => {
    const actual = await vi.importActual<typeof import("@/modules/billing/types")>("@/modules/billing/types");
    // ผูกกับแพ็กจริงด้วย เพื่อให้เคส billing = null (ตกไป DEFAULT_BILLING_STATE = free) พิสูจน์ได้
    return { ...actual, canUseFeature: (state: { plan: string }) => planHasAi && state.plan !== "free" };
  });
  vi.doMock("@/modules/system/event-log", () => ({ logSystemEvent }));
  vi.doMock("@/modules/ai-assistant/tools/pos-tools-server", () => ({
    createServerPosToolDeps: () => ({ loadCatalog: vi.fn(async () => ({ products: [], aliases: [] })) }),
  }));
  vi.doMock("@/server/integrations/supabase/server", () => ({ createSupabaseServiceClient: serviceClient }));

  vi.stubEnv("AI_ASSISTANT_ENABLED", assistantEnabled ? "true" : "");
  vi.stubEnv("AI_ASSISTANT_LIVE_ENABLED", liveEnabled ? "true" : "");
  vi.stubEnv("AI_ASSISTANT_LIVE_PILOT_ORG_IDS", pilotOrg);
  vi.stubEnv("OPENAI_API_KEY", openaiKey);
  if (concurrentCap) vi.stubEnv("AI_ASSISTANT_LIVE_MAX_CONCURRENT_SESSIONS_PER_STORE", String(concurrentCap));

  let statusCursor = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => {
    providerCalls.push({ url: String(url), init: init as RequestInit });
    const status = providerStatuses[Math.min(statusCursor, providerStatuses.length - 1)];
    statusCursor += 1;
    if (status === 200) {
      return new Response(JSON.stringify({
        value: "ek_test_ephemeral_secret_value",
        expires_at: 1_900_000_000,
        session: { id: "sess_test_1", audio: { output: { voice: "alloy" } } },
      }), { status: 200 });
    }
    return new Response(`provider ${status}`, { status });
  }));

  const route = await import("@/app/api/ai-assistant/live/session/route");
  const liveServer = await import("@/modules/ai-assistant/live-server");
  return {
    route,
    liveSessions: liveServer.liveComposition.liveSessions,
    logSystemEvent,
    providerCalls,
    setIdentity,
  };
}

const post = (body: unknown) =>
  new Request("http://localhost/api/ai-assistant/live/session", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const del = (body: unknown) =>
  new Request("http://localhost/api/ai-assistant/live/session", {
    method: "DELETE",
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const createBody = { activeCartId: CART };

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("live session route — เมนูและบทสนทนา", () => {
  it("เปิดเก็บบทสนทนา = ถอดเสียงภาษาไทย และบอกเครื่องให้ส่งข้อความมา", async () => {
    const route = await loadRoute();
    vi.stubEnv("AI_ASSISTANT_LIVE_TRANSCRIPTS_ENABLED", "true");
    vi.stubEnv("AI_ASSISTANT_LIVE_SPEECH_SPEED", "0.75");
    const response = await route.route.POST(post(createBody));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.transcriptsEnabled).toBe(true);
    const providerBody = JSON.parse(String(route.providerCalls[0]?.init.body));
    expect(providerBody.session.audio).toMatchObject({
      input: { transcription: { model: "gpt-4o-mini-transcribe", language: "th" } },
      output: { speed: 0.75 },
    });
  });
});

describe("live session route — provider ไม่รับการตั้งค่าเสียง", () => {
  it("ถูกปฏิเสธรอบแรก = เปิดใหม่แบบไม่มี session.audio ร้านยังใช้ Live ได้ และมีร่องรอยใน log", async () => {
    const route = await loadRoute({ providerStatuses: [400, 200] });
    const response = await route.route.POST(post(createBody));
    expect(response.status).toBe(200);
    expect(route.providerCalls).toHaveLength(2);
    expect(JSON.parse(String(route.providerCalls[0]?.init.body)).session.audio).toBeDefined();
    expect(JSON.parse(String(route.providerCalls[1]?.init.body)).session.audio).toBeUndefined();
    expect(route.logSystemEvent).toHaveBeenCalledWith(expect.objectContaining({
      context: expect.objectContaining({ reason: "audio_config_rejected" }),
    }));
  });
});

describe("live session route — POST gates", () => {
  it("requires auth, pos.use, plan entitlement, pilot membership, and the live kill switch", async () => {
    const unauth = await loadRoute({ authed: false });
    expect((await unauth.route.POST(post(createBody))).status).toBe(401);

    const noPos = await loadRoute({ canUsePos: false });
    expect((await noPos.route.POST(post(createBody))).status).toBe(403);

    const noPlan = await loadRoute({ planHasAi: false });
    const noPlanResponse = await noPlan.route.POST(post(createBody));
    expect(noPlanResponse.status).toBe(403);
    expect(await noPlanResponse.json()).toMatchObject({ reason: "ai_not_in_plan" });

    // อ่านแพ็กเกจไม่ได้ = ปฏิเสธ (fail closed) ไม่ใช่ข้ามด่านแพ็กเกจไปเปิดเซสชัน
    const noBilling = await loadRoute({ billingState: null });
    const noBillingResponse = await noBilling.route.POST(post(createBody));
    expect(noBillingResponse.status).toBe(403);
    expect(await noBillingResponse.json()).toMatchObject({ reason: "ai_not_in_plan" });

    const outsidePilot = await loadRoute();
    outsidePilot.setIdentity({ organizationId: "org-other", storeId: "store-1", userId: "user-1" });
    const pilotResponse = await outsidePilot.route.POST(post(createBody));
    expect(pilotResponse.status).toBe(403);
    expect(await pilotResponse.json()).toMatchObject({ reason: "live_pilot_only" });

    const disabled = await loadRoute({ liveEnabled: false });
    const disabledResponse = await disabled.route.POST(post(createBody));
    expect(disabledResponse.status).toBe(503);
    expect(await disabledResponse.json()).toMatchObject({ reason: "live_disabled" });

    // ผู้ช่วยปิดทั้งระบบ = เปิด Live ไม่ได้ (tool ทุกตัวเดินผ่าน dispatcher เดียวกันซึ่งจะตอบ
    // FEATURE_DISABLED อยู่ดี — ต้องหยุดก่อนเปิดไมค์/จ่ายค่าเซสชันกับ provider)
    const aiOff = await loadRoute({ assistantEnabled: false });
    const aiOffResponse = await aiOff.route.POST(post(createBody));
    expect(aiOffResponse.status).toBe(503);
    expect(await aiOffResponse.json()).toMatchObject({ reason: "ai_disabled" });
  });

  it("rejects malformed bodies", async () => {
    const route = await loadRoute();
    expect((await route.route.POST(post("not-json"))).status).toBe(400);
    expect((await route.route.POST(post({}))).status).toBe(400);
    expect((await route.route.POST(post({ activeCartId: "short" }))).status).toBe(400);
    expect((await route.route.POST(post({ activeCartId: "cart; drop table" }))).status).toBe(400);
    expect((await route.route.POST(post({ ...createBody, extra: true }))).status).toBe(400);
    expect(route.liveSessions.size()).toBe(0);
  });

  it("fails closed when no token secret or provider key is configured", async () => {
    const route = await loadRoute({ openaiKey: "" });
    const response = await route.route.POST(post(createBody));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ reason: "live_unconfigured" });
    expect(route.providerCalls).toHaveLength(0);
  });

  it("rate limits session creation at the route layer", async () => {
    const route = await loadRoute({ concurrentCap: 50 });
    let lastStatus = 0;
    for (let i = 0; i < 11; i += 1) {
      const response = await route.route.POST(post(createBody));
      lastStatus = response.status;
      if (i < 10) expect(response.status).toBe(200);
    }
    expect(lastStatus).toBe(429);
    const body = await (await route.route.POST(post(createBody))).json();
    expect(body).toMatchObject({ reason: "rate_limited" });
    expect(route.logSystemEvent).toHaveBeenCalledWith(expect.objectContaining({ context: expect.objectContaining({ reason: "rate_limited" }) }));
  });

  it("ร้านครบจำนวน = เปิดใหม่ได้เลยโดยแทนที่เซสชันเก่า (token เก่าถูกเพิกถอน) และมีร่องรอยใน log", async () => {
    const route = await loadRoute({ concurrentCap: 1 });
    const first = await (await route.route.POST(post(createBody))).json();
    const second = await route.route.POST(post(createBody));
    expect(second.status).toBe(200);
    const body = await second.json();
    expect(body.sessionId).not.toBe(first.sessionId);
    expect(route.liveSessions.size()).toBe(1);
    expect(route.liveSessions.isRevoked(first.sessionId)).toBe(true);
    expect(route.logSystemEvent).toHaveBeenCalledWith(expect.objectContaining({
      context: expect.objectContaining({ reason: "replaced_oldest", replacedSessionId: first.sessionId, sameUser: true }),
    }));
  });

  it("returns live_provider_error and releases the slot when the provider fails", async () => {
    const route = await loadRoute({ providerStatuses: [500] });
    const response = await route.route.POST(post(createBody));
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ reason: "live_provider_error" });
    expect(route.liveSessions.size()).toBe(0);
    expect(route.logSystemEvent).toHaveBeenCalledWith(expect.objectContaining({ context: expect.objectContaining({ reason: "provider_error" }) }));

    const rejected = await loadRoute({ providerStatuses: [401] });
    const rejectedResponse = await rejected.route.POST(post(createBody));
    expect(rejectedResponse.status).toBe(502);
    expect(await rejectedResponse.json()).toMatchObject({ reason: "live_provider_error" });
    expect(rejected.liveSessions.size()).toBe(0);
  });
});

describe("live session route — POST success shape", () => {
  it("creates a server session, signs the token, and returns the ephemeral provider secret", async () => {
    const route = await loadRoute();
    const response = await route.route.POST(post(createBody));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.sessionId).toEqual(expect.any(String));
    expect(body.ephemeralToken).toBe("ek_test_ephemeral_secret_value");
    expect(body.openaiSessionId).toBe("sess_test_1");
    expect(body.model).toBe("gpt-realtime-2.1-mini");
    expect(body.allowedTools).toContain("pos.add_item");
    expect(body.caps).toMatchObject({ sessionMinutes: 15, toolCallsPerSession: 40, concurrentSessionsPerStore: 2 });
    expect(typeof body.expiresAt).toBe("number");

    const secret = resolveLiveTokenSecret(process.env);
    expect(secret).not.toBeNull();
    // token พก identity ของเซสชันครบ — relay บน instance อื่นจึงทำงานต่อได้โดยไม่ต้องมี state ร่วม
    expect(verifyLiveSessionToken(body.sessionToken, secret as string)).toMatchObject({
      sessionId: body.sessionId,
      organizationId: "org-1",
      storeId: "store-1",
      userId: "user-1",
      activeCartId: CART,
      maxToolCalls: 40,
      expiresAt: body.expiresAt,
    });
    expect(route.liveSessions.size()).toBe(1);
    expect(route.providerCalls).toHaveLength(1);
    expect(route.providerCalls[0]?.url).toBe("https://api.openai.com/v1/realtime/client_secrets");

    // ความเร็วเสียงพูดค่าเริ่มต้น 0.85; ไม่เปิดเก็บบทสนทนา = ไม่ถอดเสียง (ไม่เสียค่าถอดเสียงเปล่า ๆ)
    const providerBody = JSON.parse(String(route.providerCalls[0]?.init.body));
    expect(providerBody.session.audio).toEqual({ output: { speed: 0.85 } });
    expect(body.transcriptsEnabled).toBe(false);

    // metering: มีแต่ metadata — ไม่มีข้อความผู้ใช้/transcript หลุดเข้า log
    expect(route.logSystemEvent).toHaveBeenCalledWith(expect.objectContaining({
      action: "liveSession",
      context: expect.objectContaining({ reason: "created", stage: "create", sessionId: body.sessionId }),
    }));
  });
});

describe("live session route — DELETE end", () => {
  it("requires auth and a valid session token", async () => {
    const unauth = await loadRoute({ authed: false });
    expect((await unauth.route.DELETE(del({ sessionId: "sess-12345678", sessionToken: "1.abc" }))).status).toBe(401);

    const route = await loadRoute();
    const bad = await route.route.DELETE(del({ sessionId: "sess-12345678", sessionToken: "not-a-token" }));
    expect(bad.status).toBe(403);
    expect(await bad.json()).toMatchObject({ reason: "live_session_invalid" });
  });

  it("ends an owned session once, logs metering, and stays idempotent afterwards", async () => {
    const route = await loadRoute();
    const created = await (await route.route.POST(post(createBody))).json();

    const ended = await route.route.DELETE(del({ sessionId: created.sessionId, sessionToken: created.sessionToken }));
    expect(ended.status).toBe(200);
    const endedBody = await ended.json();
    expect(endedBody).toMatchObject({ ok: true, ended: true });
    expect(endedBody.sessionSeconds).toBeGreaterThanOrEqual(1);
    expect(endedBody.toolCallsUsed).toBe(0);
    expect(route.liveSessions.size()).toBe(0);
    expect(route.logSystemEvent).toHaveBeenCalledWith(expect.objectContaining({
      context: expect.objectContaining({ reason: "ended", stage: "end", sessionId: created.sessionId }),
    }));

    const again = await route.route.DELETE(del({ sessionId: created.sessionId, sessionToken: created.sessionToken }));
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ ok: true, ended: false });
    // เพิกถอนแล้วต้องไม่มีทางกลับมาใช้ token เดิมสั่งงานต่อบน instance นี้
    expect(route.liveSessions.isRevoked(created.sessionId)).toBe(true);
  });

  it("refuses to end a session owned by another store of the same pilot org", async () => {
    const route = await loadRoute();
    const created = await (await route.route.POST(post(createBody))).json();
    route.setIdentity({ organizationId: "org-1", storeId: "store-2", userId: "user-1" });
    const response = await route.route.DELETE(del({ sessionId: created.sessionId, sessionToken: created.sessionToken }));
    expect(response.status).toBe(403);
    expect(route.liveSessions.size()).toBe(1);
  });

  it("ปิดเซสชันได้จริงแม้ผู้ดูแลเพิ่งปิด Live กลางคัน — slot ต้องถูกคืน ไม่ค้างจน TTL", async () => {
    const route = await loadRoute();
    const created = await (await route.route.POST(post(createBody))).json();

    vi.stubEnv("AI_ASSISTANT_LIVE_ENABLED", "");
    const response = await route.route.DELETE(del({ sessionId: created.sessionId, sessionToken: created.sessionToken }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, ended: true });
    // ของเดิมตอบ ended:false แล้วทิ้งเซสชันไว้ — ร้านจะเจอ live_store_busy ทั้งที่ไม่มีใครใช้
    expect(route.liveSessions.size()).toBe(0);
  });

  it("ปิดเซสชันได้แม้ org หลุดจาก pilot ไปแล้ว (คืนทรัพยากรที่สร้างไปแล้วต้องทำได้เสมอ)", async () => {
    const route = await loadRoute();
    const created = await (await route.route.POST(post(createBody))).json();

    vi.stubEnv("AI_ASSISTANT_LIVE_PILOT_ORG_IDS", "org-someone-else");
    const response = await route.route.DELETE(del({ sessionId: created.sessionId, sessionToken: created.sessionToken }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, ended: true });
    expect(route.liveSessions.size()).toBe(0);
  });
});
