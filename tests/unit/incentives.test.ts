import { describe, expect, it } from "vitest";
import { computeIncentiveSummaries } from "@/modules/incentives/calculator";

describe("computeIncentiveSummaries", () => {
  it("groups paid POS sales by employee and computes commission", () => {
    const result = computeIncentiveSummaries(
      [
        { employeeId: "u1", employeeName: "A", amount: 1000 },
        { employeeId: "u1", employeeName: "A", amount: 500 },
        { employeeId: "u2", employeeName: "B", amount: 200 },
      ],
      { commissionRate: 0.05, bonusTarget: 1000, bonusAmount: 100 },
    );

    expect(result).toEqual([
      {
        employeeId: "u1",
        employeeName: "A",
        salesAmount: 1500,
        commissionAmount: 75,
        bonusAmount: 100,
        totalIncentive: 175,
      },
      {
        employeeId: "u2",
        employeeName: "B",
        salesAmount: 200,
        commissionAmount: 10,
        bonusAmount: 0,
        totalIncentive: 10,
      },
    ]);
  });

  it("sanitizes negative rates, negative sales, and negative bonuses", () => {
    const result = computeIncentiveSummaries(
      [{ employeeId: "u1", employeeName: "A", amount: -100 }],
      { commissionRate: -1, bonusTarget: -1, bonusAmount: -100 },
    );

    expect(result[0].salesAmount).toBe(0);
    expect(result[0].commissionAmount).toBe(0);
    expect(result[0].bonusAmount).toBe(0);
  });
});
