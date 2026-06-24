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

function createQuery(result: { data: unknown; error: null | { message: string } }) {
  const query = {
    select: vi.fn(() => query),
    eq: vi.fn(() => query),
    order: vi.fn(() => result),
    maybeSingle: vi.fn(async () => result),
  };
  return query;
}

function setupServiceClient(portalResult: { data: unknown; error: null | { message: string } }) {
  const queries = {
    stores: createQuery({ data: storeRow, error: null }),
    customer_member_portal_links: createQuery(portalResult),
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
});
