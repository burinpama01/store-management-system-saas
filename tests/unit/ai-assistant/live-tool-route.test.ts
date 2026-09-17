import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLiveSessionToken, resolveLiveTokenSecret } from "@/modules/ai-assistant/live-session";

// PR3-Live (M4) — route gate test ของ POST /api/ai-assistant/live/tool
// ทุกเคส mock auth/billing/provider/dispatcher deps (fake supabase table) จึงไม่มี network จริง
// เซสชันสร้างผ่าน POST /live/session จริงเสมอ เพื่อให้ session token ผูกกับเซสชันตัวจริง

interface Identity {
  organizationId: string;
  storeId: string;
  userId: string;
}

const CART = "cart-12345678";

const products = [
  {
    id: "p-latte", storeId: "store-1", organizationId: "org-1", categoryId: "cat", name: "ลาเต้",
    basePrice: 55, isActive: true, availableForPos: true, availableForQr: true, sortOrder: 0,
    variants: [], modifierGroups: [], createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
  },
];

// fake supabase table ของ ai_assistant_actions — pattern เดียวกับ text-command-route.test.ts (ฉบับย่อ)
type FakeRow = {
  id: string;
  organization_id: string;
  store_id: string;
  user_id: string;
  session_id: string;
  idempotency_key: string;
  tool: string;
  fingerprint: string;
  status: string;
  result: unknown;
  created_at: string;
  expires_at: string;
};

function createFakeActionsDb() {
  const rows: FakeRow[] = [];
  type Filter = { op: "eq" | "lte" | "in"; col: string; val: unknown };
  const cell = (row: FakeRow, col: string): unknown => (row as unknown as Record<string, unknown>)[col];
  const matches = (row: FakeRow, filters: Filter[]): boolean => filters.every((filter) => {
    if (filter.op === "eq") return cell(row, filter.col) === filter.val;
    if (filter.op === "in") return Array.isArray(filter.val) && (filter.val as unknown[]).includes(cell(row, filter.col));
    return Date.parse(String(cell(row, filter.col))) <= Date.parse(String(filter.val));
  });
  function makeChain(state: { op: "select" | "insert" | "update" | "delete"; values?: Partial<FakeRow>; filters: Filter[]; selected: boolean; single: boolean; maybeSingle: boolean; limitCount?: number }) {
    const run = async (): Promise<{ data: unknown; error: { code?: string; message: string } | null }> => {
      if (state.op === "insert") {
        const values = state.values as FakeRow;
        if (rows.some((row) => row.organization_id === values.organization_id && row.idempotency_key === values.idempotency_key)) {
          return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } };
        }
        rows.push({ ...values });
        return { data: null, error: null };
      }
      if (state.op === "update") {
        for (const row of rows) if (matches(row, state.filters)) Object.assign(row, state.values);
        return { data: null, error: null };
      }
      if (state.op === "delete") {
        const doomed = rows.filter((row) => matches(row, state.filters));
        const limited = state.limitCount !== undefined ? doomed.slice(0, state.limitCount) : doomed;
        for (const row of limited) rows.splice(rows.indexOf(row), 1);
        return { data: state.selected ? limited.map((row) => ({ id: row.id })) : null, error: null };
      }
      const found = rows.filter((row) => matches(row, state.filters));
      if (state.single || state.maybeSingle) return { data: found[0] ?? null, error: null };
      return { data: found, error: null };
    };
    const chain = {
      select: () => { state.selected = true; return chain; },
      eq: (col: string, val: unknown) => { state.filters.push({ op: "eq", col, val }); return chain; },
      lte: (col: string, val: unknown) => { state.filters.push({ op: "lte", col, val }); return chain; },
      in: (col: string, val: unknown[]) => { state.filters.push({ op: "in", col, val }); return chain; },
      limit: (n: number) => { state.limitCount = n; return chain; },
      single: () => { state.single = true; return chain; },
      maybeSingle: () => { state.maybeSingle = true; return chain; },
      then: (onFulfilled?: (value: { data: unknown; error: { code?: string; message: string } | null }) => unknown, onRejected?: (reason: unknown) => unknown) =>
        Promise.resolve().then(run).then(onFulfilled, onRejected),
    };
    return chain;
  }
  const client = {
    from(table: string) {
      if (table !== "ai_assistant_actions") throw Error(`fake db: unexpected table ${table}`);
      const state: { op: "select" | "insert" | "update" | "delete"; values: Partial<FakeRow> | undefined; filters: Filter[]; selected: boolean; single: boolean; maybeSingle: boolean; limitCount: number | undefined } = { op: "select", values: undefined, filters: [], selected: false, single: false, maybeSingle: false, limitCount: undefined };
      const chain = makeChain(state);
      return {
        select: () => chain.select(),
        insert: (values: FakeRow) => { state.op = "insert"; state.values = values; return chain; },
        update: (values: Partial<FakeRow>) => { state.op = "update"; state.values = values; return chain; },
        delete: () => { state.op = "delete"; return chain; },
      };
    },
  };
  return { rows, client };
}

