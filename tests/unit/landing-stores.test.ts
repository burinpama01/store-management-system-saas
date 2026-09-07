import { beforeEach, describe, expect, it, vi } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { listLandingStores } from "@/modules/stores/landing-repository";

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock("@/server/integrations/supabase/server", () => ({
  createSupabaseServiceClient: async () => createClient("https://example.supabase.co", "test-key", {
    global: { fetch: fetchMock }, auth: { persistSession: false },
  }),
}));

describe("landing store eligibility", () => {
  beforeEach(() => fetchMock.mockReset());

  it("filters active stores, active menus, unsuspended organizations and a rolling seven-day order window before limiting", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify([
      { name: "ร้านทดสอบ", slug: "test-cafe", logo_url: "https://example.com/logo.png", orders: [{ total: 999 }], phone: "private" },
    ]), { status: 200, headers: { "Content-Type": "application/json" } }));
    const result = await listLandingStores(new Date("2026-09-06T12:00:00.000Z"));
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.searchParams.get("is_active")).toBe("eq.true");
    expect(url.searchParams.get("products.is_active")).toBe("eq.true");
    expect(url.searchParams.get("organizations.suspended_at")).toBe("is.null");
    expect(url.searchParams.getAll("orders.created_at")).toEqual([
      "gte.2026-08-30T12:00:00.000Z", "lte.2026-09-06T12:00:00.000Z",
    ]);
    expect(url.searchParams.get("orders.status")).toBe("in.(open,pending_payment,paid,refunded)");
    expect(url.searchParams.get("select")).toContain("products!inner()");
    expect(url.searchParams.get("select")).toContain("orders!inner()");
    expect(url.searchParams.get("limit")).toBe("12");
    expect(result).toEqual([{ name: "ร้านทดสอบ", slug: "test-cafe", logoUrl: "https://example.com/logo.png" }]);
  });

  it("returns no showcase on database errors instead of fabricated stores", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ message: "unavailable" }), { status: 503 }));
    await expect(listLandingStores()).resolves.toEqual([]);
  });

  it("rejects unsafe logo schemes and retains real store names without logos", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify([
      { name: "คาเฟ่", slug: "cafe", logo_url: "javascript:alert(1)" },
      { name: "ร้านอาหาร", slug: "food", logo_url: null },
    ]), { status: 200 }));
    expect(await listLandingStores()).toEqual([
      { name: "คาเฟ่", slug: "cafe", logoUrl: null },
      { name: "ร้านอาหาร", slug: "food", logoUrl: null },
    ]);
  });
});
