export interface IncentiveSale {
  employeeId: string;
  employeeName: string;
  amount: number;
}

export interface IncentivePolicy {
  commissionRate: number;
  bonusTarget: number;
  bonusAmount: number;
}

export interface IncentiveSummary {
  employeeId: string;
  employeeName: string;
  salesAmount: number;
  commissionAmount: number;
  bonusAmount: number;
  totalIncentive: number;
}
