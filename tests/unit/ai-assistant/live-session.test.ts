import { describe, expect, it } from "vitest";
import {
  createLiveSessionStore,
  createLiveSessionToken,
  resolveLiveTokenSecret,
  verifyLiveSessionToken,
} from "@/modules/ai-assistant/live-session";

// PR3-Live (M3) — เซสชันเสียงสด: concurrent cap ต่อร้าน, tool call cap ต่อเซสชัน,
// หมดอายุแบบไม่ต่ออายุเด็ดขาด, และ session token แบบ HMAC ผูก session id ตายตัว

const IDENTITY = { organizationId: "org-1", storeId: "store-1", userId: "user-1" };
const CART = "cart-12345678";
const TOOLS = ["pos.search_product", "pos.add_item"];

function createStore(overrides: { maxConcurrentPerStore?: number; maxToolCallsPerSession?: number } = {}) {
  let now = 1_000_000;
  const store = createLiveSessionStore({
    maxConcurrentPerStore: overrides.maxConcurrentPerStore ?? 2,
    maxToolCallsPerSession: overrides.maxToolCallsPerSession ?? 3,
    clock: () => now,
  });
  return { store, advance: (ms: number) => { now += ms; }, now: () => now };
}

describe("live session store", () => {
  it("creates a frozen session bound to identity/cart/tools and keeps TTL fixed", () => {
    const { store } = createStore();
    const created = store.create(IDENTITY, { ttlMs: 15 * 60_000, activeCartId: CART, allowedTools: TOOLS });
    if (!created.ok) throw new Error("create should succeed");
    expect(created.session.organizationId).toBe("org-1");
    expect(created.session.storeId).toBe("store-1");
    expect(created.session.userId).toBe("user-1");
    expect(created.session.activeCartId).toBe(CART);
    expect(created.session.allowedTools).toEqual(TOOLS);
    expect(created.session.expiresAt - created.session.startedAt).toBe(15 * 60_000);
    expect(Object.isFrozen(created.session)).toBe(true);
    expect(store.get(created.session.id)?.id).toBe(created.session.id);
  });

  it("rejects malformed identity, cart id, and options instead of guessing", () => {
    const { store } = createStore();
    expect(store.create({ ...IDENTITY, organizationId: "" }, { ttlMs: 1000, activeCartId: CART, allowedTools: TOOLS })).toMatchObject({ ok: false, reason: "invalid_identity" });
    expect(store.create(IDENTITY, { ttlMs: 1000, activeCartId: "short", allowedTools: TOOLS })).toMatchObject({ ok: false, reason: "invalid_cart" });
    expect(store.create(IDENTITY, { ttlMs: 0, activeCartId: CART, allowedTools: TOOLS })).toMatchObject({ ok: false, reason: "invalid_options" });
    expect(store.create(IDENTITY, { ttlMs: 1000, activeCartId: CART, allowedTools: [""] })).toMatchObject({ ok: false, reason: "invalid_options" });
  });

  it("enforces the concurrent cap per store and frees the slot on end/expiry", () => {
    const { store, advance } = createStore({ maxConcurrentPerStore: 1 });
    const first = store.create(IDENTITY, { ttlMs: 60_000, activeCartId: CART, allowedTools: TOOLS });
    expect(first.ok).toBe(true);
    expect(store.create(IDENTITY, { ttlMs: 60_000, activeCartId: CART, allowedTools: TOOLS })).toMatchObject({ ok: false, reason: "store_busy" });

    // ร้านอื่นไม่โดน cap ของร้านนี้
    expect(store.create({ ...IDENTITY, storeId: "store-2" }, { ttlMs: 60_000, activeCartId: CART, allowedTools: TOOLS })).toMatchObject({ ok: true });

    // ปิดเซสชันเดิมแล้วเปิดใหม่ได้
    const ended = store.end((first as { session: { id: string } }).session.id);
    expect(ended).not.toBeNull();
    expect(store.create(IDENTITY, { ttlMs: 60_000, activeCartId: CART, allowedTools: TOOLS })).toMatchObject({ ok: true });

    // หมดอายุ = slot ถูกคืนเอง
    advance(60_001);
    expect(store.create(IDENTITY, { ttlMs: 60_000, activeCartId: CART, allowedTools: TOOLS })).toMatchObject({ ok: true });
  });

  it("drops expired sessions on read and never extends their life", () => {
    const { store, advance } = createStore();
    const created = store.create(IDENTITY, { ttlMs: 5_000, activeCartId: CART, allowedTools: TOOLS });
    if (!created.ok) throw new Error("create should succeed");
    advance(5_001);
    expect(store.get(created.session.id)).toBeNull();
    expect(store.consumeToolCall(created.session.id)).toMatchObject({ ok: false, reason: "unknown_session" });
    expect(store.end(created.session.id)).toBeNull();
  });

  it("counts every tool call attempt including the one that hits the cap", () => {
    const { store } = createStore({ maxToolCallsPerSession: 2 });
    const created = store.create(IDENTITY, { ttlMs: 60_000, activeCartId: CART, allowedTools: TOOLS });
    if (!created.ok) throw new Error("create should succeed");
    expect(store.consumeToolCall(created.session.id)).toMatchObject({ ok: true, used: 1 });
    expect(store.consumeToolCall(created.session.id)).toMatchObject({ ok: true, used: 2 });
    expect(store.consumeToolCall(created.session.id)).toMatchObject({ ok: false, reason: "cap_reached" });
    expect(store.consumeToolCall("missing")).toMatchObject({ ok: false, reason: "unknown_session" });
  });

  it("end returns a metering summary once and removes the session", () => {
    const { store, advance } = createStore();
    const created = store.create(IDENTITY, { ttlMs: 60_000, activeCartId: CART, allowedTools: TOOLS });
    if (!created.ok) throw new Error("create should succeed");
    store.consumeToolCall(created.session.id);
    store.consumeToolCall(created.session.id);
    advance(2_500);
    const summary = store.end(created.session.id);
    expect(summary?.session.id).toBe(created.session.id);
    expect(summary?.toolCallsUsed).toBe(2);
    expect(summary?.sessionSeconds).toBe(3);
    expect(store.end(created.session.id)).toBeNull();
    expect(store.get(created.session.id)).toBeNull();
    expect(store.size()).toBe(0);
  });
});

