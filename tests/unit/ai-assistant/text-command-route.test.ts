import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// PR2 — route gate test: auth → entitlement → rate limit → kill switch → body → โหมดข้อความ/read-tool
// ทุกเคส mock ผู้ให้บริการ AI + repository จึงไม่มี network และไม่แตะ Supabase

const user = { id: "user-1" };
const ctx = { userId: "user-1", organizationId: "org-1", storeId: "store-1" };

const envelope = {
  version: 1,
  outcome: "command_batch",
  commands: [{ intent: "pos.add_item", productPhrase: "ลาเต้", quantity: 2, optionPhrases: [] }],
  confidence: "high",
  reasonCode: "matched",
};

const products = [
  {
    id: "p-latte", storeId: "store-1", organizationId: "org-1", categoryId: "cat", name: "ลาเต้",
    basePrice: 55, isActive: true, availableForPos: true, availableForQr: true, sortOrder: 0,
    variants: [], modifierGroups: [], createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
  },
];

const CART = "cart-12345678";

// PR3 — fake supabase client สำหรับตาราง ai_assistant_actions (pattern เดียวกับ
// durable-idempotency.test.ts แต่ฉบับย่อ: unique (org, key) + filter eq/lte/in + maybeSingle)
// route ผูก DurableIdempotencyStore เข้า dispatcher แล้ว จึงต้อง mock service client เสมอ
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
      const limited = state.limitCount !== undefined ? found.slice(0, state.limitCount) : found;
      if (state.single || state.maybeSingle) return { data: limited[0] ?? null, error: null };
      return { data: limited, error: null };
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
    aiEnabled = true,
    quotaGranted = true,
    quotaThrows = false,
    assistantEnabled = true,
    nodeEnv = "test",
    mutationsEnabled = false,
    serviceClientRejectOnce = false,
    interpret = { ok: true, envelope, tokens: 88 },
  } = options;

  vi.resetModules();
  const reserveQuota = vi.fn();
  if (quotaThrows) {
    reserveQuota.mockRejectedValue(new Error("quota store down"));
  } else {
    reserveQuota.mockResolvedValue({ granted: quotaGranted });
  }
  const settleUsage = vi.fn().mockResolvedValue({ ok: true, error: null });
  const interpretVoiceIntent = vi.fn().mockResolvedValue(interpret);
  const logSystemEvent = vi.fn().mockResolvedValue(undefined);
  const loadCatalog = vi.fn(async () => ({ products, aliases: [] }));
  const db = createFakeActionsDb();

  vi.doMock("@/modules/auth/guards", () => ({
    getResolvedCurrentPermissions: vi
      .fn()
      .mockResolvedValue(authed
        ? { ctx, user, resolved: { can: () => canUsePos, organizationId: ctx.organizationId, storeId: ctx.storeId } }
        : null),
  }));
  vi.doMock("@/modules/billing/billing-service", () => ({
    getOrganizationBillingState: vi.fn().mockResolvedValue({ plan: "enterprise", status: "active" }),
  }));
  vi.doMock("@/modules/billing/types", async () => {
    const actual = await vi.importActual<typeof import("@/modules/billing/types")>("@/modules/billing/types");
    return { ...actual, canUseFeature: () => planHasAi };
  });
  vi.doMock("@/modules/ai/gateway", () => ({ AI_DEFAULT_MODEL: "gpt-4o-mini", isAiEnabled: () => aiEnabled }));
  vi.doMock("@/modules/ai/quota", () => ({ AI_MAX_OUTPUT_TOKENS: 600, reserveQuota, settleUsage }));
  vi.doMock("@/modules/system/event-log", () => ({ logSystemEvent }));
  vi.doMock("@/modules/ai/voice-intent", async () => {
    const actual = await vi.importActual<typeof import("@/modules/ai/voice-intent")>("@/modules/ai/voice-intent");
    return { ...actual, interpretVoiceIntent };
  });
  vi.doMock("@/modules/ai-assistant/tools/pos-tools-server", () => ({ createServerPosToolDeps: () => ({ loadCatalog }) }));
  // PR3 — route สร้าง DurableIdempotencyStore จาก service client: ต้อง mock เป็น fake table เสมอ
  // (serviceClientRejectOnce = จำลอง env supabase พังครั้งแรก พิสูจน์ retry หลัง memoize ถูก reset)
  const serviceClientMock = serviceClientRejectOnce
    ? vi.fn().mockRejectedValueOnce(new Error("supabaseUrl is required.")).mockResolvedValue(db.client)
    : vi.fn(async () => db.client);
  vi.doMock("@/server/integrations/supabase/server", () => ({
    createSupabaseServiceClient: serviceClientMock,
  }));
  // ปิด kill switch ให้เส้นทางปกติผ่าน (หรือเปิดไว้เพื่อทดสอบ 503)
  vi.stubEnv("AI_ASSISTANT_ENABLED", assistantEnabled ? "true" : "");
  // environment ของ registry/dispatcher อ่าน NODE_ENV ตอน composition (test = ค่าเริ่มต้นของ vitest)
  if (nodeEnv !== "test") vi.stubEnv("NODE_ENV", nodeEnv);
  if (mutationsEnabled) vi.stubEnv("AI_ASSISTANT_MUTATIONS_ENABLED", "true");

  const route = await import("@/app/api/ai-assistant/text-command/route");
  return { route, reserveQuota, settleUsage, interpretVoiceIntent, logSystemEvent, loadCatalog, db };
}