async function loadRoute(options: Options = {}) {
  const {
    authed = true,
    canUsePos = true,
    planHasAi = true,
    liveEnabled = true,
    pilotOrg = "org-1",
    openaiKey = "sk-test-abcdefgh123456",
    mutationsEnabled = false,
    nodeEnv = "test",
    toolCallsCap,
    serviceClientRejectOnce = false,
  } = options;

  vi.resetModules();
  const logSystemEvent = vi.fn().mockResolvedValue(undefined);
  const loadCatalog = vi.fn(async () => ({ products, aliases: [] }));
  const db = createFakeActionsDb();

  // เกตเปลี่ยนได้ตอน request เวลา — เซสชันสร้างตอนเกตเปิด แล้วค่อยปิดทีละด่านเพื่อทดสอบ relay
  let identity: Identity | null = { organizationId: "org-1", storeId: "store-1", userId: "user-1" };
  let canUsePosNow = canUsePos;
  let planHasAiNow = planHasAi;
  const setIdentity = (next: Identity | null) => { identity = next; };
  const setGates = (next: { canUsePos?: boolean; planHasAi?: boolean; liveEnabled?: boolean }) => {
    if (next.canUsePos !== undefined) canUsePosNow = next.canUsePos;
    if (next.planHasAi !== undefined) planHasAiNow = next.planHasAi;
    if (next.liveEnabled !== undefined) {
      vi.stubEnv("AI_ASSISTANT_LIVE_ENABLED", next.liveEnabled ? "true" : "");
    }
  };

  vi.doMock("@/modules/auth/guards", () => ({
    getResolvedCurrentPermissions: vi.fn(async () => {
      if (!authed || !identity) return null;
      return {
        ctx: { organizationId: identity.organizationId, storeId: identity.storeId, userId: identity.userId },
        user: { id: identity.userId },
        resolved: { can: () => canUsePosNow, organizationId: identity.organizationId, storeId: identity.storeId },
      };
    }),
  }));
  vi.doMock("@/modules/billing/billing-service", () => ({
    getOrganizationBillingState: vi.fn().mockResolvedValue({ plan: "enterprise", status: "active" }),
  }));
  vi.doMock("@/modules/billing/types", async () => {
    const actual = await vi.importActual<typeof import("@/modules/billing/types")>("@/modules/billing/types");
    return { ...actual, canUseFeature: () => planHasAiNow };
  });
  vi.doMock("@/modules/system/event-log", () => ({ logSystemEvent }));
  vi.doMock("@/modules/ai-assistant/tools/pos-tools-server", () => ({ createServerPosToolDeps: () => ({ loadCatalog }) }));
  const serviceClientMock = serviceClientRejectOnce
    ? vi.fn().mockRejectedValueOnce(new Error("supabaseUrl is required.")).mockResolvedValue(db.client)
    : vi.fn(async () => db.client);
  vi.doMock("@/server/integrations/supabase/server", () => ({ createSupabaseServiceClient: serviceClientMock }));

  vi.stubEnv("AI_ASSISTANT_ENABLED", "true");
  vi.stubEnv("AI_ASSISTANT_LIVE_ENABLED", liveEnabled ? "true" : "");
  vi.stubEnv("AI_ASSISTANT_LIVE_PILOT_ORG_IDS", pilotOrg);
  vi.stubEnv("OPENAI_API_KEY", openaiKey);
  if (nodeEnv !== "test") vi.stubEnv("NODE_ENV", nodeEnv);
  if (mutationsEnabled) vi.stubEnv("AI_ASSISTANT_MUTATIONS_ENABLED", "true");
  if (toolCallsCap) vi.stubEnv("AI_ASSISTANT_LIVE_MAX_TOOL_CALLS_PER_SESSION", String(toolCallsCap));

  // provider (global fetch) ตอบ 200 เสมอ — relay test ต้องสร้างเซสชันจริงก่อน
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
    value: "ek_test_ephemeral_secret_value",
    expires_at: 1_900_000_000,
    session: { id: "sess_test_1", audio: { output: { voice: "alloy" } } },
  }), { status: 200 })));

  const sessionRoute = await import("@/app/api/ai-assistant/live/session/route");
  const toolRoute = await import("@/app/api/ai-assistant/live/tool/route");
  const transcriptRoute = await import("@/app/api/ai-assistant/live/transcript/route");
  const liveServer = await import("@/modules/ai-assistant/live-server");
  return { sessionRoute, toolRoute, transcriptRoute, liveServer, liveSessions: liveServer.liveComposition.liveSessions, logSystemEvent, loadCatalog, db, setIdentity, setGates };
}

