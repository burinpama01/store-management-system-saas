import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

const mocks = vi.hoisted(() => ({
  createSupabaseServiceClient: vi.fn(),
  getOrganizationBillingState: vi.fn(),
  cookies: vi.fn(),
  logActionError: vi.fn(),
}));

vi.mock("@/server/integrations/supabase/server", () => ({
  createSupabaseServiceClient: mocks.createSupabaseServiceClient,
  createSupabaseServerClient: vi.fn(),
}));

vi.mock("@/modules/billing/billing-service", () => ({
  getOrganizationBillingState: mocks.getOrganizationBillingState,
}));

vi.mock("next/headers", () => ({
  cookies: mocks.cookies,
}));

vi.mock("@/modules/system/event-log", () => ({
  logActionError: mocks.logActionError,
}));

const enterpriseBillingState = {
  plan: "enterprise",
  status: "active",
  currentPeriodEnd: "2099-12-31T23:59:59Z",
  cancelAtPeriodEnd: false,
  trialEnd: null,
};

const storeRow = {
  id: "store-1",
  organization_id: "org-1",
  name: "each other II",
  slug: "each-other-ii-f62fc0",
  address: null,
  phone: null,
  logo_url: null,
  currency_code: "THB",
  timezone: "Asia/Bangkok",
  locale: "th-TH",
  is_active: true,
  buffet_enabled: false,
  qr_ordering_enabled: true,
  dine_in_duration_minutes: 90,
  theme_preset_id: "default",
  theme_primary_color: "#c45d32",
  theme_primary_strong_color: "#964323",
  theme_primary_soft_color: "#f7e5dc",
  theme_accent_color: "#2f4f4f",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

const portalLinkRow = {
  id: "portal-link-1",
  organization_id: "org-1",
  store_id: "store-1",
  token: "valid-code",
  label: null,
  is_active: true,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

function createQuery(result: { data: unknown; error: null | { message: string }; count?: number }) {
  const query: Record<string, unknown> = {
    ...result,
    update: vi.fn(() => query),
  };
  const chain = () => query;
  for (const method of ["select", "eq", "gte", "insert", "delete", "order", "upsert", "is"]) {
    query[method] = vi.fn(chain);
  }
  query.single = vi.fn(async () => result);
  query.maybeSingle = vi.fn(async () => result);
  return query;
}

function setupServiceClient(tables: Record<string, ReturnType<typeof createQuery>>) {
  const defaults: Record<string, ReturnType<typeof createQuery>> = {
    stores: createQuery({ data: storeRow, error: null }),
    customer_member_portal_links: createQuery({ data: portalLinkRow, error: null }),
    customer_member_otps: createQuery({ data: { id: "otp-1" }, count: 0, error: null }),
    customer_member_sessions: createQuery({ data: { id: "session-1" }, error: null }),
    loyalty_accounts: createQuery({ data: null, error: null }),
  };
  const queries = { ...defaults, ...tables };
  const client = { from: vi.fn((table: string) => queries[table]) };
  mocks.createSupabaseServiceClient.mockResolvedValue(client);
  return { client, queries };
}

function hashValue(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function jsonResponder(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

describe("member OTP delivery fallback (v1 campaigns → v2 provider OTP)", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.getOrganizationBillingState.mockResolvedValue(enterpriseBillingState);
    mocks.cookies.mockResolvedValue({ get: vi.fn(() => undefined), set: vi.fn() });
    originalFetch = global.fetch;
    process.env.SMSKUB_API_KEY = "smskub-test-key";
    process.env.SMSKUB_SENDER_NAME = "StoreOS";
    process.env.SMSKUB_OTP_PROJECT = "otp-project-1";
    delete process.env.SMSKUB_API_URL;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
    delete process.env.SMSKUB_API_KEY;
    delete process.env.SMSKUB_SENDER_NAME;
    delete process.env.SMSKUB_OTP_PROJECT;
  });

  it("uses the campaigns channel and skips v2 when v1 succeeds", async () => {
    vi.resetModules();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponder(200, { code: 200 }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const { deliverMemberOtp } = await import("@/modules/notifications/smskub");
    const result = await deliverMemberOtp("0801234567", "123456");

    expect(result).toEqual({ channel: "campaigns" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("https://console.sms-kub.com/api/campaigns");
  });

  it("falls back to the v2 provider OTP when campaigns is rejected (e.g. expired package)", async () => {
    vi.resetModules();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponder(500, { code: 500, message: "your package is expired" }))
      .mockResolvedValueOnce(jsonResponder(200, { code: 200, message: "Success", data: { ref_no: "abc123" } }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const { deliverMemberOtp } = await import("@/modules/notifications/smskub");
    const result = await deliverMemberOtp("0801234567", "123456");

    expect(result).toEqual({ channel: "otp_v2" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const v2Url = fetchMock.mock.calls[1][0] as string;
    const v2Init = fetchMock.mock.calls[1][1] as RequestInit;
    expect(v2Url).toBe("https://console.sms-kub.com/api/v2/otp/request");
    expect(v2Init.headers).toMatchObject({ key: "smskub-test-key" });
    expect(String(v2Init.body)).toContain("project=otp-project-1");
    expect(String(v2Init.body)).toContain("phone=0801234567");
  });

  it("throws the v1 error (with provider detail) when both channels fail", async () => {
    vi.resetModules();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponder(500, { code: 500, message: "your package is expired" }))
      .mockResolvedValueOnce(jsonResponder(400, { code: 400, message: "bad request" }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const { deliverMemberOtp } = await import("@/modules/notifications/smskub");

    await expect(deliverMemberOtp("0801234567", "123456")).rejects.toThrow(
      "SMSKUB send failed (500): your package is expired",
    );
  });

  it("marks the OTP row as otp_v2 when delivery fell back to the provider", async () => {
    vi.resetModules();
    const { queries } = setupServiceClient({});
    const { requestMemberOtp } = await import("@/modules/customers/member-repository");

    const result = await requestMemberOtp(
      {
        storeSlug: "each-other-ii-f62fc0",
        portalCode: "valid-code",
        mode: "register",
        name: "Member One",
        phone: "0812345678",
      },
      async () => ({ channel: "otp_v2" }),
    );

    expect(result.error).toBeNull();
    expect(result.data?.otpId).toBe("otp-1");
    expect(queries.customer_member_otps.update).toHaveBeenCalled();
    const markCall = (queries.customer_member_otps.update as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(markCall).toEqual({
      delivery_channel: "otp_v2",
      code_hash: hashValue("provider-otp-v2:0812345678"),
    });
  });

  it("verifies otp_v2 codes through the provider and creates a session on success", async () => {
    vi.resetModules();
    const otpRow = {
      id: "otp-1",
      organization_id: "org-1",
      store_id: "store-1",
      portal_link_id: "portal-link-1",
      customer_id: "customer-1",
      purpose: "register",
      phone: "0812345678",
      email: null,
      name: "Member One",
      code_hash: hashValue("provider-otp-v2:0812345678"),
      attempts: 0,
      expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      consumed_at: null,
      created_at: new Date().toISOString(),
      delivery_channel: "otp_v2",
    };
    const { queries } = setupServiceClient({
      customer_member_otps: createQuery({ data: otpRow, error: null }),
    });
    const { verifyMemberOtp } = await import("@/modules/customers/member-repository");
    const verifyProvider = vi.fn().mockResolvedValue(true);

    const result = await verifyMemberOtp(
      { storeSlug: "each-other-ii-f62fc0", portalCode: "valid-code", otpId: "otp-1", code: "654321" },
      verifyProvider,
    );

    expect(verifyProvider).toHaveBeenCalledWith("0812345678", "654321");
    expect(result.error).toBeNull();
    expect(result.data?.customerId).toBe("customer-1");
    const consumedCall = (queries.customer_member_otps.update as ReturnType<typeof vi.fn>).mock.calls
      .map((call) => call[0])
      .find((payload: Record<string, unknown>) => "consumed_at" in payload);
    expect(consumedCall).toEqual({ consumed_at: expect.any(String) });
    expect(queries.customer_member_sessions.insert).toHaveBeenCalled();
  });

  it("counts a failed provider verification as an attempt without leaking internals", async () => {
    vi.resetModules();
    const otpRow = {
      id: "otp-1",
      organization_id: "org-1",
      store_id: "store-1",
      portal_link_id: "portal-link-1",
      customer_id: "customer-1",
      purpose: "login",
      phone: "0812345678",
      email: null,
      name: null,
      code_hash: hashValue("provider-otp-v2:0812345678"),
      attempts: 2,
      expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      consumed_at: null,
      created_at: new Date().toISOString(),
      delivery_channel: "otp_v2",
    };
    const { queries } = setupServiceClient({
      customer_member_otps: createQuery({ data: otpRow, error: null }),
    });
    const { verifyMemberOtp } = await import("@/modules/customers/member-repository");
    const verifyProvider = vi.fn().mockResolvedValue(false);

    const result = await verifyMemberOtp(
      { storeSlug: "each-other-ii-f62fc0", portalCode: "valid-code", otpId: "otp-1", code: "000000" },
      verifyProvider,
    );

    expect(result.data).toBeNull();
    expect(result.error).toBe("รหัส OTP ไม่ถูกต้อง");
    expect(queries.customer_member_otps.update).toHaveBeenCalledWith({ attempts: 3 });
    expect(queries.customer_member_sessions.insert).not.toHaveBeenCalled();
  });

  it("treats a 4xx provider response (wrong code / no request) as an invalid code, not an outage", async () => {
    vi.resetModules();
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue(jsonResponder(400, { code: 401, message: "OTP not request" })) as unknown as typeof fetch;
    process.env.SMSKUB_API_KEY = "smskub-test-key";
    process.env.SMSKUB_OTP_PROJECT = "otp-project-1";
    try {
      const { verifyProviderOtp } = await import("@/modules/notifications/smskub");
      await expect(verifyProviderOtp("0812345678", "000000")).resolves.toBe(false);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("throws on a 5xx provider response so an outage never burns attempts", async () => {
    vi.resetModules();
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue(jsonResponder(503, { code: 503, message: "unavailable" })) as unknown as typeof fetch;
    process.env.SMSKUB_API_KEY = "smskub-test-key";
    process.env.SMSKUB_OTP_PROJECT = "otp-project-1";
    try {
      const { verifyProviderOtp } = await import("@/modules/notifications/smskub");
      await expect(verifyProviderOtp("0812345678", "123456")).rejects.toThrow("SMSKUB otp verify failed (503)");
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("does not count attempts when the provider verify call itself fails", async () => {
    vi.resetModules();
    const otpRow = {
      id: "otp-1",
      organization_id: "org-1",
      store_id: "store-1",
      portal_link_id: "portal-link-1",
      customer_id: "customer-1",
      purpose: "login",
      phone: "0812345678",
      email: null,
      name: null,
      code_hash: hashValue("provider-otp-v2:0812345678"),
      attempts: 1,
      expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      consumed_at: null,
      created_at: new Date().toISOString(),
      delivery_channel: "otp_v2",
    };
    const { queries } = setupServiceClient({
      customer_member_otps: createQuery({ data: otpRow, error: null }),
    });
    const { verifyMemberOtp } = await import("@/modules/customers/member-repository");
    const verifyProvider = vi.fn().mockRejectedValue(new Error("SMSKUB otp verify failed (500)"));

    const result = await verifyMemberOtp(
      { storeSlug: "each-other-ii-f62fc0", portalCode: "valid-code", otpId: "otp-1", code: "123456" },
      verifyProvider,
    );

    expect(result.data).toBeNull();
    expect(result.error).toBe("ยืนยัน OTP ไม่สำเร็จ กรุณาลองใหม่อีกครั้ง");
    expect(queries.customer_member_otps.update).not.toHaveBeenCalled();
    expect(mocks.logActionError).toHaveBeenCalledWith(
      expect.objectContaining({ source: "member.otp", action: "verifyProviderOtp" }),
    );
  });

  it("deletes the OTP row and returns a generic error when marking otp_v2 fails", async () => {
    vi.resetModules();
    const { queries } = setupServiceClient({});
    // จำลอง update ล้มหลังส่งสำเร็จผ่าน v2
    (queries.customer_member_otps as { update: unknown }).update = vi.fn(() => ({
      eq: vi.fn(async () => ({ error: { message: "mark failed" } })),
    }));
    const { requestMemberOtp } = await import("@/modules/customers/member-repository");

    const result = await requestMemberOtp(
      {
        storeSlug: "each-other-ii-f62fc0",
        portalCode: "valid-code",
        mode: "register",
        name: "Member One",
        phone: "0812345678",
      },
      async () => ({ channel: "otp_v2" }),
    );

    expect(result.data).toBeNull();
    expect(result.error).toBe("ส่ง OTP ไม่สำเร็จ กรุณาลองใหม่หรือแจ้งร้านค้า");
    expect(queries.customer_member_otps.delete).toHaveBeenCalled();
    expect(mocks.logActionError).toHaveBeenCalledWith(
      expect.objectContaining({ source: "member.otp", action: "markOtpV2Channel" }),
    );
  });

  it("treats OTP rows from before the migration (no delivery_channel) as campaigns", async () => {
    vi.resetModules();
    const otpRow = {
      id: "otp-1",
      organization_id: "org-1",
      store_id: "store-1",
      portal_link_id: "portal-link-1",
      customer_id: "customer-1",
      purpose: "login",
      phone: "0812345678",
      email: null,
      name: null,
      code_hash: hashValue("0812345678:123456"),
      attempts: 0,
      expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      consumed_at: null,
      created_at: new Date().toISOString(),
      delivery_channel: "campaigns",
    };
    const legacyRow = { ...otpRow } as Partial<typeof otpRow>;
    delete legacyRow.delivery_channel;
    setupServiceClient({
      customer_member_otps: createQuery({ data: legacyRow, error: null }),
    });
    const { verifyMemberOtp } = await import("@/modules/customers/member-repository");
    const verifyProvider = vi.fn();

    const result = await verifyMemberOtp(
      { storeSlug: "each-other-ii-f62fc0", portalCode: "valid-code", otpId: "otp-1", code: "123456" },
      verifyProvider,
    );

    expect(verifyProvider).not.toHaveBeenCalled();
    expect(result.error).toBeNull();
    expect(result.data?.customerId).toBe("customer-1");
  });

  it("still verifies campaigns codes against the local hash (no provider call)", async () => {
    vi.resetModules();
    const otpRow = {
      id: "otp-1",
      organization_id: "org-1",
      store_id: "store-1",
      portal_link_id: "portal-link-1",
      customer_id: "customer-1",
      purpose: "login",
      phone: "0812345678",
      email: null,
      name: null,
      code_hash: hashValue("0812345678:123456"),
      attempts: 0,
      expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      consumed_at: null,
      created_at: new Date().toISOString(),
      delivery_channel: "campaigns",
    };
    setupServiceClient({
      customer_member_otps: createQuery({ data: otpRow, error: null }),
    });
    const { verifyMemberOtp } = await import("@/modules/customers/member-repository");
    const verifyProvider = vi.fn();

    const result = await verifyMemberOtp(
      { storeSlug: "each-other-ii-f62fc0", portalCode: "valid-code", otpId: "otp-1", code: "123456" },
      verifyProvider,
    );

    expect(verifyProvider).not.toHaveBeenCalled();
    expect(result.error).toBeNull();
    expect(result.data?.customerId).toBe("customer-1");
  });
});
