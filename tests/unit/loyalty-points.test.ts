import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { formatPoints, roundPoints } from "@/shared/utils/points";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

describe("loyalty points util", () => {
  it("rounds points to 2 decimals (no float drift)", () => {
    expect(roundPoints(101 * 0.01)).toBe(1.01);
    expect(roundPoints(80 * 0.01)).toBe(0.8);
    expect(roundPoints(250 * 0.01)).toBe(2.5);
    expect(roundPoints(1.236)).toBe(1.24);
    expect(roundPoints(1.234)).toBe(1.23);
  });

  it("formats points with exactly 2 decimals", () => {
    expect(formatPoints(1.01)).toBe("1.01");
    expect(formatPoints(100)).toBe("100.00");
    expect(formatPoints(0.8)).toBe("0.80");
    expect(formatPoints(undefined)).toBe("0.00");
  });
});

describe("loyalty decimal-points migration", () => {
  it("stores points as numeric and earns rounded (not floored integer) points", () => {
    const migration = read("supabase/migrations/20260626140000_loyalty_decimal_points.sql");
    expect(migration).toContain("alter column points_balance type numeric(12,2)");
    expect(migration).toContain("alter column points_delta   type numeric(12,2)");
    expect(migration).toContain("loyalty_points_earned   type numeric(12,2)");
    expect(migration).toContain("round(v_order.total * v_points_per_currency, 2)");
    expect(migration).not.toContain("floor(v_order.total");
    // adjust function moves from integer to numeric and re-grants service_role
    expect(migration).toContain("drop function if exists adjust_customer_loyalty_points(uuid, uuid, uuid, integer, text, text)");
    expect(migration).toContain("p_points_delta numeric");
    expect(migration).toContain(
      "grant execute on function adjust_customer_loyalty_points(uuid, uuid, uuid, numeric, text, text) to service_role",
    );
  });
});
