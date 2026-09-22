import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createDispatcher, MemoryIdempotencyStore, registerDevelopmentEcho, ToolRegistry, type IdempotencyClaimMeta, type Result, type TrustedContext, type ToolDefinition } from "@/modules/ai-assistant/foundation";
import { DEFAULT_BILLING_STATE } from "@/modules/billing/types";

const context = (): TrustedContext => ({ organizationId: "org", storeId: "store", userId: "user", sessionId: "session", expiresAt: Date.now() + 60000, allowedTools: ["test.read", "test.write", "test.other"], billing: { ...DEFAULT_BILLING_STATE, plan: "enterprise", status: "active" }, can: () => true });
const request = (tool = "test.read", args = { value: "hello" }) => ({ tool, args, idempotencyKey: "key" });
function setup(overrides: Partial<ToolDefinition> = {}, options: { production?: boolean; capacity?: number } = {}) {
  const ctx = context();
  const execute = vi.fn(async () => ({ count: 1, secret: "never return" }));
  const audit = vi.fn(async () => {});
  const registry = new ToolRegistry(options.production ? "production" : "test");
  registry.register({ name: "test.read", risk: "read", permissions: ["pos.use"], args: z.object({ value: z.string() }).strict(), result: z.object({ count: z.number() }), execute, ...overrides });
  const dispatch = createDispatcher({ registry, enabled: true, environment: options.production ? "production" : "test", resolveContext: async () => ctx, audit, capacity: options.capacity });
  return { ctx, execute, audit, dispatch, registry };
}
describe("assistant trust boundary", () => {
  it("executes validated read and strips undeclared result fields", async () => {
    const s = setup(); expect(await s.dispatch(request())).toEqual({ ok: true, data: { count: 1 } });
  });
  it("rejects model context and confirmation injection", async () => {
    const s = setup(); expect(await s.dispatch({ ...request(), confirmed: true, storeId: "other" })).toEqual({ ok: false, code: "INVALID_REQUEST" }); expect(s.execute).not.toHaveBeenCalled();
  });
  it.each([ ["unknown", request("unknown.tool"), "UNKNOWN_TOOL"], ["args", request("test.read", { value: 2 } as never), "INVALID_ARGS"] ])("denies %s", async (_label, input, code) => { const s = setup(); expect(await s.dispatch(input)).toEqual({ ok: false, code }); expect(s.execute).not.toHaveBeenCalled(); });
  it("rechecks permission and entitlement on replay", async () => {
    const s = setup(); await s.dispatch(request()); s.ctx.can = () => false;
    expect(await s.dispatch(request())).toEqual({ ok: false, code: "PERMISSION_DENIED" });
    s.ctx.can = () => true; s.ctx.billing = DEFAULT_BILLING_STATE;
    expect(await s.dispatch(request())).toEqual({ ok: false, code: "FEATURE_DISABLED" }); expect(s.execute).toHaveBeenCalledTimes(1);
  });
  it.each(["critical", "sensitive"] as const)("denies %s before execution", async risk => { const s = setup({ risk }); expect(await s.dispatch(request())).toEqual({ ok: false, code: "RISK_BLOCKED" }); expect(s.execute).not.toHaveBeenCalled(); });
  it("denies absent active cart binding", async () => { const s = setup({ requiresActiveCart: true }); expect(await s.dispatch(request())).toEqual({ ok: false, code: "CONTEXT_UNAVAILABLE" }); });
  it("denies production writes without durable idempotency", async () => { const s = setup({ risk: "safe_write" }, { production: true }); expect(await s.dispatch(request())).toEqual({ ok: false, code: "DURABLE_STORAGE_REQUIRED" }); });
  it("atomically deduplicates concurrent calls and rejects changed args", async () => {
    const s = setup(); await Promise.all([s.dispatch(request()), s.dispatch(request())]); expect(s.execute).toHaveBeenCalledTimes(1);
    expect(await s.dispatch(request("test.read", { value: "changed" }))).toEqual({ ok: false, code: "IDEMPOTENCY_CONFLICT" });
  });
  it("does not execute twice after handler or audit failures and logs no payload", async () => {
    const execute = vi.fn(async () => { throw Error("private raw secret"); });
    const s = setup({ execute }); s.audit.mockRejectedValue(Error("audit unavailable"));
    expect(await s.dispatch(request())).toEqual({ ok: false, code: "EXECUTION_FAILED" }); expect(await s.dispatch(request())).toEqual({ ok: false, code: "EXECUTION_FAILED" });
    expect(JSON.stringify(s.audit.mock.calls)).not.toMatch(/hello|private|raw|secret|value/);
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it("fails closed at memory capacity without evicting completed writes", async () => { const s = setup({}, { capacity: 1 }); await s.dispatch(request()); expect(await s.dispatch({ ...request(), idempotencyKey: "next" })).toEqual({ ok: false, code: "CAPACITY_EXCEEDED" }); expect(s.execute).toHaveBeenCalledTimes(1); });
  it("rejects expired or disallowed sessions", async () => { const s = setup(); s.ctx.expiresAt = 0; expect(await s.dispatch(request())).toEqual({ ok: false, code: "CONTEXT_UNAVAILABLE" }); s.ctx.expiresAt = Date.now()+1000; s.ctx.allowedTools=[]; expect(await s.dispatch(request())).toEqual({ ok: false, code: "PERMISSION_DENIED" }); });
  it("registry rejects duplicate tools and development tools in production", () => { const s = setup({}, { production: true }); expect(() => s.registry.register({ name: "system.echo", developmentOnly: true } as ToolDefinition)).toThrow(); });
  it.each(["organizationId", "storeId", "userId", "sessionId"] as const)("isolates idempotency by %s", async field => { const s = setup(); await s.dispatch(request()); s.ctx[field] = "different"; await s.dispatch(request()); expect(s.execute).toHaveBeenCalledTimes(2); });
  it("canonicalizes reordered object keys", async () => { const s = setup({ args: z.object({ a: z.number(), b: z.number() }).strict() }); await s.dispatch({ ...request(), args: { a: 1, b: 2 } }); expect(await s.dispatch({ ...request(), args: { b: 2, a: 1 } })).toEqual({ ok: true, data: { count: 1 } }); expect(s.execute).toHaveBeenCalledTimes(1); });
  it.each([NaN, Infinity, new Date(), new Map(), undefined])("rejects non-JSON parsed arguments %j", async value => { const s = setup({ args: z.unknown() }); expect(await s.dispatch({ ...request(), args: value })).toEqual({ ok: false, code: "INVALID_ARGS" }); expect(s.execute).not.toHaveBeenCalled(); });
  it("rejects key reuse with a different tool", async () => { const s = setup(); s.registry.register({ ...s.registry.get("test.read")!, name: "test.other" }); await s.dispatch(request()); expect(await s.dispatch(request("test.other"))).toEqual({ ok: false, code: "IDEMPOTENCY_CONFLICT" }); expect(s.execute).toHaveBeenCalledTimes(1); });
  it("protects replay from mutation by callers", async () => { const s = setup(); const first = await s.dispatch(request()); if (first.ok && !("kind" in first)) (first.data as { count: number }).count = 99; expect(await s.dispatch(request())).toEqual({ ok: true, data: { count: 1 } }); });
  it("sanitizes invalid handler output", async () => { const s = setup({ execute: async () => ({ count: "secret" }) }); expect(await s.dispatch(request())).toEqual({ ok: false, code: "EXECUTION_FAILED" }); });
  it.each([null, {}, { ...context(), allowedTools: null }, { ...context(), can: null }])("sanitizes malformed trusted context %j", async value => { const s = setup(); const dispatch = createDispatcher({ registry: s.registry, enabled: true, environment: "test", resolveContext: async () => value as TrustedContext, audit: s.audit }); expect(await dispatch(request())).toEqual({ ok: false, code: "CONTEXT_UNAVAILABLE" }); });
  it("sanitizes resolver errors", async () => { const s = setup(); const dispatch = createDispatcher({ registry: s.registry, enabled: true, environment: "test", resolveContext: async () => { throw Error("secret"); }, audit: s.audit }); expect(await dispatch(request())).toEqual({ ok: false, code: "CONTEXT_UNAVAILABLE" }); });
  it("defaults disabled and supports a runtime kill switch even on replay", async () => { const s = setup(); let enabled = false; const base = { registry: s.registry, environment: "test" as const, resolveContext: async () => s.ctx, audit: s.audit }; expect(await createDispatcher(base)(request())).toEqual({ ok: false, code: "FEATURE_DISABLED" }); const dispatch = createDispatcher({ ...base, enabled: () => enabled }); enabled = true; expect((await dispatch(request())).ok).toBe(true); enabled = false; expect(await dispatch(request())).toEqual({ ok: false, code: "FEATURE_DISABLED" }); expect(s.execute).toHaveBeenCalledTimes(1); });
  it("defaults mutations disabled and rechecks the mutation switch on replay", async () => { const s = setup({ risk: "safe_write" }); expect(await s.dispatch(request())).toEqual({ ok: false, code: "MUTATIONS_DISABLED" }); let enabled = true; const dispatch = createDispatcher({ registry: s.registry, environment: "test", enabled: true, mutationsEnabled: () => enabled, resolveContext: async () => s.ctx, audit: s.audit }); expect((await dispatch(request())).ok).toBe(true); enabled = false; expect(await dispatch(request())).toEqual({ ok: false, code: "MUTATIONS_DISABLED" }); expect(s.execute).toHaveBeenCalledTimes(1); });
  it("executes echo only in development/test and denies mismatched production dispatcher", async () => { const registry = new ToolRegistry("test"); registerDevelopmentEcho(registry); const ctx = { ...context(), allowedTools: ["system.echo"] }; const base = { registry, enabled: true, resolveContext: async () => ctx, audit: async () => {} }; const input = { tool: "system.echo", args: { message: "hello" }, idempotencyKey: "echo" }; expect(await createDispatcher({ ...base, environment: "test" })(input)).toEqual({ ok: true, data: { message: "hello" } }); expect(await createDispatcher({ ...base, environment: "production" })(input)).toEqual({ ok: false, code: "RISK_BLOCKED" }); expect(() => registerDevelopmentEcho(new ToolRegistry("production"))).toThrow(); });
});
describe("assistant idempotency capacity", () => {
  const req = (idempotencyKey: string) => ({ tool: "test.read", args: { value: "hello" }, idempotencyKey });
  function capacitySetup(options: { capacity?: number; scopeCapacity?: number } = {}) {
    const execute = vi.fn(async () => ({ count: 1 }));
    const audit = vi.fn(async () => {});
    const registry = new ToolRegistry("test");
    registry.register({ name: "test.read", risk: "read", permissions: ["pos.use"], args: z.object({ value: z.string() }).strict(), result: z.object({ count: z.number() }), execute });
    let current: TrustedContext | undefined;
    const dispatch = createDispatcher({ registry, enabled: true, environment: "test", resolveContext: async () => current as TrustedContext, audit, capacity: options.capacity, scopeCapacity: options.scopeCapacity });
    return { execute, actAs: (ctx: TrustedContext) => { current = ctx; }, dispatch };
  }
  it("fails a full session at its own scope capacity without failing other sessions", async () => {
    const s = capacitySetup({ scopeCapacity: 2 });
    const alice = { ...context(), sessionId: "alice" }; const bob = { ...context(), sessionId: "bob" };
    s.actAs(alice);
    expect((await s.dispatch(req("k1"))).ok).toBe(true);
    expect((await s.dispatch(req("k2"))).ok).toBe(true);
    expect(await s.dispatch(req("k3"))).toEqual({ ok: false, code: "CAPACITY_EXCEEDED" });
    s.actAs(bob);
    expect((await s.dispatch(req("k1"))).ok).toBe(true);
    expect((await s.dispatch(req("k2"))).ok).toBe(true);
    expect(await s.dispatch(req("k3"))).toEqual({ ok: false, code: "CAPACITY_EXCEEDED" });
    s.actAs(alice);
    expect((await s.dispatch(req("k1"))).ok).toBe(true);
    expect(s.execute).toHaveBeenCalledTimes(4);
  });
  it("reclaims entries of expired sessions and still rejects replay of expired contexts", async () => {
    const s = capacitySetup({ scopeCapacity: 1 });
    const ctx = { ...context(), expiresAt: Date.now() + 200 };
    s.actAs(ctx);
    expect((await s.dispatch(req("k1"))).ok).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(await s.dispatch(req("k2"))).toEqual({ ok: false, code: "CONTEXT_UNAVAILABLE" });
    ctx.expiresAt = Date.now() + 60000;
    expect((await s.dispatch(req("k2"))).ok).toBe(true);
    expect(s.execute).toHaveBeenCalledTimes(2);
  });
  it("binds the global backstop before an oversized scope capacity", async () => {
    const s = capacitySetup({ capacity: 2, scopeCapacity: 10 });
    s.actAs({ ...context(), sessionId: "solo" });
    expect((await s.dispatch(req("k1"))).ok).toBe(true);
    expect((await s.dispatch(req("k2"))).ok).toBe(true);
    expect(await s.dispatch(req("k3"))).toEqual({ ok: false, code: "CAPACITY_EXCEEDED" });
    expect((await s.dispatch(req("k1"))).ok).toBe(true);
    expect(s.execute).toHaveBeenCalledTimes(2);
  });
  it("keeps the global backstop across sessions but evicts expired entries before failing", async () => {
    const s = capacitySetup({ capacity: 2, scopeCapacity: 10 });
    s.actAs({ ...context(), sessionId: "soon", expiresAt: Date.now() + 200 });
    expect((await s.dispatch(req("k1"))).ok).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 300));
    const live = { ...context(), sessionId: "live" };
    s.actAs(live);
    expect((await s.dispatch(req("k1"))).ok).toBe(true);
    s.actAs({ ...context(), sessionId: "third" });
    expect((await s.dispatch(req("k1"))).ok).toBe(true);
    s.actAs({ ...context(), sessionId: "fourth" });
    expect(await s.dispatch(req("k1"))).toEqual({ ok: false, code: "CAPACITY_EXCEEDED" });
    s.actAs(live);
    expect((await s.dispatch(req("k1"))).ok).toBe(true);
    expect(s.execute).toHaveBeenCalledTimes(3);
  });
});
describe("MemoryIdempotencyStore", () => {
  const executeOk = (data: string) => async (): Promise<Result> => ({ ok: true, data });
  const meta = (scope: string, expiresAt = Date.now() + 60000): IdempotencyClaimMeta => ({ scope, expiresAt });
  it("keeps scopes independent for keys and capacity", async () => {
    const store = new MemoryIdempotencyStore(10, 1);
    expect((await store.claim("k", "f1", meta("s1"), executeOk("a"))).ok).toBe(true);
    expect(await store.claim("k", "f1", meta("s2"), executeOk("b"))).toEqual({ ok: true, data: "b" });
    expect(await store.claim("k", "f2", meta("s1"), executeOk("c"))).toEqual({ ok: false, code: "IDEMPOTENCY_CONFLICT" });
  });
  it("evicts expired entries in a full scope and keeps live ones", async () => {
    const store = new MemoryIdempotencyStore(10, 1);
    expect((await store.claim("k1", "f", meta("s", Date.now() - 1), executeOk("a"))).ok).toBe(true);
    expect(await store.claim("k2", "f", meta("s"), executeOk("b"))).toEqual({ ok: true, data: "b" });
    expect(await store.claim("k3", "f", meta("s"), executeOk("c"))).toEqual({ ok: false, code: "CAPACITY_EXCEEDED" });
  });
  it("evicts expired entries before failing the global backstop", async () => {
    const store = new MemoryIdempotencyStore(2, 10);
    expect((await store.claim("k1", "f", meta("expired", Date.now() - 1), executeOk("a"))).ok).toBe(true);
    expect((await store.claim("k1", "f", meta("live"), executeOk("b"))).ok).toBe(true);
    expect((await store.claim("k1", "f", meta("third"), executeOk("c"))).ok).toBe(true);
    expect(await store.claim("k1", "f", meta("fourth"), executeOk("d"))).toEqual({ ok: false, code: "CAPACITY_EXCEEDED" });
    expect(await store.claim("k1", "f", meta("live"), executeOk("again"))).toEqual({ ok: true, data: "b" });
  });
  it("refreshes expiry on matching replay but not on conflict", async () => {
    const conflicted = new MemoryIdempotencyStore(10, 1);
    await conflicted.claim("k", "f", meta("s", Date.now() - 1), executeOk("a"));
    expect(await conflicted.claim("k", "f2", meta("s"), executeOk("b"))).toEqual({ ok: false, code: "IDEMPOTENCY_CONFLICT" });
    expect((await conflicted.claim("k2", "f", meta("s"), executeOk("c"))).ok).toBe(true);
    const replayed = new MemoryIdempotencyStore(10, 1);
    await replayed.claim("k", "f", meta("s", Date.now() - 1), executeOk("a"));
    expect(await replayed.claim("k", "f", meta("s"), executeOk("again"))).toEqual({ ok: true, data: "a" });
    expect(await replayed.claim("k2", "f", meta("s"), executeOk("c"))).toEqual({ ok: false, code: "CAPACITY_EXCEEDED" });
  });
  it("rejects invalid claim metadata and capacities", async () => {
    const store = new MemoryIdempotencyStore(2, 10);
    await expect(store.claim("k", "f", { scope: "s", expiresAt: Number.NaN }, executeOk("a"))).rejects.toThrow();
    await expect(store.claim("k", "f", { scope: "", expiresAt: Date.now() + 1000 }, executeOk("a"))).rejects.toThrow();
    expect(() => new MemoryIdempotencyStore(0)).toThrow();
    expect(() => new MemoryIdempotencyStore(10, 0)).toThrow();
  });
});