describe("live session token (HMAC)", () => {
  const SECRET = "unit-test-secret-0123456789";

  it("round-trips a token bound to its session id", () => {
    const token = createLiveSessionToken("sess-1", 5_000_000, SECRET);
    expect(token).toMatch(/^\d+\.[0-9a-f]{64}$/);
    expect(verifyLiveSessionToken(token, "sess-1", SECRET)).toBe(true);
  });

  it("rejects a token used for a different session, tampered, or signed by another secret", () => {
    const token = createLiveSessionToken("sess-1", 5_000_000, SECRET);
    expect(verifyLiveSessionToken(token, "sess-2", SECRET)).toBe(false);
    const [exp, mac] = token.split(".");
    expect(verifyLiveSessionToken(`${exp}.${mac.slice(0, -2)}ff`, "sess-1", SECRET)).toBe(false);
    expect(verifyLiveSessionToken(token, "sess-1", "other-secret-0123456789")).toBe(false);
    // expiresAt ใน token ถูกแก้ = ลายเซ็นไม่ตรง ไม่มีทางขยายอายุได้
    expect(verifyLiveSessionToken(`9999999999999.${mac}`, "sess-1", SECRET)).toBe(false);
  });

  it("rejects malformed tokens outright", () => {
    expect(verifyLiveSessionToken("", "sess-1", SECRET)).toBe(false);
    expect(verifyLiveSessionToken("no-dot", "sess-1", SECRET)).toBe(false);
    expect(verifyLiveSessionToken("abc.nothex", "sess-1", SECRET)).toBe(false);
    expect(verifyLiveSessionToken(`.abc.${"0".repeat(64)}`, "sess-1", SECRET)).toBe(false);
    expect(verifyLiveSessionToken(`${Date.now()}.${"g".repeat(64)}`, "sess-1", SECRET)).toBe(false);
  });
});

describe("resolveLiveTokenSecret", () => {
  it("prefers the explicit AI_ASSISTANT_LIVE_TOKEN_SECRET", () => {
    expect(resolveLiveTokenSecret({
      AI_ASSISTANT_LIVE_TOKEN_SECRET: "explicit-secret-0123456789",
      OPENAI_API_KEY: "sk-test-abcdefgh123456",
    })).toBe("explicit-secret-0123456789");
  });

  it("falls back to the server-only provider key and fails closed without any", () => {
    expect(resolveLiveTokenSecret({ OPENAI_API_KEY: "sk-test-abcdefgh123456" })).toBe("openai-fallback:sk-test-abcdefgh123456");
    expect(resolveLiveTokenSecret({})).toBeNull();
    expect(resolveLiveTokenSecret({ AI_ASSISTANT_LIVE_TOKEN_SECRET: "short", OPENAI_API_KEY: "short" })).toBeNull();
  });
});
