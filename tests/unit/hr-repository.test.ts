import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createSupabaseServerClient: vi.fn(),
}));

vi.mock("@/server/integrations/supabase/server", () => ({
  createSupabaseServerClient: mocks.createSupabaseServerClient,
  createSupabaseServiceClient: vi.fn(),
}));

describe("hr repository", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("deletePayrollAdjustment reports an error when no matching row is deleted", async () => {
    const query = {
      error: null,
      count: 0,
      eq: vi.fn(() => query),
    };
    const deleteFn = vi.fn(() => query);
    mocks.createSupabaseServerClient.mockResolvedValue({
      from: vi.fn(() => ({
        delete: deleteFn,
      })),
    });

    const { deletePayrollAdjustment } = await import("@/modules/hr/repository");
    const result = await deletePayrollAdjustment(
      "11111111-1111-4111-8111-111111111111",
      "store-1",
      "leave",
    );

    expect(deleteFn).toHaveBeenCalledWith({ count: "exact" });
    expect(query.eq).toHaveBeenCalledWith("type", "leave");
    expect(result.ok).toBe(false);
    expect(result.error?.userMessage).toBe("ไม่พบรายการที่ต้องลบ");
  });
});
