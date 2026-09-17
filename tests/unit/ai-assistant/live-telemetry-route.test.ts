import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// PR3-Live (diagnostics) — POST /api/ai-assistant/live/telemetry
// ประเด็นที่ต้องปักหมุด: identity มาจาก server เท่านั้น, ชื่อ event เป็น allowlist ปิด,
// ฟิลด์ต้องห้าม (token/transcript/args) ถูก "ปฏิเสธ" ไม่ใช่ strip เงียบ ๆ

interface Options {
  authed?: boolean;
  diagnosticsEnabled?: boolean;
  rateLimitPerMinute?: number;
}

const ORG = "org-1";
const STORE = "store-1";
const USER = "user-1";

async function loadRoute(options: Options = {}) {
  const { authed = true, diagnosticsEnabled = true, rateLimitPerMinute } = options;

  vi.resetModules();
  const logSystemEvent = vi.fn().mockResolvedValue(undefined);

  vi.doMock("@/modules/auth/guards", () => ({
    getResolvedCurrentPermissions: vi.fn(async () => (authed
      ? {
        ctx: { organizationId: ORG, storeId: STORE, userId: USER },
        user: { id: USER },
        resolved: { can: () => true, organizationId: ORG, storeId: STORE },
      }
      : null)),
  }));
  vi.doMock("@/modules/billing/billing-service", () => ({
    getOrganizationBillingState: vi.fn().mockResolvedValue({ plan: "enterprise", status: "active" }),
  }));
  vi.doMock("@/modules/system/event-log", () => ({ logSystemEvent }));
  vi.doMock("@/modules/ai-assistant/tools/pos-tools-server", () => ({
    createServerPosToolDeps: () => ({ loadCatalog: vi.fn(async () => ({ products: [], aliases: [] })) }),
  }));
  vi.doMock("@/server/integrations/supabase/server", () => ({
    createSupabaseServiceClient: vi.fn(async () => {
      throw new Error("fake db: telemetry route must not touch supabase");
    }),
  }));

  vi.stubEnv("AI_ASSISTANT_LIVE_DIAGNOSTICS_ENABLED", diagnosticsEnabled ? "true" : "");
  if (rateLimitPerMinute) {
    vi.stubEnv("AI_ASSISTANT_LIVE_TELEMETRY_RATE_LIMIT_PER_MINUTE", String(rateLimitPerMinute));
  }

  const route = await import("@/app/api/ai-assistant/live/telemetry/route");
  return { route, logSystemEvent };
}

const post = (body: unknown) =>
  new Request("http://localhost/api/ai-assistant/live/telemetry", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const validEvent = {
  event: "audio.play_blocked",
  stage: "audio",
  result: "blocked",
  reason: "autoplay_blocked",
  sessionId: "sess-1234abcd",
};

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
});

describe("live telemetry route — ด่าน", () => {
  it("ยังไม่ล็อกอิน = 401 และไม่มีอะไรถูกบันทึก", async () => {
    const { route, logSystemEvent } = await loadRoute({ authed: false });

    const response = await route.POST(post({ events: [validEvent] }));

    expect(response.status).toBe(401);
    expect(logSystemEvent).not.toHaveBeenCalled();
  });

  it("ร้านที่ไม่ได้เปิดโหมดวินิจฉัย = 503 (ไม่เก็บ event ละเอียดของทุก org)", async () => {
    const { route, logSystemEvent } = await loadRoute({ diagnosticsEnabled: false });

    const response = await route.POST(post({ events: [validEvent] }));

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ reason: "diagnostics_disabled" });
    expect(logSystemEvent).not.toHaveBeenCalled();
  });

  it("ส่งถี่เกินเพดาน = 429", async () => {
    const { route } = await loadRoute({ rateLimitPerMinute: 2 });

    expect((await route.POST(post({ events: [validEvent] }))).status).toBe(200);
    expect((await route.POST(post({ events: [validEvent] }))).status).toBe(200);
    const third = await route.POST(post({ events: [validEvent] }));

    expect(third.status).toBe(429);
    expect(await third.json()).toMatchObject({ reason: "rate_limited" });
  });
});

