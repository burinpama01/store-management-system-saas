import { describe, expect, it } from "vitest";
import { createAssistantSessionStore, type AssistantSessionContext } from "@/modules/ai-assistant/session";

// PR2 — session + cart binding ฝั่ง server: session ผูกกับ identity, ตะกร้าผูกใบเดียวต่อ session,
// version ห้ามย้อนหลัง และความจุเต็มต้อง fail closed

const CART_A = "cart-aaaaaaaa";
const CART_B = "cart-bbbbbbbb";

function setup(options: Parameters<typeof createAssistantSessionStore>[0] = {}) {
  const clock = options?.clock ?? (() => 1_000);
  return { store: createAssistantSessionStore({ clock, ...options }), clock };
}

const identity = (overrides: Partial<{ organizationId: string; storeId: string; userId: string }> = {}) => ({
  organizationId: "org",
  storeId: "store",
  userId: "user",
  ...overrides,
});

const contextOf = (session: { organizationId: string; storeId: string; userId: string; id: string }): AssistantSessionContext => ({
  organizationId: session.organizationId,
  storeId: session.storeId,
  userId: session.userId,
  sessionId: session.id,
});

describe("assistant session store", () => {
  it("keeps one stable session per identity and separates identities", async () => {
    const { store } = setup();
    const first = await store.resolve(identity());
    const again = await store.resolve(identity());
    expect(again.id).toBe(first.id);
    expect(again.expiresAt).toBe(first.expiresAt);
    const otherUser = await store.resolve(identity({ userId: "user-2" }));
    const otherStore = await store.resolve(identity({ storeId: "store-2" }));
    const otherOrg = await store.resolve(identity({ organizationId: "org-2" }));
    expect(new Set([first.id, otherUser.id, otherStore.id, otherOrg.id]).size).toBe(4);
  });

  it("issues a new session id after expiry instead of sliding the old one", async () => {
    let now = 1_000;
    const store = createAssistantSessionStore({ sessionTtlMs: 500, clock: () => now });
    const first = await store.resolve(identity());
    now += 400;
    expect((await store.resolve(identity())).id).toBe(first.id);
    now += 200;
    const second = await store.resolve(identity());
    expect(second.id).not.toBe(first.id);
    expect(second.expiresAt).toBe(now + 500);
  });

  it("rejects incomplete identities", async () => {
    const { store } = setup();
    await expect(store.resolve(identity({ userId: "" }))).rejects.toThrow();
    await expect(store.resolve({ organizationId: "org", storeId: "store", userId: "x".repeat(200) })).rejects.toThrow();
  });

  it("fails closed when the session capacity is full of live sessions", async () => {
    const store = createAssistantSessionStore({ maxSessions: 2, clock: () => 1_000 });
    await store.resolve(identity({ userId: "u1" }));
    await store.resolve(identity({ userId: "u2" }));
    await expect(store.resolve(identity({ userId: "u3" }))).rejects.toThrow();
    expect(store.size()).toBe(2);
  });

  it("reclaims expired sessions on access so a full store never stays stuck", async () => {
    let now = 1_000;
    const store = createAssistantSessionStore({ maxSessions: 2, sessionTtlMs: 100, clock: () => now });
    await store.resolve(identity({ userId: "u1" }));
    await store.resolve(identity({ userId: "u2" }));
    now += 200;
    const fresh = await store.resolve(identity({ userId: "u3" }));
    expect(store.size()).toBe(1);
    expect((await store.resolve(identity({ userId: "u3" }))).id).toBe(fresh.id);
  });
});

describe("assistant cart binding", () => {
  it("binds the first cart and returns the validated binding", async () => {
    const { store } = setup();
    const session = await store.resolve(identity());
    expect(store.bindCart(contextOf(session), CART_A, 0)).toEqual({ activeCartId: CART_A, cartVersion: 0 });
  });

  it("rejects malformed cart ids and versions", async () => {
    const { store } = setup();
    const session = await store.resolve(identity());
    const ctx = contextOf(session);
    for (const bad of ["short", "has space", "x".repeat(200), "", "cart!@#$%^&*()", 42, null, undefined]) {
      expect(store.bindCart(ctx, bad, 0)).toBeNull();
    }
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "3", null]) {
      expect(store.bindCart(ctx, CART_A, bad)).toBeNull();
    }
  });

  it("denies a session that belongs to another identity or does not exist", async () => {
    const { store } = setup();
    const session = await store.resolve(identity());
    const ctx = contextOf(session);
    expect(store.bindCart({ ...ctx, userId: "other" }, CART_A, 0)).toBeNull();
    expect(store.bindCart({ ...ctx, storeId: "other" }, CART_A, 0)).toBeNull();
    expect(store.bindCart({ ...ctx, organizationId: "other" }, CART_A, 0)).toBeNull();
    expect(store.bindCart({ ...ctx, sessionId: "not-a-session" }, CART_A, 0)).toBeNull();
  });

  it("keeps one cart per session: switching carts mid-session is denied", async () => {
    const { store } = setup();
    const session = await store.resolve(identity());
    const ctx = contextOf(session);
    expect(store.bindCart(ctx, CART_A, 0)).not.toBeNull();
    expect(store.bindCart(ctx, CART_B, 1)).toBeNull();
    expect(store.bindCart(ctx, CART_A, 1)).toEqual({ activeCartId: CART_A, cartVersion: 1 });
  });

  it("denies stale cart versions but allows the same version twice", async () => {
    const { store } = setup();
    const session = await store.resolve(identity());
    const ctx = contextOf(session);
    expect(store.bindCart(ctx, CART_A, 5)).toEqual({ activeCartId: CART_A, cartVersion: 5 });
    expect(store.bindCart(ctx, CART_A, 5)).toEqual({ activeCartId: CART_A, cartVersion: 5 });
    expect(store.bindCart(ctx, CART_A, 4)).toBeNull();
    expect(store.bindCart(ctx, CART_A, 6)).toEqual({ activeCartId: CART_A, cartVersion: 6 });
  });

  it("denies binding for an expired session", async () => {
    let now = 1_000;
    const store = createAssistantSessionStore({ sessionTtlMs: 100, clock: () => now });
    const session = await store.resolve(identity());
    const ctx = contextOf(session);
    now += 200;
    expect(store.bindCart(ctx, CART_A, 0)).toBeNull();
    expect(store.size()).toBe(0);
  });

  it("validates its own options", () => {
    expect(() => createAssistantSessionStore({ sessionTtlMs: 0 })).toThrow();
    expect(() => createAssistantSessionStore({ maxSessions: -1 })).toThrow();
    expect(() => createAssistantSessionStore({ allowedTools: [""] })).toThrow();
  });
});