interface Options {
  authed?: boolean;
  canUsePos?: boolean;
  planHasAi?: boolean;
  liveEnabled?: boolean;
  pilotOrg?: string;
  openaiKey?: string;
  mutationsEnabled?: boolean;
  nodeEnv?: "test" | "production";
  toolCallsCap?: number;
  serviceClientRejectOnce?: boolean;
}

const postSession = (body: unknown) =>
  new Request("http://localhost/api/ai-assistant/live/session", { method: "POST", body: JSON.stringify(body) });

const postTool = (body: unknown) =>
  new Request("http://localhost/api/ai-assistant/live/tool", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) });

const callId = "call_ABCDEFGHIJ";

/** สร้างเซสชันจริงผ่าน route แล้วคืน body (sessionId/sessionToken ตัวจริง) + routes ของ module เดียวกัน */
async function createSession(options: Options = {}): Promise<{
  sessionId: string;
  sessionToken: string;
  route: Awaited<ReturnType<typeof loadRoute>>;
}> {
  const route = await loadRoute(options);
  const response = await route.sessionRoute.POST(postSession({ activeCartId: CART }));
  expect(response.status).toBe(200);
  const body = await response.json();
  return { sessionId: body.sessionId as string, sessionToken: body.sessionToken as string, route };
}

const relayBody = {
  callId,
  tool: "pos.search_product",
  args: { query: "ลาเต้" },
  cartVersion: 3,
  idempotencyKey: "live-call_ABCDEFGHIJ",
};

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

