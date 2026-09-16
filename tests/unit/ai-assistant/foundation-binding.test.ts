import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { DEFAULT_BILLING_STATE } from "@/modules/billing/types";
import {
  createDispatcher,
  ToolRegistry,
  type AuditMetadata,
  type CartBinding,
  type TrustedContext,
} from "@/modules/ai-assistant/foundation";

// PR2 — เกต binding ของ foundation: tool ที่ requiresActiveCart ต้องได้ CartBinding
// ที่ server ตรวจแล้วเท่านั้น ไม่มี resolver / ตรวจไม่ผ่าน = CONTEXT_UNAVAILABLE เสมอ

const request = (args = { value: "hello" }) => ({ tool: "test.cart", args, idempotencyKey: "key" });

function setup(options: { binding?: CartBinding | null; withResolver?: boolean } = {}) {
  const ctx: TrustedContext = { organizationId: "org", storeId: "store", userId: "user", sessionId: "session", expiresAt: Date.now() + 60000, allowedTools: ["test.read", "test.cart"], billing: { ...DEFAULT_BILLING_STATE, plan: "enterprise", status: "active" }, can: () => true };
  const execute = vi.fn(async (_args: unknown, _context: TrustedContext, binding: CartBinding | null) => ({ bound: binding?.activeCartId ?? null }));
  const audit = vi.fn(async (metadata: AuditMetadata) => { void metadata; });
  const registry = new ToolRegistry("test");
  registry.register({
    name: "test.cart",
    risk: "read",
    permissions: ["pos.use"],
    requiresActiveCart: true,
    args: z.object({ value: z.string() }).strict(),
    result: z.object({ bound: z.string().nullish() }),
    execute,
  });
  const readExecute = vi.fn(async (_args: unknown, _context: TrustedContext, binding: CartBinding | null) => ({ bound: binding?.activeCartId ?? null }));
  registry.register({
    name: "test.read",
    risk: "read",
    permissions: [],
    args: z.object({}).strict(),
    result: z.object({ bound: z.string().nullish() }),
    execute: readExecute,
  });
  const bindingCalls = vi.fn(async (): Promise<CartBinding | null> => ("binding" in options ? options.binding ?? null : { activeCartId: "cart-12345678", cartVersion: 1 }));
  const dispatch = createDispatcher({
    registry,
    enabled: true,
    environment: "test",
    resolveContext: async () => ctx,
    audit,
    resolveCartBinding: options.withResolver === false ? undefined : bindingCalls,
  });
  return { ctx, execute, readExecute, audit, bindingCalls, dispatch };
}
beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllEnvs());

describe("foundation cart binding gate (PR2)", () => {
  it("passes the validated binding into execute for cart tools", async () => {
    const s = setup();
    expect(await s.dispatch(request())).toEqual({ ok: true, data: { bound: "cart-12345678" } });
    expect(s.bindingCalls).toHaveBeenCalledTimes(1);
    expect(s.execute.mock.calls[0][2]).toEqual({ activeCartId: "cart-12345678", cartVersion: 1 });
  });

  it("hands null binding to tools that do not require a cart", async () => {
    const s = setup();
    expect(await s.dispatch({ tool: "test.read", args: {}, idempotencyKey: "read" })).toEqual({ ok: true, data: { bound: null } });
    expect(s.bindingCalls).not.toHaveBeenCalled();
  });

  it("denies cart tools when no binding resolver is wired (PR1 fail-closed keeps holding)", async () => {
    const s = setup({ withResolver: false });
    expect(await s.dispatch(request())).toEqual({ ok: false, code: "CONTEXT_UNAVAILABLE" });
    expect(s.execute).not.toHaveBeenCalled();
    expect(s.audit.mock.calls[0][0]).toMatchObject({ outcome: "CONTEXT_UNAVAILABLE", tool: "test.cart" });
  });

  it("denies when the resolver rejects or throws", async () => {
    expect(await setup({ binding: null }).dispatch(request())).toEqual({ ok: false, code: "CONTEXT_UNAVAILABLE" });
    const throwing = setup();
    throwing.bindingCalls.mockRejectedValue(Error("binding secret"));
    expect(await throwing.dispatch(request())).toEqual({ ok: false, code: "CONTEXT_UNAVAILABLE" });
    expect(throwing.execute).not.toHaveBeenCalled();
  });

  it("does not consume the idempotency key on a binding denial", async () => {
    const s = setup({ binding: null });
    expect(await s.dispatch(request())).toEqual({ ok: false, code: "CONTEXT_UNAVAILABLE" });
    expect(await s.dispatch(request())).toEqual({ ok: false, code: "CONTEXT_UNAVAILABLE" });
    expect(await setup().dispatch(request())).toEqual({ ok: true, data: { bound: "cart-12345678" } });
  });

  it("re-resolves the binding on replay instead of trusting the first one", async () => {
    const s = setup();
    expect((await s.dispatch(request())).ok).toBe(true);
    s.bindingCalls.mockResolvedValue(null);
    expect(await s.dispatch(request())).toEqual({ ok: false, code: "CONTEXT_UNAVAILABLE" });
    expect(s.execute).toHaveBeenCalledTimes(1);
  });

  it("does not record cart binding for safe_write commands the mutation gate denies (M4 review)", async () => {
    const ctx: TrustedContext = { organizationId: "org", storeId: "store", userId: "user", sessionId: "session", expiresAt: Date.now() + 60000, allowedTools: ["test.write"], billing: { ...DEFAULT_BILLING_STATE, plan: "enterprise", status: "active" }, can: () => true };
    const bindingCalls = vi.fn(async (): Promise<CartBinding | null> => ({ activeCartId: "cart-12345678", cartVersion: 1 }));
    const execute = vi.fn(async () => ({ ok: true }));
    const registry = new ToolRegistry("test");
    registry.register({
      name: "test.write",
      risk: "safe_write",
      permissions: [],
      requiresActiveCart: true,
      args: z.object({}).strict(),
      result: z.object({ ok: z.boolean() }),
      execute,
    });
    const dispatch = createDispatcher({
      registry,
      enabled: true,
      environment: "test",
      mutationsEnabled: false,
      resolveContext: async () => ctx,
      audit: vi.fn(async () => {}),
      resolveCartBinding: bindingCalls,
    });
    expect(await dispatch({ tool: "test.write", args: {}, idempotencyKey: "w1" })).toEqual({ ok: false, code: "MUTATIONS_DISABLED" });
    expect(bindingCalls).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
});
