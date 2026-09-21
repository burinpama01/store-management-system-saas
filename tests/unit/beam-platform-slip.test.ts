import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyBillingSlipByImage } from "@/modules/billing/slip2go";
import { evaluateBillingSlip } from "@/modules/billing/beam-billing-policy";
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("strict Slip2Go conditions", () => {
  const data = { amount: 690, transRef: "bank-ref", dateTime: "2026-09-21T00:05:00Z", receiver: { account: { bank: { account: "xxx-x-x7890" } } } };
  it("sends receiver and amount to provider and accepts a verified masked response", async () => {
    vi.stubEnv("SLIP2GO_API_KEY", "fixture");
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
      const payload = JSON.parse(String((init.body as FormData).get("payload")));
      expect(payload.checkReceiver).toEqual([{ accountNumber: "1234567890" }]);
      expect(payload.checkAmount).toEqual({ type: "eq", amount: "690" });
      return new Response(JSON.stringify({ code: "200000", data }));
    });
    vi.stubGlobal("fetch", fetcher);
    const slip = await verifyBillingSlipByImage("aW1hZ2U=", "image/png", "1234567890", 690);
    expect(slip.receiverVerified).toBe(true);
    expect(evaluateBillingSlip({ amount: 690, receiver_account: "1234567890", created_at: "2026-09-21T00:00:00Z", expires_at: "2026-09-21T00:15:00Z" }, slip)).toBeNull();
  });
  it.each(["200500", "200400", "200200", "unknown"])("rejects non-success code %s even with usable amount and transRef", async (code) => {
    vi.stubEnv("SLIP2GO_API_KEY", "fixture");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ code, data }))));
    const slip = await verifyBillingSlipByImage("aW1hZ2U=", "image/png", "1234567890", 690);
    expect(slip.ok).toBe(false); expect(slip.receiverVerified).toBe(false);
  });
});