describe("live tool route — shared gates", () => {
  it("requires auth, pos.use, plan entitlement, pilot membership, and the live kill switch", async () => {
    // เซสชันสร้างตอนเกตเปิดครบ แล้วปิดทีละด่านก่อน relay — พิสูจน์ว่า relay re-check ทุกด่านเอง
    const created = await createSession();
    const base = { sessionId: created.sessionId, sessionToken: created.sessionToken };

    created.route.setIdentity(null);
    expect((await created.route.toolRoute.POST(postTool({ ...base, ...relayBody }))).status).toBe(401);

    created.route.setIdentity({ organizationId: "org-1", storeId: "store-1", userId: "user-1" });
    created.route.setGates({ canUsePos: false });
    expect((await created.route.toolRoute.POST(postTool({ ...base, ...relayBody }))).status).toBe(403);

    created.route.setGates({ canUsePos: true, planHasAi: false });
    const noPlan = await created.route.toolRoute.POST(postTool({ ...base, ...relayBody }));
    expect(noPlan.status).toBe(403);
    expect(await noPlan.json()).toMatchObject({ reason: "ai_not_in_plan" });

    created.route.setGates({ planHasAi: true });
    created.route.setIdentity({ organizationId: "org-other", storeId: "store-1", userId: "user-1" });
    const pilot = await created.route.toolRoute.POST(postTool({ ...base, ...relayBody }));
    expect(pilot.status).toBe(403);
    expect(await pilot.json()).toMatchObject({ reason: "live_pilot_only" });

    // kill switch re-read: ปิดกลางเซสชัน = relay โดนปิดทันที (fail closed)
    created.route.setIdentity({ organizationId: "org-1", storeId: "store-1", userId: "user-1" });
    created.route.setGates({ liveEnabled: false });
    const disabled = await created.route.toolRoute.POST(postTool({ ...base, ...relayBody }));
    expect(disabled.status).toBe(503);
    expect(await disabled.json()).toMatchObject({ reason: "live_disabled" });
  });

  it("rate limits the relay separately from session creation", async () => {
    const created = await createSession({ toolCallsCap: 200 });
    let lastStatus = 0;
    for (let i = 0; i < 61; i += 1) {
      const call = `call_${String(i).padStart(10, "0")}`;
      const response = await created.route.toolRoute.POST(postTool({
        sessionId: created.sessionId,
        sessionToken: created.sessionToken,
        callId: call,
        tool: "pos.search_product",
        args: { query: "ลาเต้" },
        cartVersion: 3,
        idempotencyKey: `live-${call}`.slice(0, 64),
      }));
      lastStatus = response.status;
    }
    expect(lastStatus).toBe(429);
    const body = await (await created.route.toolRoute.POST(postTool({ sessionId: created.sessionId, sessionToken: created.sessionToken, ...relayBody }))).json();
    expect(body).toMatchObject({ reason: "rate_limited" });
    expect(created.route.logSystemEvent).toHaveBeenCalledWith(expect.objectContaining({ context: expect.objectContaining({ reason: "rate_limited" }) }));
  });

  it("rejects malformed bodies", async () => {
    const created = await createSession();
    const base = { sessionId: created.sessionId, sessionToken: created.sessionToken };
    expect((await created.route.toolRoute.POST(postTool("not-json"))).status).toBe(400);
    expect((await created.route.toolRoute.POST(postTool(base))).status).toBe(400);
    expect((await created.route.toolRoute.POST(postTool({ ...base, ...relayBody, tool: "pos.settle_payment" }))).status).toBe(400);
    expect((await created.route.toolRoute.POST(postTool({ ...base, ...relayBody, callId: "x" }))).status).toBe(400);
    expect((await created.route.toolRoute.POST(postTool({ ...base, ...relayBody, idempotencyKey: "short" }))).status).toBe(400);
    expect((await created.route.toolRoute.POST(postTool({ ...base, ...relayBody, extra: true }))).status).toBe(400);
  });
});