describe("live telemetry route — รูปทรงและความเป็นส่วนตัว", () => {
  it("event ที่ไม่อยู่ใน allowlist = 400 (กัน log กลายเป็นขยะ)", async () => {
    const { route, logSystemEvent } = await loadRoute();

    const response = await route.POST(post({ events: [{ ...validEvent, event: "live.something_new" }] }));

    expect(response.status).toBe(400);
    expect(logSystemEvent).not.toHaveBeenCalled();
  });

  it("body พัง/ว่าง/เกินจำนวน event = 400", async () => {
    const { route } = await loadRoute();

    expect((await route.POST(post("not-json"))).status).toBe(400);
    expect((await route.POST(post({ events: [] }))).status).toBe(400);
    expect((await route.POST(post({ events: [validEvent], extra: true }))).status).toBe(400);
    expect((await route.POST(post({ events: Array.from({ length: 51 }, () => validEvent) }))).status).toBe(400);
  });

  it("payload ใหญ่เกินเพดาน = 400 (ไม่ต้อง parse ให้เปลืองแรง)", async () => {
    const { route } = await loadRoute();
    const huge = { events: [{ ...validEvent, metadata: { note: "x".repeat(20_000) } }] };

    const response = await route.POST(post(huge));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ reason: "payload_too_large" });
  });

  it("ฟิลด์ต้องห้ามถูกปฏิเสธทั้งก้อน — ทั้งใน metadata และในตัว event", async () => {
    const { route, logSystemEvent } = await loadRoute();

    for (const metadata of [
      { sessionToken: "v1.aaa.bbb" },
      { ephemeralToken: "ek_secret" },
      { apiKey: "sk-test" },
      { authorization: "Bearer x" },
      { transcript: "เพิ่มลาเต้ 2 แก้ว" },
      { userText: "เพิ่มลาเต้" },
      { rawAudio: "AAAA" },
      { audioBlob: "AAAA" },
      { args: "{}" },
      { rawArgs: "{}" },
      { modelRawResponse: "..." },
    ]) {
      const response = await route.POST(post({ events: [{ ...validEvent, metadata }] }));
      expect(response.status, JSON.stringify(metadata)).toBe(400);
      expect(await response.json()).toMatchObject({ reason: "forbidden_field" });
    }

    expect(logSystemEvent).not.toHaveBeenCalled();
  });

  it("ค่าที่อนุญาตถูกบันทึก และ identity มาจาก server เสมอ (browser ปลอมไม่ได้)", async () => {
    const { route, logSystemEvent } = await loadRoute();

    const response = await route.POST(post({
      events: [{
        ...validEvent,
        durationMs: 1200,
        cartVersion: 3,
        metadata: { tool: "pos.add_item", httpStatus: 401, blocked: true, note: null },
        // ค่าปลอมของ browser — schema เป็น strict จึงถูกปฏิเสธ ไม่ใช่ถูกเชื่อ
      }],
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, accepted: 1 });
    expect(logSystemEvent).toHaveBeenCalledTimes(1);
    expect(logSystemEvent).toHaveBeenCalledWith(expect.objectContaining({
      source: "ai.assistant",
      action: "liveDiag",
      level: "warn",
      organizationId: ORG,
      storeId: STORE,
      actorUserId: USER,
      context: expect.objectContaining({
        event: "audio.play_blocked",
        stage: "audio",
        result: "blocked",
        reason: "autoplay_blocked",
        sessionId: "sess-1234abcd",
        durationMs: 1200,
        cartVersion: 3,
        tool: "pos.add_item",
        httpStatus: 401,
      }),
    }));
  });

  it("identity ที่ browser แนบมาเองถูกปฏิเสธ (strict schema) ไม่ใช่เอาไปใช้", async () => {
    const { route, logSystemEvent } = await loadRoute();

    const response = await route.POST(post({
      events: [{ ...validEvent, organizationId: "org-attacker", storeId: "store-x", userId: "user-x" }],
    }));

    expect(response.status).toBe(400);
    expect(logSystemEvent).not.toHaveBeenCalled();
  });

  it("หลาย event ในคำขอเดียวถูกบันทึกครบตามลำดับ", async () => {
    const { route, logSystemEvent } = await loadRoute();

    const response = await route.POST(post({
      events: [
        { event: "wake.detected", stage: "wake", result: "success" },
        { event: "wake.route_live", stage: "wake", result: "success" },
        { event: "live.session_created", stage: "session", result: "success", sessionId: "sess-1234abcd" },
      ],
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ accepted: 3 });
    expect(logSystemEvent).toHaveBeenCalledTimes(3);
    expect(logSystemEvent.mock.calls.map((call) => (call[0] as { context: { event: string } }).context.event))
      .toEqual(["wake.detected", "wake.route_live", "live.session_created"]);
  });
});
