import type {
  IncentivePolicy,
  IncentiveSale,
  IncentiveSummary,
} from "./types";

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function positive(n: number): number {
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function computeIncentiveSummaries(
  sales: IncentiveSale[],
  policy: IncentivePolicy,
): IncentiveSummary[] {
  const commissionRate = positive(policy.commissionRate);
  const bonusTarget = positive(policy.bonusTarget);
  const policyBonusAmount = positive(policy.bonusAmount);
  const byEmployee = new Map<string, { employeeName: string; salesAmount: number }>();

  for (const sale of sales) {
    const current = byEmployee.get(sale.employeeId) ?? {
      employeeName: sale.employeeName,
      salesAmount: 0,
    };
    current.salesAmount = round2(current.salesAmount + positive(sale.amount));
    byEmployee.set(sale.employeeId, current);
  }

  return Array.from(byEmployee.entries())
    .map(([employeeId, value]) => {
      const commissionAmount = round2(value.salesAmount * commissionRate);
      const bonusAmount =
        bonusTarget > 0 && value.salesAmount >= bonusTarget
          ? policyBonusAmount
          : 0;
      return {
        employeeId,
        employeeName: value.employeeName,
        salesAmount: value.salesAmount,
        commissionAmount,
        bonusAmount,
        totalIncentive: round2(commissionAmount + bonusAmount),
      };
    })
    .sort((a, b) => b.salesAmount - a.salesAmount);
}
