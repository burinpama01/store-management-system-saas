export type PayType = "monthly" | "daily" | "hourly";
export type AdjustmentType = "penalty" | "bonus" | "leave" | "absent" | "late";

export interface EmployeeProfile {
  id: string;
  organizationId: string;
  storeId: string;
  userId: string;
  displayName?: string;
  payType: PayType;
  monthlySalary: number;
  dailyRate: number;
  hourlyRate: number;
  /** Local store time "HH:MM[:SS]" the shift is expected to start, for late detection. */
  expectedStartTime?: string;
  lateGraceMinutes: number;
  latePenaltyAmount: number;
  absentPenaltyAmount: number;
  /** Weekdays the employee is expected to work (0=Sun .. 6=Sat). */
  workingDays: number[];
  otEligible: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface StoreHrSettings {
  storeId: string;
  organizationId: string;
  regularHoursPerDay: number;
  otMultiplier: number;
  otDailyCapHours: number;
  latePenaltyPerMinute: number;
  latePenaltyMaxPerDay: number;
  absentPenaltyPerDay: number;
  /** วันที่ทำงานจริง ≤ ชั่วโมงนี้ = ครึ่งวัน (จ่ายครึ่งเดียว); 0 = ปิดการคิดครึ่งวัน */
  halfDayMaxHours: number;
  backdatedRightsPerMonth: number;
  /** Weekdays the store is open (0=Sun .. 6=Sat). Default for the attendance calendar. */
  workingDays: number[];
  createdAt: string;
  updatedAt: string;
}

export const DEFAULT_HR_SETTINGS: Omit<StoreHrSettings, "storeId" | "organizationId" | "createdAt" | "updatedAt"> = {
  regularHoursPerDay: 8,
  otMultiplier: 1.5,
  otDailyCapHours: 2,
  latePenaltyPerMinute: 0,
  latePenaltyMaxPerDay: 0,
  absentPenaltyPerDay: 0,
  halfDayMaxHours: 0,
  backdatedRightsPerMonth: 3,
  workingDays: [0, 1, 2, 3, 4, 5, 6],
};

export const WEEKDAY_LABELS = ["อา", "จ", "อ", "พ", "พฤ", "ศ", "ส"];

export interface PayrollAdjustment {
  id: string;
  organizationId: string;
  storeId: string;
  userId: string;
  employeeName: string;
  date: string;
  type: AdjustmentType;
  amount: number;
  note?: string;
  createdByUserId: string;
  createdAt: string;
}

export const PAY_TYPE_LABEL: Record<PayType, string> = {
  monthly: "เงินเดือน",
  daily: "รายวัน",
  hourly: "รายชั่วโมง",
};

export const ADJUSTMENT_LABEL: Record<AdjustmentType, string> = {
  penalty: "หักโทษ",
  bonus: "โบนัส/เพิ่ม",
  leave: "หักลา",
  absent: "หักขาดงาน",
  late: "หักมาสาย",
};

/** Adjustment types that reduce pay (bonus increases). */
export const DEDUCTION_TYPES: AdjustmentType[] = ["penalty", "leave", "absent", "late"];
