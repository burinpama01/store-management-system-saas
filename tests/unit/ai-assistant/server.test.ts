import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { DEFAULT_BILLING_STATE } from "@/modules/billing/types";
import { ToolRegistry } from "@/modules/ai-assistant/foundation";
import { createServerAssistantDispatcher, writeAssistantAudit } from "@/modules/ai-assistant/server";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), billing: vi.fn(), log: vi.fn() }));
vi.mock("@/modules/auth/guards", () => ({ getResolvedCurrentPermissions: mocks.auth }));
vi.mock("@/modules/billing/billing-service", () => ({ getOrganizationBillingState: mocks.billing }));
vi.mock("@/modules/system/event-log", () => ({ logSystemEvent: mocks.log }));

const identity = { organizationId: "org", storeId: "store", userId: "user" };
const session = () => ({ ...identity, id: "server-session", expiresAt: Date.now()+60000, allowedTools: ["test.read"] });
const request = { tool: "test.read", args: {}, idempotencyKey: "key" };
function setup(resolveSession = vi.fn(async () => session())) {
  const registry = new ToolRegistry("test");
  const execute = vi.fn(async () => ({ count: 1 }));
  registry.register({ name: "test.read", risk: "read", permissions: ["pos.use"], args: z.object({}).strict(), result: z.object({ count: z.number() }), execute });
  return { execute, resolveSession, dispatch: createServerAssistantDispatcher({ registry, resolveSession }) };
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NODE_ENV", "test"); vi.stubEnv("AI_ASSISTANT_ENABLED", "true"); vi.stubEnv("AI_ASSISTANT_KILL_SWITCH", "false");
  mocks.auth.mockResolvedValue({ user: { id: identity.userId }, ctx: { organizationId: identity.organizationId, storeId: identity.storeId }, resolved: { organizationId: identity.organizationId, storeId: identity.storeId, can: () => true } });
  mocks.billing.mockResolvedValue({ ...DEFAULT_BILLING_STATE, plan: "enterprise", status: "active" });
  mocks.log.mockResolvedValue(undefined);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
describe("server assistant adapter", () => {
  it("derives identity and billing using existing server guards", async () => {
    const s = setup(); expect(await s.dispatch(request)).toEqual({ ok: true, data: { count: 1 } });
    expect(s.resolveSession).toHaveBeenCalledWith(identity); expect(mocks.billing).toHaveBeenCalledWith("org");
    expect(s.execute.mock.calls[0]).toBeDefined();
  });
  it.each(["organizationId", "storeId", "userId"] as const)("denies mismatched session %s", async field => { const s = setup(vi.fn(async () => ({ ...session(), [field]: "other" }))); expect(await s.dispatch(request)).toEqual({ ok: false, code: "CONTEXT_UNAVAILABLE" }); expect(s.execute).not.toHaveBeenCalled(); });
  it("rechecks server permission on replay", async () => { const s = setup(); await s.dispatch(request); const auth = await mocks.auth(); auth.resolved.can = () => false; expect(await s.dispatch(request)).toEqual({ ok: false, code: "PERMISSION_DENIED" }); expect(s.execute).toHaveBeenCalledTimes(1); });
  it("rereads server kill switch on replay", async () => { const s = setup(); await s.dispatch(request); vi.stubEnv("AI_ASSISTANT_KILL_SWITCH", "true"); expect(await s.dispatch(request)).toEqual({ ok: false, code: "FEATURE_DISABLED" }); expect(s.execute).toHaveBeenCalledTimes(1); });
  it("denies browser runtime before auth resolution", async () => { vi.stubGlobal("window", {}); const s = setup(); expect(await s.dispatch(request)).toEqual({ ok: false, code: "CONTEXT_UNAVAILABLE" }); expect(mocks.auth).not.toHaveBeenCalled(); });
  it("sanitizes auth failure and missing billing", async () => { const s = setup(); mocks.auth.mockRejectedValueOnce(Error("secret")); expect(await s.dispatch(request)).toEqual({ ok: false, code: "CONTEXT_UNAVAILABLE" }); mocks.billing.mockResolvedValueOnce(null); expect(await s.dispatch(request)).toEqual({ ok: false, code: "CONTEXT_UNAVAILABLE" }); });
  it("writes only allowlisted audit metadata", async () => {
    await writeAssistantAudit({ ...identity, actorUserId: "user", tool: "test.read", risk: "read", outcome: "success", args: { password: "secret" }, result: "raw", error: "private" } as never);
    const log = mocks.log.mock.calls[0][0];
    expect(log.context).toEqual({ tool: "test.read", risk: "read", outcome: "success" });
    expect(JSON.stringify(log)).not.toMatch(/password|secret|private|raw/);
  });
  it("swallows audit failure without changing replay", async () => { const s = setup(); mocks.log.mockRejectedValue(Error("failure")); expect((await s.dispatch(request)).ok).toBe(true); expect((await s.dispatch(request)).ok).toBe(true); expect(s.execute).toHaveBeenCalledTimes(1); });
});
