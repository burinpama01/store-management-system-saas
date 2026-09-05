import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const user = { id: "user-1" };
const ctx = { userId: "user-1", organizationId: "org-1", storeId: "store-1" };

const envelope = {
  version: 1,
  outcome: "command_batch",
  commands: [{ intent: "pos.add_item", productPhrase: "ลาเต้", quantity: 2, optionPhrases: [] }],
  confidence: "high",
  reasonCode: "matched",
};

type Options = {
  authed?: boolean;
  canUsePos?: boolean;
  planHasAi?: boolean;
  aiEnabled?: boolean;
  quotaGranted?: boolean;
  interpret?: unknown;
};

async function loadRoute(options: Options = {}) {
  const {
    authed = true,
    canUsePos = true,
    planHasAi = true,
    aiEnabled = true,
    quotaGranted = true,
    interpret = { ok: true, envelope, tokens: 88 },
  } = options;

  vi.resetModules();
  const reserveQuota = vi.fn().mockResolvedValue({ granted: quotaGranted });
  const settleUsage = vi.fn().mockResolvedValue({ ok: true, error: null });
  const interpretVoiceIntent = vi.fn().mockResolvedValue(interpret);
  const logSystemEvent = vi.fn().mockResolvedValue(undefined);

  vi.doMock("@/modules/auth/guards", () => ({
    getResolvedCurrentPermissions: vi
      .fn()
      .mockResolvedValue(authed ? { ctx, user, resolved: { can: () => canUsePos } } : null),
  }));
  vi.doMock("@/modules/billing/billing-service", () => ({
    getOrganizationBillingState: vi.fn().mockResolvedValue({ plan: "enterprise", status: "active" }),
  }));
  vi.doMock("@/modules/billing/types", () => ({ canUseFeature: () => planHasAi }));
  vi.doMock("@/modules/ai/gateway", () => ({ AI_DEFAULT_MODEL: "gpt-4o-mini", isAiEnabled: () => aiEnabled }));
  vi.doMock("@/modules/ai/voice-intent", async () => {
    const actual = await vi.importActual<typeof import("@/modules/ai/voice-intent")>("@/modules/ai/voice-intent");
    return { ...actual, interpretVoiceIntent };
  });
  vi.doMock("@/modules/ai/quota", () => ({ AI_MAX_OUTPUT_TOKENS: 600, reserveQuota, settleUsage }));
  vi.doMock("@/modules/system/event-log", () => ({ logSystemEvent }));

  const route = await import("@/app/api/ai/voice-intent/route");
  return { route, reserveQuota, settleUsage, interpretVoiceIntent, logSystemEvent };
}

