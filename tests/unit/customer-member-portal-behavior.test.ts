import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createSupabaseServiceClient: vi.fn(),
  getOrganizationBillingState: vi.fn(),
  cookies: vi.fn(),
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
  const query = {
    ...result,
    select: vi.fn(() => query),
    eq: vi.fn(() => query),
    gte: vi.fn(() => query),
    insert: vi.fn(() => query),
    delete: vi.fn(() => query),
    order: vi.fn(() => result),
    single: vi.fn(async () => result),
    maybeSingle: vi.fn(async () => result),
  };
  return query;
}

function setupServiceClient(portalResult: { data: unknown; error: null | { message: string } }) {
  const queries = {
    stores: createQuery({ data: storeRow, error: null }),
    customer_member_portal_links: createQuery(portalResult),
    customer_member_otps: createQuery({ data: { id: "otp-1" }, count: 0, error: null }),
    loyalty_rewards: createQuery({ data: [], error: null }),
  };
  const client = {
    from: vi.fn((table: keyof typeof queries) => queries[table]),
  };
  mocks.createSupabaseServiceClient.mockResolvedValue(client);
  return { client, queries };
}

describe("customer member portal behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.getOrganizationBillingState.mockResolvedValue(enterpriseBillingState);
    mocks.cookies.mockResolvedValue({ get: vi.fn(() => undefined) });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends SMSKUB OTP with the documented API key header and campaign payload", async () => {
    vi.resetModules();
    const originalFetch = global.fetch;
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    process.env.SMSKUB_API_KEY = "smskub-test-key";
    process.env.SMSKUB_SENDER_NAME = "StoreOS";
    process.env.SMSKUB_API_URL = "https://console.sms-kub.com/api/campaigns";
    global.fetch = fetchMock as unknown as typeof fetch;

    try {
      const { sendSmskubOtp } = await import("@/modules/notifications/smskub");
      await sendSmskubOtp("0801234567", "123456");
    } finally {
      global.fetch = originalFetch;
      delete process.env.SMSKUB_API_KEY;
      delete process.env.SMSKUB_SENDER_NAME;
      delete process.env.SMSKUB_API_URL;
    }

    expect(fetchMock).toHaveBeenCalledWith("https://console.sms-kub.com/api/campaigns", expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({
        "Content-Type": "application/json",
        key: "smskub-test-key",
      }),
    }));
    expect(fetchMock.mock.calls[0][1].headers).not.toHaveProperty("X-API-Key");
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body).toMatchObject({
      name: "StoreOS OTP",
      to: ["0801234567"],
      from: "StoreOS",
      is_schedule: false,
      frequency: "onetime",
    });
    expect(body.message).toContain("123456");
  });

  it("opens a valid permanent QR without a staff session", async () => {
    const { queries } = setupServiceClient({ data: portalLinkRow, error: null });
    const { getCustomerPortalData } = await import("@/modules/customers/member-repository");

    const result = await getCustomerPortalData("each-other-ii-f62fc0", "valid-code");

    expect(result.portalValid).toBe(true);
    expect(result.store?.id).toBe("store-1");
    expect(result.error).toBeNull();
    expect(mocks.cookies).toHaveBeenCalled();
    expect(queries.customer_member_portal_links.eq).toHaveBeenCalledWith("store_id", "store-1");
    expect(queries.customer_member_portal_links.eq).toHaveBeenCalledWith("token", "valid-code");
    expect(queries.customer_member_portal_links.eq).toHaveBeenCalledWith("is_active", true);
  });

  it("does not leak the store object when the QR token is invalid", async () => {
    const { queries } = setupServiceClient({ data: null, error: null });
    const { getCustomerPortalData } = await import("@/modules/customers/member-repository");

    const result = await getCustomerPortalData("each-other-ii-f62fc0", "wrong-code");

    expect(result.portalValid).toBe(false);
    expect(result.store).toBeNull();
    expect(result.error).toBe("ไม่พบ QR สมัครสมาชิกนี้ กรุณาสแกน QR ล่าสุดจากร้าน");
    expect(mocks.cookies).not.toHaveBeenCalled();
    expect(queries.customer_member_portal_links.eq).toHaveBeenCalledWith("store_id", "store-1");
    expect(queries.customer_member_portal_links.eq).toHaveBeenCalledWith("token", "wrong-code");
  });

  it("keeps SMS provider failures generic on the public member portal", async () => {
    const { queries } = setupServiceClient({ data: portalLinkRow, error: null });
    const { requestMemberOtp } = await import("@/modules/customers/member-repository");

    const result = await requestMemberOtp(
      {
        storeSlug: "each-other-ii-f62fc0",
        portalCode: "valid-code",
        mode: "register",
        name: "Member One",
        phone: "0812345678",
      },
      async () => {
        throw new Error("SMSKUB send failed (401)");
      },
    );

    expect(result.data).toBeNull();
    expect(result.error).toBe("ส่ง OTP ไม่สำเร็จ กรุณาลองใหม่หรือแจ้งร้านค้า");
    expect(result.error).not.toContain("SMSKUB");
    expect(queries.customer_member_otps.delete).toHaveBeenCalled();
    expect(queries.customer_member_otps.eq).toHaveBeenCalledWith("id", "otp-1");
    expect(console.warn).toHaveBeenCalledWith(
      "[member-portal] otp send failed",
      expect.objectContaining({
        storeId: "store-1",
        otpId: "otp-1",
        maskedPhone: "081****78",
        error: "SMSKUB send failed (401)",
        cleanupError: null,
      }),
    );
  });

  it("hides unexpected repository errors from public OTP actions", async () => {
    const actions = await import("@/app/member/[storeSlug]/actions");
    const repository = await import("@/modules/customers/member-repository");
    vi.spyOn(repository, "requestMemberOtp").mockResolvedValue({
      data: null,
      error: "internal customer_member_otps constraint failed",
    });

    const formData = new FormData();
    formData.set("storeSlug", "each-other-ii-f62fc0");
    formData.set("portalCode", "valid-code");
    formData.set("mode", "register");
    formData.set("name", "Member One");
    formData.set("phone", "0812345678");

    const result = await actions.requestMemberOtpAction(formData);

    expect(result.error).toBe("ส่ง OTP ไม่สำเร็จ กรุณาลองใหม่หรือแจ้งร้านค้า");
    expect(result.error).not.toContain("customer_member_otps");
    expect(console.warn).toHaveBeenCalledWith(
      "[member-portal] internal error hidden",
      { message: "internal customer_member_otps constraint failed" },
    );
  });

  it("preserves safe business validation messages on public member actions", async () => {
    const actions = await import("@/app/member/[storeSlug]/actions");
    const repository = await import("@/modules/customers/member-repository");
    const loyalty = await import("@/modules/loyalty/repository");
    vi.spyOn(repository, "verifyMemberOtp").mockResolvedValue({
      data: null,
      error: "OTP หมดอายุแล้ว",
    });
    vi.spyOn(repository, "getCustomerPortalData").mockResolvedValue({
      store: {
        id: "store-1",
        organizationId: "org-1",
        name: "each other II",
        slug: "each-other-ii-f62fc0",
        currencyCode: "THB",
        timezone: "Asia/Bangkok",
        locale: "th-TH",
        isActive: true,
        buffetEnabled: false,
        qrOrderingEnabled: true,
        dineInDurationMinutes: 90,
        themePresetId: "default",
        themePrimaryColor: "#c45d32",
        themePrimaryStrongColor: "#964323",
        themePrimarySoftColor: "#f7e5dc",
        themeAccentColor: "#2f4f4f",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      },
      portalCode: "valid-code",
      portalValid: true,
      customer: { id: "customer-1", name: "Member One", pointsBalance: 0 },
      rewards: [],
      redemptions: [],
      error: null,
    });
    vi.spyOn(loyalty, "redeemRewardForCurrentCustomer").mockResolvedValue({
      data: null,
      error: { code: "P0001", message: "ของรางวัลหมด", userMessage: "ของรางวัลหมด" },
    });

    const otpForm = new FormData();
    otpForm.set("storeSlug", "each-other-ii-f62fc0");
    otpForm.set("portalCode", "valid-code");
    otpForm.set("otpId", "otp-1");
    otpForm.set("code", "123456");
    await expect(actions.verifyMemberOtpAction(otpForm)).resolves.toEqual({ error: "OTP หมดอายุแล้ว" });

    const redeemForm = new FormData();
    redeemForm.set("storeSlug", "each-other-ii-f62fc0");
    redeemForm.set("portalCode", "valid-code");
    redeemForm.set("rewardId", "11111111-1111-4111-8111-111111111111");
    await expect(actions.redeemMemberRewardAction(redeemForm)).resolves.toEqual({ error: "ของรางวัลหมด" });
  });
});