describe("live tool route — session binding", () => {
  // หัวใจของรอบแก้ตามรีวิว PR #47: บน Vercel คำขอถัดไปไม่การันตีว่าจะวิ่งเข้า process เดิม
  // ของเดิมเซสชันอยู่ในหน่วยความจำ instance เดียว → พูดคำสั่งแรกแล้วเจอ 403 กลางบทสนทนา
  // ตอนนี้ตัวตนของเซสชันอยู่ใน token ที่เซ็นแล้ว จึงต้องคุยต่อได้บน instance ที่ไม่เคยเห็นเซสชันนี้
  it("relay ทำงานต่อได้บน instance ใหม่ที่ไม่เคยเห็นเซสชัน (ไม่หลุดกลางบทสนทนา)", async () => {
    const created = await createSession();
    const base = { sessionId: created.sessionId, sessionToken: created.sessionToken };

    // จำลอง instance ใหม่: โหลด module ใหม่ทั้งชุด (composition/หน่วยความจำคนละก้อน)
    const otherInstance = await loadRoute();
    expect(otherInstance.liveSessions.size()).toBe(0);

    const response = await otherInstance.toolRoute.POST(postTool({ ...base, ...relayBody }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, tool: "pos.search_product", outcome: { ok: true } });
    // instance ใหม่รับเซสชันเข้ามานับเพดาน tool call ต่อจาก token (best-effort ต่อ instance)
    expect(otherInstance.liveSessions.size()).toBe(1);
  });

  it("refuses an invalid or forged session token", async () => {
    const created = await createSession();
    const forged = await created.route.toolRoute.POST(postTool({ sessionId: created.sessionId, sessionToken: "1234567890.deadbeef", ...relayBody }));
    expect(forged.status).toBe(403);
    expect(await forged.json()).toMatchObject({ reason: "live_session_invalid" });

    // token ที่เซ็นด้วยความลับอื่น = ปฏิเสธ (ลายเซ็นคือสิ่งเดียวที่ทำให้ token มีผล)
    const foreign = createLiveSessionToken({
      sessionId: created.sessionId,
      organizationId: "org-1",
      storeId: "store-1",
      userId: "user-1",
      activeCartId: CART,
      allowedTools: ["pos.search_product"],
      maxToolCalls: 40,
      expiresAt: Date.now() + 600_000,
    }, "someone-elses-secret-0123456789");
    const foreignResponse = await created.route.toolRoute.POST(postTool({ sessionId: created.sessionId, sessionToken: foreign, ...relayBody }));
    expect(foreignResponse.status).toBe(403);
    expect(await foreignResponse.json()).toMatchObject({ reason: "live_session_invalid" });

    // token ที่ id ใน body ไม่ตรงกับ id ใน token = ปฏิเสธ (ผูกกันตายตัว)
    const secret = resolveLiveTokenSecret(process.env);
    expect(secret).not.toBeNull();
    const otherToken = createLiveSessionToken({
      sessionId: "sess-00000000-0000",
      organizationId: "org-1",
      storeId: "store-1",
      userId: "user-1",
      activeCartId: CART,
      allowedTools: ["pos.search_product"],
      maxToolCalls: 40,
      expiresAt: 1_900_000_000_000,
    }, secret as string);
    const swapped = await created.route.toolRoute.POST(postTool({ sessionId: created.sessionId, sessionToken: otherToken, ...relayBody }));
    expect(swapped.status).toBe(403);
    expect(await swapped.json()).toMatchObject({ reason: "live_session_invalid" });
  });

  it("refuses a session owned by another store/user and closed sessions", async () => {
    const created = await createSession();
    created.route.setIdentity({ organizationId: "org-1", storeId: "store-2", userId: "user-1" });
    const wrongStore = await created.route.toolRoute.POST(postTool({ sessionId: created.sessionId, sessionToken: created.sessionToken, ...relayBody }));
    expect(wrongStore.status).toBe(403);
    expect(await wrongStore.json()).toMatchObject({ reason: "live_session_invalid" });

    // เซสชันถูกปิดไปแล้ว (end) = relay ไม่ผ่านแน่นอน
    const closed = await createSession();
    await closed.route.sessionRoute.DELETE(new Request("http://localhost/api/ai-assistant/live/session", { method: "DELETE", body: JSON.stringify({ sessionId: closed.sessionId, sessionToken: closed.sessionToken }) }));
    const afterClose = await closed.route.toolRoute.POST(postTool({ sessionId: closed.sessionId, sessionToken: closed.sessionToken, ...relayBody }));
    expect(afterClose.status).toBe(403);
    expect(await afterClose.json()).toMatchObject({ reason: "live_session_invalid" });
  });

  it("enforces the session tool-call cap and counts rejected attempts", async () => {
    const created = await createSession({ toolCallsCap: 1 });
    const base = { sessionId: created.sessionId, sessionToken: created.sessionToken };
    const first = await created.route.toolRoute.POST(postTool({ ...base, ...relayBody }));
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ ok: true, toolCallsUsed: 1, toolCallsCap: 1 });

    const second = await created.route.toolRoute.POST(postTool({ ...base, ...relayBody, callId: "call_XXXXXXXXXX" }));
    expect(second.status).toBe(429);
    expect(await second.json()).toMatchObject({ reason: "live_tool_cap_reached" });
  });

  it("refuses tools outside the session allowlist", async () => {
    // seed เซสชันด้วย allowlist ย่อ ผ่าน store ตรง (เหมือนกรณีจำกัด allowlist ต่อร้านในอนาคต)
    const route = await loadRoute();
    const created = route.liveSessions.create(
      { organizationId: "org-1", storeId: "store-1", userId: "user-1" },
      { ttlMs: 10 * 60_000, activeCartId: CART, allowedTools: ["pos.search_product"] },
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const secret = resolveLiveTokenSecret(process.env);
    expect(secret).not.toBeNull();
    const sessionToken = createLiveSessionToken({
      sessionId: created.session.id,
      organizationId: created.session.organizationId,
      storeId: created.session.storeId,
      userId: created.session.userId,
      activeCartId: created.session.activeCartId,
      allowedTools: created.session.allowedTools,
      maxToolCalls: created.session.maxToolCalls,
      expiresAt: created.session.expiresAt,
    }, secret as string);
    const response = await route.toolRoute.POST(postTool({
      sessionId: created.session.id, sessionToken,
      callId, tool: "pos.add_item", args: { productPhrase: "ลาเต้", quantity: 1 }, cartVersion: 0, idempotencyKey: "live-call_ABCDEFGHIJ",
    }));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ reason: "live_tool_not_allowed" });
  });
});

