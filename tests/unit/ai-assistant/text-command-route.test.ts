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

async function loadRoute(options: Options = {}) {
  const {
    authed = true,
    canUsePos = true,
    planHasAi = true,
    aiEnabled = true,
    quotaGranted = true,
    quotaThrows = false,
    assistantEnabled = true,
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
  // ปิด kill switch ให้เส้นทางปกติผ่าน (หรือเปิดไว้เพื่อทดสอบ 503)
  vi.stubEnv("AI_ASSISTANT_ENABLED", assistantEnabled ? "true" : "");

  const route = await import("@/app/api/ai-assistant/text-command/route");
  return { route, reserveQuota, settleUsage, interpretVoiceIntent, logSystemEvent, loadCatalog };
}

interface Options {
  authed?: boolean;
  canUsePos?: boolean;
  planHasAi?: boolean;
  aiEnabled?: boolean;
  quotaGranted?: boolean;
  quotaThrows?: boolean;
  assistantEnabled?: boolean;
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
