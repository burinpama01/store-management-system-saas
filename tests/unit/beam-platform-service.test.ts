import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PlatformBillingOrder } from "@/modules/billing/beam-billing-types";

const m = vi.hoisted(() => ({ rows: [] as PlatformBillingOrder[], create: vi.fn(), get: vi.fn(), preflight: vi.fn(), rpc: vi.fn(), signature: vi.fn(), slip: vi.fn(), config: vi.fn(), quote: vi.fn() }));
vi.mock("@/modules/payments/beam-client", () => ({ createBeamQrCharge: m.create, getBeamCharge: m.get, checkBeamAvailability: m.preflight }));
vi.mock("@/modules/payments/credentials", () => ({ decodeBeamCredentials: () => ({ merchantId: "platform", apiKey: "fixture", webhookHmacKey: "fixture" }) }));
vi.mock("@/modules/payments/beam-signature", () => ({ verifyBeamSignature: m.signature }));
vi.mock("@/modules/billing/beam-settings", () => ({ getPlatformBeamSettings: m.config }));
vi.mock("@/modules/billing/platform-settings", () => ({ getPlatformSettings: async () => ({ promptpayId: "0812345678" }) }));
vi.mock("@/modules/billing/pricing-repository", () => ({ getUpgradeQuote: m.quote, getBusinessUpgradeQuote: m.quote }));
vi.mock("@/modules/billing/slip2go", () => ({ verifyBillingSlipByImage: m.slip, isSlip2goConfigured: () => true }));
vi.mock("@/server/integrations/supabase/server", () => ({ createSupabaseServiceClient: async () => ({
  rpc: m.rpc,
  from: () => {
    const filters: ((r: PlatformBillingOrder) => boolean)[] = [];
    let patch: Partial<PlatformBillingOrder> | null = null;
    const run = () => {
      const found = m.rows.filter((r) => filters.every((f) => f(r)));
      if (patch) found.forEach((r) => Object.assign(r, patch));
      return { data: found[0] ? { ...found[0] } : null, error: null };
    };
    const q = {
      select: () => q,
      eq: (key: keyof PlatformBillingOrder, value: unknown) => { filters.push((r) => r[key] === value); return q; },
      in: (key: keyof PlatformBillingOrder, values: unknown[]) => { filters.push((r) => values.includes(r[key])); return q; },
      update: (value: Partial<PlatformBillingOrder>) => { patch = value; return q; },
      insert: async (row: PlatformBillingOrder) => { m.rows.push({ ...row }); return { error: null }; },
      single: async () => run(), maybeSingle: async () => run(),
      then: (resolve: (v: ReturnType<typeof run>) => unknown) => Promise.resolve(run()).then(resolve),
    };
    return q;
  },
}) }));

import { createPlatformBillingOrder, getPendingPlatformBillingOrder, processPlatformBeamWebhook, refreshPlatformBillingOrder, verifyPlatformBillingSlip } from "@/modules/billing/beam-billing";

const fixture = (): PlatformBillingOrder => ({ id: "11111111-1111-4111-8111-111111111111", organization_id: "org-a", submitted_by: "actor", plan: "starter", duration: "30d", amount: 690, discount_code_id: null, discount_amount: 0, business_seats: null, business_stores: null, business_features: [], term_days: null, term_ends_at: null, method: "beam", environment: "live", credentials_encrypted: "secret-snapshot", receiver_account: "1234567890", qr_payload: null, qr_image: null, charge_id: "ch_1", creation_attempted: false, status: "pending", created_at: "2026-09-21T00:00:00Z", expires_at: "2026-09-21T00:15:00Z", paid_at: null, new_expiry: null });
const input = { organizationId: "org-a", submittedByUserId: "actor", plan: "starter" as const, duration: "30d" as const };
beforeEach(() => {
  vi.clearAllMocks(); m.rows = [fixture()];
  m.config.mockResolvedValue({ billing_provider: "beam", beam_environment: "live", beam_fallback_enabled: true, beam_fallback_account: "1234567890", beam_credentials_encrypted: "secret-snapshot", creds: { merchantId: "platform", apiKey: "fixture", webhookHmacKey: "fixture" } });
  m.quote.mockResolvedValue({ finalAmount: 690, discount: 0, discountCode: null, discountRejection: null });
  m.preflight.mockResolvedValue({ ok: true, data: true });
  m.get.mockResolvedValue({ ok: true, data: { chargeId: "ch_1", referenceId: fixture().id, status: "SUCCEEDED", currency: "THB", amountSatang: 69000 } });
  m.signature.mockReturnValue(true);
  m.rpc.mockImplementation(async (_name, args) => { const row = m.rows.find((r) => r.id === args.p_order_id)!; row.status = row.environment === "test" ? "test_paid" : "paid"; return { error: null }; });
});