describe("live tool route — dispatcher results and arg injection", () => {
  it("relays a read tool through the dispatcher with server-injected nothing and returns the tool result", async () => {
    const created = await createSession();
    created.route.loadCatalog.mockClear(); // เปิดเซสชันโหลดเมนูไปสรุปให้ model แล้วหนึ่งครั้ง
    const response = await created.route.toolRoute.POST(postTool({ sessionId: created.sessionId, sessionToken: created.sessionToken, ...relayBody }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      ok: true,
      callId,
      tool: "pos.search_product",
      outcome: { ok: true, data: { status: "matched", product: { id: "p-latte", name: "ลาเต้" } } },
      toolCallsUsed: 1,
    });
    expect(created.route.loadCatalog).toHaveBeenCalledTimes(1);
    // metering: metadata เท่านั้น — ไม่มีคำค้นหาของผู้ใช้หลุดเข้า log
    expect(JSON.stringify(created.route.logSystemEvent.mock.calls)).not.toContain("ลาเต้");
    expect(created.route.logSystemEvent).toHaveBeenCalledWith(expect.objectContaining({
      action: "liveTool",
      context: expect.objectContaining({ reason: "relayed", stage: "relay", callId, tool: "pos.search_product", outcome: "success" }),
    }));
  });

  it("injects the session cart id with the client cart version — model cannot forge the cart", async () => {
    const created = await createSession();
    const response = await created.route.toolRoute.POST(postTool({
      sessionId: created.sessionId, sessionToken: created.sessionToken,
      callId: "call_ORDER0001", tool: "pos.get_current_order", args: {}, idempotencyKey: "live-call_ORDER0001",
      cartVersion: 5, summary: { itemCount: 2, total: 110, locked: false },
    }));
    expect(response.status).toBe(200);
    const body = await response.json();
    // activeCartId ใน outcome ต้องเป็นใบที่ session ผูกไว้ (ไม่ใช่ค่าที่ model/client ปลอมได้)
    expect(body.outcome).toMatchObject({ ok: true, data: { activeCartId: CART, cartVersion: 5, itemCount: 2, total: 110 } });
  });

  it("strips forged injected keys from model args before dispatch", async () => {
    const created = await createSession({ mutationsEnabled: true });
    const response = await created.route.toolRoute.POST(postTool({
      sessionId: created.sessionId, sessionToken: created.sessionToken,
      callId: "call_ADDITEM01", tool: "pos.add_item",
      // model พยายามฉีด cart ใบอื่น + version ปลอม — schema strict ของ pos-tools จะไม่รับถ้าไม่ strip
      args: { productPhrase: "ลาเต้", quantity: 2, activeCartId: "cart-evil-9999", cartVersion: 99 }, idempotencyKey: "live-call_ADDITEM01",
      cartVersion: 3,
    }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.outcome).toMatchObject({ ok: true, data: { status: "apply", productName: "ลาเต้" } });
    expect(created.route.db.rows).toHaveLength(1);
    expect(created.route.db.rows[0]).toMatchObject({ tool: "pos.add_item", status: "completed" });
  });

  it("fails closed with INVALID_ARGS when the client cannot provide the cart summary", async () => {
    const created = await createSession();
    const response = await created.route.toolRoute.POST(postTool({
      sessionId: created.sessionId, sessionToken: created.sessionToken,
      callId: "call_ORDER0002", tool: "pos.get_current_order", args: {}, idempotencyKey: "live-call_ORDER0002",
      cartVersion: 0,
    }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.outcome).toMatchObject({ ok: false, code: "INVALID_ARGS" });
  });

  it("replays the same idempotency key without executing twice", async () => {
    const created = await createSession();
    created.route.loadCatalog.mockClear(); // เปิดเซสชันโหลดเมนูไปสรุปให้ model แล้วหนึ่งครั้ง
    const base = { sessionId: created.sessionId, sessionToken: created.sessionToken };
    const first = await created.route.toolRoute.POST(postTool({ ...base, ...relayBody, idempotencyKey: "live-call_ABCDEFGHIJ" }));
    expect(first.status).toBe(200);
    const second = await created.route.toolRoute.POST(postTool({ ...base, ...relayBody, idempotencyKey: "live-call_ABCDEFGHIJ" }));
    expect(second.status).toBe(200);
    expect((await second.json())).toMatchObject({ outcome: { ok: true, data: { status: "matched" } } });
    expect(created.route.loadCatalog).toHaveBeenCalledTimes(1);
    expect(created.route.db.rows).toHaveLength(1);
  });

  it("answers typed 503 when dispatcher creation fails and recovers on the next request", async () => {
    const created = await createSession({ serviceClientRejectOnce: true });
    const base = { sessionId: created.sessionId, sessionToken: created.sessionToken };
    const first = await created.route.toolRoute.POST(postTool({ ...base, ...relayBody }));
    expect(first.status).toBe(503);
    expect(await first.json()).toMatchObject({ ok: false, reason: "assistant_unavailable" });

    const second = await created.route.toolRoute.POST(postTool({ ...base, ...relayBody, callId: "call_YYYYYYYYYY" }));
    expect(second.status).toBe(200);
    expect((await second.json())).toMatchObject({ outcome: { ok: true } });
  });
});

// 2026-09-17 — เก็บบทสนทนาไว้วิเคราะห์ (เปิดเฉพาะ AI_ASSISTANT_LIVE_TRANSCRIPTS_ENABLED)
describe("live transcript — บันทึกบทสนทนา", () => {
  const postTranscript = (body: unknown) =>
    new Request("http://localhost/api/ai-assistant/live/transcript", { method: "POST", body: JSON.stringify(body) });

  it("ปิดอยู่ (ค่าเริ่มต้น) = ไม่บันทึกอะไรเลย ทั้งข้อความและ tool", async () => {
    const created = await createSession();
    const record = vi.spyOn(created.route.liveServer.liveComposition, "recordTranscript");
    const response = await created.route.transcriptRoute.POST(postTranscript({
      sessionId: created.sessionId, sessionToken: created.sessionToken, turns: [{ role: "user", text: "ลาเต้เย็นหนึ่งแก้ว", seq: 0 }],
    }));
    expect(await response.json()).toEqual({ ok: true, stored: 0, enabled: false });
    await created.route.toolRoute.POST(postTool({ sessionId: created.sessionId, sessionToken: created.sessionToken, ...relayBody }));
    expect(record).not.toHaveBeenCalled();
  });

  it("เปิดอยู่ = บันทึกคำพูดด้วย identity จาก token และบันทึก tool พร้อม args + ผลลัพธ์จากฝั่ง server", async () => {
    const created = await createSession();
    vi.stubEnv("AI_ASSISTANT_LIVE_TRANSCRIPTS_ENABLED", "true");
    const record = vi.spyOn(created.route.liveServer.liveComposition, "recordTranscript").mockResolvedValue(1);

    const response = await created.route.transcriptRoute.POST(postTranscript({
      sessionId: created.sessionId,
      sessionToken: created.sessionToken,
      turns: [{ role: "user", text: "ลาเต้เย็นหนึ่งแก้ว", seq: 0, itemId: "item_abc" }],
    }));
    expect(response.status).toBe(200);
    expect(record).toHaveBeenCalledWith(
      { organizationId: "org-1", storeId: "store-1", userId: "user-1", sessionId: created.sessionId },
      [{ role: "user", content: "ลาเต้เย็นหนึ่งแก้ว", clientSeq: 0, providerItemId: "item_abc" }],
    );

    await created.route.toolRoute.POST(postTool({ sessionId: created.sessionId, sessionToken: created.sessionToken, ...relayBody }));
    const toolTurn = record.mock.calls[1]?.[1][0];
    expect(toolTurn).toMatchObject({ role: "tool", tool: "pos.search_product", providerItemId: callId });
    expect(toolTurn?.content).toContain("ลาเต้");
    expect(toolTurn?.metadata).toMatchObject({ outcome: { ok: true, data: { status: "matched" } } });
    // ข้อความไม่หลุดไป system_event_logs (ผู้ดูแลทุกคนเห็น)
    expect(JSON.stringify(created.route.logSystemEvent.mock.calls)).not.toContain("ลาเต้เย็นหนึ่งแก้ว");
  });

  it("token ปลอม/ของคนอื่น = 403 และไม่บันทึก", async () => {
    const created = await createSession();
    vi.stubEnv("AI_ASSISTANT_LIVE_TRANSCRIPTS_ENABLED", "true");
    const record = vi.spyOn(created.route.liveServer.liveComposition, "recordTranscript");
    const forged = await created.route.transcriptRoute.POST(postTranscript({
      sessionId: created.sessionId, sessionToken: `${created.sessionToken}x`, turns: [{ role: "user", text: "สวัสดี" }],
    }));
    expect(forged.status).toBe(403);
    created.route.setIdentity({ organizationId: "org-1", storeId: "store-2", userId: "user-1" });
    const otherStore = await created.route.transcriptRoute.POST(postTranscript({
      sessionId: created.sessionId, sessionToken: created.sessionToken, turns: [{ role: "user", text: "สวัสดี" }],
    }));
    expect(otherStore.status).toBe(403);
    expect(record).not.toHaveBeenCalled();
  });

  it("body ผิดรูป (role แปลก/ยาวเกิน) = 400", async () => {
    const created = await createSession();
    vi.stubEnv("AI_ASSISTANT_LIVE_TRANSCRIPTS_ENABLED", "true");
    const bad = await created.route.transcriptRoute.POST(postTranscript({
      sessionId: created.sessionId, sessionToken: created.sessionToken, turns: [{ role: "tool", text: "x" }],
    }));
    expect(bad.status).toBe(400);
    const long = await created.route.transcriptRoute.POST(postTranscript({
      sessionId: created.sessionId, sessionToken: created.sessionToken, turns: [{ role: "user", text: "ก".repeat(4001) }],
    }));
    expect(long.status).toBe(400);
  });
});