const post = (body: unknown) =>
  new Request("http://localhost/api/ai/voice-intent", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const validBody = {
  requestId: "req-12345678",
  utterance: "ลาเต้สองแก้ว",
  locale: "th-TH",
  origin: "push_to_talk",
};

// ไม่แตะ process.env: isAiEnabled ถูก mock ทุกเคสอยู่แล้ว การ set/delete env ที่นี่
// เคยทำให้ผลไม่นิ่งเมื่อรันพร้อมไฟล์อื่นที่ใช้ตัวแปรเดียวกัน
beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

describe("POST /api/ai/voice-intent — ด่านความปลอดภัย", () => {
  it("ไม่ได้ล็อกอิน = 401 และไม่แตะ quota เลย", async () => {
    const { route, reserveQuota, interpretVoiceIntent } = await loadRoute({ authed: false });
    const res = await route.POST(post(validBody));
    expect(res.status).toBe(401);
    expect(reserveQuota).not.toHaveBeenCalled();
    expect(interpretVoiceIntent).not.toHaveBeenCalled();
  });

  it("ไม่มีสิทธิ์ pos.use = 403", async () => {
    const { route, interpretVoiceIntent } = await loadRoute({ canUsePos: false });
    expect((await route.POST(post(validBody))).status).toBe(403);
    expect(interpretVoiceIntent).not.toHaveBeenCalled();
  });

  it("แพ็กเกจไม่รวม AI = 403 พร้อมทางออกด้วยมือ", async () => {
    const { route } = await loadRoute({ planHasAi: false });
    const res = await route.POST(post(validBody));
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ ok: false, reason: "ai_not_in_plan" });
  });

  it("ระบบ AI ปิด = 503", async () => {
    const { route } = await loadRoute({ aiEnabled: false });
    expect((await route.POST(post(validBody))).status).toBe(503);
  });

  it("โควตาหมด = 429 และไม่เรียกผู้ให้บริการ", async () => {
    const { route, interpretVoiceIntent } = await loadRoute({ quotaGranted: false });
    expect((await route.POST(post(validBody))).status).toBe(429);
    expect(interpretVoiceIntent).not.toHaveBeenCalled();
  });

  it("timeout = 504 และคง reservation ไว้ให้ reconcile", async () => {
    const { route, settleUsage } = await loadRoute({ interpret: { ok: false, reason: "ai_timeout" } });
    expect((await route.POST(post(validBody))).status).toBe(504);
    expect(settleUsage).not.toHaveBeenCalled();
  });
});

describe("POST /api/ai/voice-intent — body และคำตอบ", () => {
  it("ปฏิเสธ body ที่ผิดรูป/มีคีย์เกิน/คำพูดยาวเกิน", async () => {
    const { route, reserveQuota } = await loadRoute();
    for (const bad of [
      "not json",
      { ...validBody, extra: 1 },
      { ...validBody, utterance: "" },
      { ...validBody, utterance: "ก".repeat(501) },
      { ...validBody, locale: "ja-JP" },
      { ...validBody, origin: "standby" },
      { ...validBody, requestId: "short" },
    ]) {
      const res = await route.POST(post(bad));
      expect(res.status, JSON.stringify(bad).slice(0, 60)).toBe(400);
    }
    expect(reserveQuota).not.toHaveBeenCalled();
  });

  it("สำเร็จ = คืน envelope, no-store และไม่ echo คำพูดกลับ", async () => {
    const { route, settleUsage } = await loadRoute();
    const res = await route.POST(post(validBody));
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");

    const json = await res.json();
    expect(json).toMatchObject({ ok: true, intent: envelope });
    expect(JSON.stringify(json)).not.toContain("ลาเต้สองแก้ว");
    expect(settleUsage).toHaveBeenCalledWith(expect.objectContaining({ status: "ok", tokens: 88 }));
  });

  it("request hash มาจาก requestId ไม่ใช่คำพูด", async () => {
    const { route, settleUsage } = await loadRoute();
    await route.POST(post(validBody));
    const first = settleUsage.mock.calls[0][0].requestHash;

    const second = await loadRoute();
    await second.route.POST(post({ ...validBody, utterance: "อเมริกาโน่หนึ่งแก้ว" }));
    expect(second.settleUsage.mock.calls[0][0].requestHash).toBe(first);
  });

  it("log ไม่มีคำพูดของผู้ใช้ ทั้งทางสำเร็จและทางล้มเหลว", async () => {
    const ok = await loadRoute();
    await ok.route.POST(post(validBody));
    expect(JSON.stringify(ok.logSystemEvent.mock.calls)).not.toContain("ลาเต้");

    const bad = await loadRoute({ interpret: { ok: false, reason: "ai_error" } });
    const res = await bad.route.POST(post(validBody));
    expect(res.status).toBe(502);
    expect(JSON.stringify(bad.logSystemEvent.mock.calls)).not.toContain("ลาเต้");
    // ห้ามส่งข้อความ error ดิบของผู้ให้บริการกลับไป
    await expect(res.json()).resolves.toMatchObject({ ok: false, reason: "ai_error" });
  });
});
