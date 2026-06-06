import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { withDataClient } from "@/shared/services/data-client";

vi.mock("@/server/integrations/supabase/server", () => ({
  createSupabaseServerClient: vi.fn(async () => ({ from: vi.fn() })),
}));

describe("withDataClient", () => {
  it("maps unexpected null data to a not found error by default", async () => {
    const result = await withDataClient<string>(async () => ({
      data: null,
      error: null,
    }));

    expect(result.data).toBeNull();
    expect(result.error?.code).toBe("PGRST116");
  });

  it("returns default data for valid empty list states", async () => {
    const result = await withDataClient<string[]>(
      async () => ({
        data: null,
        error: null,
      }),
      { defaultData: [] },
    );

    expect(result).toEqual({ data: [], error: null });
  });

  it("allows null as a valid success state when requested", async () => {
    const result = await withDataClient<string | null>(
      async () => ({
        data: null,
        error: null,
      }),
      { allowNull: true },
    );

    expect(result).toEqual({ data: null, error: null });
  });

  it("requires nullable single-row repositories to use maybeSingle before allowNull", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "src/modules/stores/repository.ts"),
      "utf8",
    );

    expect(source).toContain("withDataClient<ReceiptSettings | null>");
    expect(source).toContain(".maybeSingle()");
    expect(source).toContain("{ allowNull: true }");
  });
});