interface Options {
  authed?: boolean;
  canUsePos?: boolean;
  planHasAi?: boolean;
  aiEnabled?: boolean;
  quotaGranted?: boolean;
  quotaThrows?: boolean;
  assistantEnabled?: boolean;
  nodeEnv?: "test" | "production";
  mutationsEnabled?: boolean;
  serviceClientRejectOnce?: boolean;
  interpret?: unknown;
}

const post = (body: unknown) =>
  new Request("http://localhost/api/ai-assistant/text-command", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const textBody = { requestId: "req-12345678", text: "เพิ่มลาเต้สองแก้ว", activeCartId: CART, cartVersion: 3 };

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
});

describe("text command route gates", () => {
  it("requires an authenticated POS user and the aiAssistant entitlement", async () => {
    const unauth = await loadRoute({ authed: false });
    expect((await unauth.route.POST(post(textBody))).status).toBe(401);

    const noPos = await loadRoute({ canUsePos: false });
    expect((await noPos.route.POST(post(textBody))).status).toBe(403);

    const noPlan = await loadRoute({ planHasAi: false });
    const response = await noPlan.route.POST(post(textBody));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ reason: "ai_not_in_plan" });
  });

  it("rate limits at the route layer before touching provider or dispatcher", async () => {
    const route = await loadRoute();
    let lastStatus = 0;
    for (let i = 0; i < 21; i += 1) {
      const response = await route.route.POST(post({ ...textBody, requestId: `rate-${String(i).padStart(8, "0")}` }));
      lastStatus = response.status;
      if (i < 20) expect(response.status).toBe(200);
    }
    expect(lastStatus).toBe(429);
    const body = await (await route.route.POST(post({ ...textBody, requestId: "rate-99999999" }))).json();
    expect(body).toMatchObject({ reason: "rate_limited" });
    expect(route.logSystemEvent).toHaveBeenCalledWith(expect.objectContaining({ context: expect.objectContaining({ reason: "rate_limited" }) }));
  });

  it("honors the assistant kill switch", async () => {
    const route = await loadRoute({ assistantEnabled: false });
    const response = await route.route.POST(post(textBody));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ reason: "assistant_disabled" });
  });

  it("rejects malformed bodies and ambiguous modes", async () => {
    const route = await loadRoute();
    expect((await route.route.POST(post("not-json"))).status).toBe(400);
    expect((await route.route.POST(post({ text: "ลาเต้" }))).status).toBe(400);
    expect((await route.route.POST(post({ ...textBody, tool: "pos.search_product" }))).status).toBe(400);
    expect((await route.route.POST(post({ requestId: "req-12345678", text: "ลาเต้", tool: "pos.add_item" }))).status).toBe(400);
  });

  it("runs the deterministic text path without spending AI quota and keeps mutation closed", async () => {
    const route = await loadRoute();
    const response = await route.route.POST(post(textBody));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.outcomes[0]).toMatchObject({ kind: "error", ok: false, tool: "pos.add_item", code: "MUTATIONS_DISABLED" });
    expect(route.reserveQuota).not.toHaveBeenCalled();
    expect(route.interpretVoiceIntent).not.toHaveBeenCalled();
    // route log ต้องไม่มีข้อความของผู้ใช้หลุดเข้าไป
    expect(JSON.stringify(route.logSystemEvent.mock.calls)).not.toContain("ลาเต้");
  });

  it("falls back to the AI provider only when the deterministic parser cannot answer", async () => {
    const route = await loadRoute();
    const response = await route.route.POST(post({ ...textBody, text: "ขออะไรแปลก ๆ หน่อยครับ" }));
    expect(response.status).toBe(200);
    expect(route.interpretVoiceIntent).toHaveBeenCalledTimes(1);
    expect(route.reserveQuota).toHaveBeenCalledTimes(1);
    expect(route.settleUsage).toHaveBeenCalledWith(expect.objectContaining({ tokens: 88, status: "ok" }));
    const body = await response.json();
    expect(body.outcomes[0]).toMatchObject({ kind: "error", code: "MUTATIONS_DISABLED" });
  });

  it("reports provider failure as a typed content failure without echoing the text", async () => {
    const route = await loadRoute({ interpret: { ok: false, reason: "ai_timeout" } });
    const response = await route.route.POST(post({ ...textBody, text: "ขออะไรแปลก ๆ หน่อยครับ" }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.failure).toBe("ai_timeout");
    expect(body.note).toBeTruthy();
    expect(JSON.stringify(body)).not.toContain("ขออะไรแปลก");
    expect(route.settleUsage).not.toHaveBeenCalled();
  });

  it("answers typed ai_error instead of a 500 when the quota infra throws (M4 review)", async () => {
    const route = await loadRoute({ quotaThrows: true });
    const response = await route.route.POST(post({ ...textBody, text: "ขออะไรแปลก ๆ หน่อยครับ" }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ ok: true, failure: "ai_error" });
    expect(JSON.stringify(body)).not.toContain("ขออะไรแปลก");
  });

  it("denies quota exhaustion as its own reason", async () => {
    const route = await loadRoute({ quotaGranted: false });
    const response = await route.route.POST(post({ ...textBody, text: "ขออะไรแปลก ๆ หน่อยครับ" }));
    const body = await response.json();
    expect(body.failure).toBe("quota_denied");
    expect(route.interpretVoiceIntent).not.toHaveBeenCalled();
  });

  it("serves whitelisted read tools through the same dispatcher", async () => {
    const route = await loadRoute();
    const response = await route.route.POST(post({ requestId: "req-12345678", tool: "pos.search_product", args: { query: "ลาเต้" } }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.outcomes[0]).toMatchObject({ kind: "tool", ok: true, tool: "pos.search_product", result: { status: "matched", product: { id: "p-latte", name: "ลาเต้" } } });
    expect(route.loadCatalog).toHaveBeenCalledTimes(1);
  });

  it("confirms the current order only with a valid cart binding", async () => {
    const route = await loadRoute();
    const good = await route.route.POST(post({
      requestId: "req-12345678",
      tool: "pos.get_current_order",
      args: { activeCartId: CART, cartVersion: 3, summary: { itemCount: 2, total: 110, locked: false } },
    }));
    expect((await good.json())).toMatchObject({ outcomes: [{ kind: "tool", ok: true, result: { activeCartId: CART, itemCount: 2 } }] });

    // ตะกร้าใบอื่นกลาง session = ปฏิเสธ
    const switched = await route.route.POST(post({
      requestId: "req-12345679",
      tool: "pos.get_current_order",
      args: { activeCartId: "cart-xxxxxxxx", cartVersion: 4, summary: { itemCount: 0, total: 0, locked: false } },
    }));
    expect((await switched.json())).toMatchObject({ outcomes: [{ kind: "error", ok: false, code: "CONTEXT_UNAVAILABLE" }] });

    // version ย้อนหลัง = ปฏิเสธ
    const stale = await route.route.POST(post({
      requestId: "req-12345680",
      tool: "pos.get_current_order",
      args: { activeCartId: CART, cartVersion: 2, summary: { itemCount: 2, total: 110, locked: false } },
    }));
    expect((await stale.json())).toMatchObject({ outcomes: [{ kind: "error", ok: false, code: "CONTEXT_UNAVAILABLE" }] });

    // replay ของ request เดิม (ตะกร้า+version เดิม) = ผลเดิมจาก ledger
    const replay = await route.route.POST(post({
      requestId: "req-12345678",
      tool: "pos.get_current_order",
      args: { activeCartId: CART, cartVersion: 3, summary: { itemCount: 2, total: 110, locked: false } },
    }));
    expect((await replay.json())).toMatchObject({ outcomes: [{ kind: "tool", ok: true }] });
    expect(route.loadCatalog).not.toHaveBeenCalled();
  });
});

