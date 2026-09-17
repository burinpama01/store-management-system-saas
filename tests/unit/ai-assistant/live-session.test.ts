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

describe("live session token (HMAC, stateless)", () => {
  const SECRET = "unit-test-secret-0123456789";
  const claims = {
    sessionId: "sess-1",
    organizationId: "org-1",
    storeId: "store-1",
    userId: "user-1",
    activeCartId: "cart-12345678",
    allowedTools: ["pos.search_product", "pos.add_item"],
    maxToolCalls: 40,
    expiresAt: Date.now() + 600_000,
  };

  it("พก identity ของเซสชันไปกับ token — relay จึงไม่ต้องพึ่ง state ของ instance", () => {
    const token = createLiveSessionToken(claims, SECRET);

    expect(token).toMatch(/^v1\.[A-Za-z0-9_-]+\.[0-9a-f]{64}$/);
    expect(verifyLiveSessionToken(token, SECRET)).toEqual(claims);
  });

  it("แก้ payload แม้แต่ตัวเดียว = ลายเซ็นไม่ผ่าน (ยกระดับสิทธิ์/ต่ออายุเองไม่ได้)", () => {
    const token = createLiveSessionToken(claims, SECRET);
    const [, payloadB64, mac] = token.split(".");

    // ย้ายเซสชันไปอีกร้าน
    const otherStore = Buffer.from(JSON.stringify({
      sid: "sess-1", org: "org-1", st: "store-9", uid: "user-1",
      cart: "cart-12345678", tl: ["pos.add_item"], cap: 40, exp: claims.expiresAt,
    }), "utf8").toString("base64url");
    expect(verifyLiveSessionToken(`v1.${otherStore}.${mac}`, SECRET)).toBeNull();

    // ขยายเพดาน/อายุเอง
    const inflated = Buffer.from(JSON.stringify({
      sid: "sess-1", org: "org-1", st: "store-1", uid: "user-1",
      cart: "cart-12345678", tl: ["pos.add_item"], cap: 99_999, exp: claims.expiresAt + 86_400_000,
    }), "utf8").toString("base64url");
    expect(verifyLiveSessionToken(`v1.${inflated}.${mac}`, SECRET)).toBeNull();

    expect(verifyLiveSessionToken(`v1.${payloadB64}.${mac.slice(0, -2)}ff`, SECRET)).toBeNull();
    expect(verifyLiveSessionToken(token, "other-secret-0123456789")).toBeNull();
  });

  it("หมดอายุแล้วใช้ไม่ได้ แม้ลายเซ็นถูกต้อง (ไม่มีการต่ออายุจากฝั่ง client)", () => {
    const expired = createLiveSessionToken({ ...claims, expiresAt: 1_000 }, SECRET);

    expect(verifyLiveSessionToken(expired, SECRET)).toBeNull();
    expect(verifyLiveSessionToken(expired, SECRET, 500)).toMatchObject({ sessionId: "sess-1" });
  });

  it("รูปทรงผิดถูกปฏิเสธทันที และ payload ที่ไม่ครบต้องไม่ผ่าน", () => {
    expect(verifyLiveSessionToken("", SECRET)).toBeNull();
    expect(verifyLiveSessionToken("no-dot", SECRET)).toBeNull();
    expect(verifyLiveSessionToken("v2.abcdefgh.".padEnd(75, "0"), SECRET)).toBeNull();
    expect(verifyLiveSessionToken(`v1.abcdefgh.${"g".repeat(64)}`, SECRET)).toBeNull();

    // payload ที่เซ็นถูกต้องแต่ฟิลด์ไม่ครบ = ปฏิเสธ (กัน token รุ่นเก่า/ของที่สร้างผิด)
    const partial = Buffer.from(JSON.stringify({ sid: "sess-1", exp: claims.expiresAt }), "utf8").toString("base64url");
    const mac = createLiveSessionToken(claims, SECRET).split(".")[2];
    expect(verifyLiveSessionToken(`v1.${partial}.${mac}`, SECRET)).toBeNull();
  });

  it("ปฏิเสธการสร้าง token จากข้อมูลที่ใช้ไม่ได้ (fail closed ตั้งแต่ต้นทาง)", () => {
    expect(() => createLiveSessionToken({ ...claims, activeCartId: "สั้น" }, SECRET)).toThrow();
    expect(() => createLiveSessionToken({ ...claims, allowedTools: [] }, SECRET)).toThrow();
    expect(() => createLiveSessionToken(claims, "")).toThrow();
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