describe("platform billing service boundaries", () => {
  it("checks Beam before creating the payment and automatically uses PromptPay when unavailable", async () => {
    m.rows = [];
    m.preflight.mockResolvedValue({ ok: false, status: 0, error: "offline" });
    const result = await createPlatformBillingOrder(input);
    expect(m.preflight).toHaveBeenCalledOnce();
    expect(result.method).toBe("slip");
    expect(result.qr_payload).toBeTruthy();
    expect(m.create).not.toHaveBeenCalled();
    expect(m.rows).toHaveLength(1);
  });
  it("finishes the read-only readiness check before persisting or posting a charge", async () => {
    m.rows = [];
    m.preflight.mockImplementation(async () => { expect(m.rows).toHaveLength(0); expect(m.create).not.toHaveBeenCalled(); return { ok: true, data: true }; });
    m.create.mockResolvedValue({ ok: true, data: { chargeId: "ch_new", qrPayload: "qr", qrImageBase64: null } });
    expect((await createPlatformBillingOrder(input)).method).toBe("beam");
    expect(m.preflight).toHaveBeenCalledOnce();
  });
  it("does not reroute an existing pending payment when preflight would fail", async () => {
    m.preflight.mockResolvedValue({ ok: false, status: 503 });
    expect((await createPlatformBillingOrder(input)).method).toBe("beam");
    expect(m.preflight).not.toHaveBeenCalled();
  });
  it("settles verified Beam through atomic RPC and exposes no credentials", async () => {
    const result = await refreshPlatformBillingOrder(fixture().id, "org-a");
    expect(result.status).toBe("paid");
    expect(result).not.toHaveProperty("credentials_encrypted");
    expect(m.rpc).toHaveBeenCalledWith("settle_platform_billing_order", { p_order_id: fixture().id, p_method: "beam", p_ref: "ch_1", p_amount: 690 });
  });
  it("denies another organization before any Beam lookup", async () => {
    await expect(refreshPlatformBillingOrder(fixture().id, "org-b")).rejects.toThrow();
    expect(m.get).not.toHaveBeenCalled(); expect(m.rpc).not.toHaveBeenCalled();
  });
  it("does not settle a wrong currency", async () => {
    m.get.mockResolvedValue({ ok: true, data: { chargeId: "ch_1", referenceId: fixture().id, status: "SUCCEEDED", currency: "USD", amountSatang: 69000 } });
    await refreshPlatformBillingOrder(fixture().id, "org-a"); expect(m.rpc).not.toHaveBeenCalled();
  });
  it("keeps pending on lookup timeout", async () => {
    m.get.mockResolvedValue({ ok: false, status: 0 });
    await expect(refreshPlatformBillingOrder(fixture().id, "org-a")).rejects.toThrow();
    expect(m.rows[0].status).toBe("pending"); expect(m.rpc).not.toHaveBeenCalled();
  });
  it("resumes existing pending order instead of switching to fallback or charging twice", async () => {
    expect((await createPlatformBillingOrder(input)).id).toBe(fixture().id);
    expect(m.create).not.toHaveBeenCalled();
  });
  it("retries uncertain creation with the persisted reference and idempotency key", async () => {
    m.rows[0].status = "creating"; m.rows[0].charge_id = null;
    m.create.mockResolvedValue({ ok: false, status: 0 });
    await expect(refreshPlatformBillingOrder(fixture().id, "org-a")).rejects.toThrow();
    await expect(refreshPlatformBillingOrder(fixture().id, "org-a")).rejects.toThrow();
    expect(m.create.mock.calls.map(([arg]) => arg.idempotencyKey)).toEqual([fixture().id, fixture().id]);
    expect(m.rows[0].status).toBe("creating");
  });
  it("writes the order before creating a provider charge", async () => {
    m.rows = [];
    m.create.mockImplementation(async (arg) => { expect(m.rows[0].id).toBe(arg.referenceId); return { ok: false, status: 0 }; });
    await expect(createPlatformBillingOrder(input)).rejects.toThrow();
    expect(m.rows).toHaveLength(1); expect(m.rows[0].status).toBe("creating");
  });
  it("cannot unlock fallback after an uncertain creation followed by a 400", async () => {
    m.rows[0].status = "creating"; m.rows[0].charge_id = null;
    m.create.mockResolvedValueOnce({ ok: false, status: 0 }).mockResolvedValueOnce({ ok: false, status: 400 });
    await expect(refreshPlatformBillingOrder(fixture().id, "org-a")).rejects.toThrow();
    await expect(refreshPlatformBillingOrder(fixture().id, "org-a")).rejects.toThrow();
    expect(m.rows[0].status).toBe("creating");
  });
  it("rejects invalid webhook signatures before lookup or settlement", async () => {
    m.signature.mockReturnValue(false);
    await expect(processPlatformBeamWebhook(JSON.stringify({ referenceId: fixture().id, merchantId: "platform", chargeId: "ch_1" }), "invalid")).rejects.toThrow("invalid_signature");
    expect(m.get).not.toHaveBeenCalled(); expect(m.rpc).not.toHaveBeenCalled();
  });
  it("recovers webhook when the create response was lost", async () => {
    m.rows[0].charge_id = null; m.rows[0].status = "creating";
    expect((await processPlatformBeamWebhook(JSON.stringify({ referenceId: fixture().id, merchantId: "platform", chargeId: "ch_1" }), "signed")).status).toBe("paid");
    expect(m.create).not.toHaveBeenCalled();
  });
  it("retains pending order after changing provider", async () => {
    m.config.mockResolvedValue({ billing_provider: "promptpay" });
    expect((await getPendingPlatformBillingOrder("org-a"))?.id).toBe(fixture().id);
  });
  it("blocks real fallback in playground", async () => {
    m.rows = [];
    m.config.mockResolvedValue({ billing_provider: "beam", beam_environment: "test", beam_fallback_enabled: true });
    await expect(createPlatformBillingOrder(input)).rejects.toThrow("Production");
  });
  it("will not credit a slip against a Beam order", async () => {
    await expect(verifyPlatformBillingSlip(fixture().id, "org-a", "image", "image/png")).rejects.toThrow();
    expect(m.slip).not.toHaveBeenCalled();
  });
  it("closes expired slip orders only when explicitly refreshed", async () => {
    m.rows[0].method = "slip"; m.rows[0].expires_at = "2020-01-01T00:00:00Z";
    expect((await refreshPlatformBillingOrder(fixture().id, "org-a")).status).toBe("failed");
    await expect(verifyPlatformBillingSlip(fixture().id, "org-a", "image", "image/png")).rejects.toThrow("ปิดแล้ว");
  });
});

describe("Beam billing webhook route must stay public (HMAC auth in handler)", () => {
  const { readFileSync } = require("node:fs") as typeof import("node:fs");
  const { resolve } = require("node:path") as typeof import("node:path");
  it("middleware allows /api/billing/beam/webhook without a session", () => {
    const middleware = readFileSync(resolve(process.cwd(), "src/server/integrations/supabase/middleware.ts"), "utf8");
    expect(middleware).toContain('request.nextUrl.pathname === "/api/billing/beam/webhook"');
  });
  it("handler rejects requests without a signature before doing any work", () => {
    const route = readFileSync(resolve(process.cwd(), "src/app/api/billing/beam/webhook/route.ts"), "utf8");
    expect(route).toContain('x-beam-signature');
    expect(route).toContain('status: 401');
  });
});