// PR3 — composition root ต้องผูก DurableIdempotencyStore (durability "supabase") เข้า dispatcher
// ผ่าน service client เดิมของ repo: พิสูจน์ด้วย ledger จริง (fake table) + เกต production
describe("durable idempotency wiring (PR3)", () => {
  it("claims idempotency through the supabase-backed ledger instead of the memory store", async () => {
    const route = await loadRoute();
    const first = await route.route.POST(post({ requestId: "req-12345678", tool: "pos.search_product", args: { query: "ลาเต้" } }));
    expect(first.status).toBe(200);
    // memory store ไม่แตะ DB เลย — มีแถวลงตาราง = claim เดินผ่าน DurableIdempotencyStore จริง
    expect(route.db.rows).toHaveLength(1);
    expect(route.db.rows[0]).toMatchObject({
      organization_id: "org-1",
      store_id: "store-1",
      user_id: "user-1",
      idempotency_key: "req-12345678",
      tool: "pos.search_product",
      status: "completed",
    });

    // replay คีย์เดิม (fingerprint + identity เดิม) = ผลจาก ledger ไม่ execute ซ้ำ
    const replay = await route.route.POST(post({ requestId: "req-12345678", tool: "pos.search_product", args: { query: "ลาเต้" } }));
    expect((await replay.json())).toMatchObject({ outcomes: [{ kind: "tool", ok: true, tool: "pos.search_product" }] });
    expect(route.loadCatalog).toHaveBeenCalledTimes(1);
    expect(route.db.rows).toHaveLength(1);
  });

  it("unlocks production safe_write when the mutation env is on top of the wired durable store", async () => {
    // production + durable wired + env เปิด → ผ่านเกต DURABLE_STORAGE_REQUIRED และถึง execute จริง
    const unlocked = await loadRoute({ nodeEnv: "production", mutationsEnabled: true });
    const response = await unlocked.route.POST(post(textBody));
    expect(response.status).toBe(200);
    const body = await response.json();
    // fixture ลาเต้ไม่มี variants/modifierGroups → resolver คืน apply (พิสูจน์ว่า tool ถูก execute ในฐานะ safe_write)
    expect(body.outcomes[0]).toMatchObject({ kind: "tool", ok: true, tool: "pos.add_item" });
    expect(body.outcomes[0].result).toMatchObject({ status: "apply", productName: "ลาเต้" });
    expect(unlocked.db.rows).toHaveLength(1);
    expect(unlocked.db.rows[0]).toMatchObject({ tool: "pos.add_item", status: "completed" });
  });

  it("keeps production mutations closed when only the durable store is wired (env off)", async () => {
    // wiring อย่างเดียว (ไม่ตั้ง env) = production ยังปิด mutation เหมือนเดิม และไม่แตะ ledger
    const locked = await loadRoute({ nodeEnv: "production" });
    const denied = await locked.route.POST(post(textBody));
    const deniedBody = await denied.json();
    expect(deniedBody.outcomes[0]).toMatchObject({ kind: "error", ok: false, code: "MUTATIONS_DISABLED" });
    expect(deniedBody.outcomes[0].code).not.toBe("DURABLE_STORAGE_REQUIRED");
    expect(locked.db.rows).toHaveLength(0);
  });

  it("answers typed 503 when dispatcher creation fails and retries on the next request", async () => {
    // service client พังครั้งแรก → 503 ที่มี reason (ไม่ใช่ 500 เปล่า) และ memoize ถูก reset
    const route = await loadRoute({ serviceClientRejectOnce: true });
    const first = await route.route.POST(post({ requestId: "req-12345678", tool: "pos.search_product", args: { query: "ลาเต้" } }));
    expect(first.status).toBe(503);
    expect(await first.json()).toMatchObject({ ok: false, reason: "assistant_unavailable" });

    // request ถัดไปลองสร้าง dispatcher ใหม่ได้จริง (ไม่ติด rejection เดิมตลอดอายุ process)
    const second = await route.route.POST(post({ requestId: "req-12345679", tool: "pos.search_product", args: { query: "ลาเต้" } }));
    expect(second.status).toBe(200);
    expect((await second.json())).toMatchObject({ outcomes: [{ kind: "tool", ok: true, tool: "pos.search_product" }] });
    expect(route.db.rows).toHaveLength(1);
  });
});
