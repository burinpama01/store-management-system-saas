import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createDispatcher, registerDevelopmentEcho, ToolRegistry, type TrustedContext, type ToolDefinition } from "@/modules/ai-assistant/foundation";
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
  it("protects replay from mutation by callers", async () => { const s = setup(); const first = await s.dispatch(request()); if (first.ok) (first.data as { count: number }).count = 99; expect(await s.dispatch(request())).toEqual({ ok: true, data: { count: 1 } }); });
  it("sanitizes invalid handler output", async () => { const s = setup({ execute: async () => ({ count: "secret" }) }); expect(await s.dispatch(request())).toEqual({ ok: false, code: "EXECUTION_FAILED" }); });
  it.each([null, {}, { ...context(), allowedTools: null }, { ...context(), can: null }])("sanitizes malformed trusted context %j", async value => { const s = setup(); const dispatch = createDispatcher({ registry: s.registry, enabled: true, environment: "test", resolveContext: async () => value as TrustedContext, audit: s.audit }); expect(await dispatch(request())).toEqual({ ok: false, code: "CONTEXT_UNAVAILABLE" }); });
  it("sanitizes resolver errors", async () => { const s = setup(); const dispatch = createDispatcher({ registry: s.registry, enabled: true, environment: "test", resolveContext: async () => { throw Error("secret"); }, audit: s.audit }); expect(await dispatch(request())).toEqual({ ok: false, code: "CONTEXT_UNAVAILABLE" }); });
  it("defaults disabled and supports a runtime kill switch even on replay", async () => { const s = setup(); let enabled = false; const base = { registry: s.registry, environment: "test" as const, resolveContext: async () => s.ctx, audit: s.audit }; expect(await createDispatcher(base)(request())).toEqual({ ok: false, code: "FEATURE_DISABLED" }); const dispatch = createDispatcher({ ...base, enabled: () => enabled }); enabled = true; expect((await dispatch(request())).ok).toBe(true); enabled = false; expect(await dispatch(request())).toEqual({ ok: false, code: "FEATURE_DISABLED" }); expect(s.execute).toHaveBeenCalledTimes(1); });
  it("defaults mutations disabled and rechecks the mutation switch on replay", async () => { const s = setup({ risk: "safe_write" }); expect(await s.dispatch(request())).toEqual({ ok: false, code: "MUTATIONS_DISABLED" }); let enabled = true; const dispatch = createDispatcher({ registry: s.registry, environment: "test", enabled: true, mutationsEnabled: () => enabled, resolveContext: async () => s.ctx, audit: s.audit }); expect((await dispatch(request())).ok).toBe(true); enabled = false; expect(await dispatch(request())).toEqual({ ok: false, code: "MUTATIONS_DISABLED" }); expect(s.execute).toHaveBeenCalledTimes(1); });
  it("executes echo only in development/test and denies mismatched production dispatcher", async () => { const registry = new ToolRegistry("test"); registerDevelopmentEcho(registry); const ctx = { ...context(), allowedTools: ["system.echo"] }; const base = { registry, enabled: true, resolveContext: async () => ctx, audit: async () => {} }; const input = { tool: "system.echo", args: { message: "hello" }, idempotencyKey: "echo" }; expect(await createDispatcher({ ...base, environment: "test" })(input)).toEqual({ ok: true, data: { message: "hello" } }); expect(await createDispatcher({ ...base, environment: "production" })(input)).toEqual({ ok: false, code: "RISK_BLOCKED" }); expect(() => registerDevelopmentEcho(new ToolRegistry("production"))).toThrow(); });
});
