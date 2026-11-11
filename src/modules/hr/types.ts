export type PayType = "monthly" | "daily" | "hourly";
/** ประเภทการจ้าง — แยกจากวิธีคิดเงิน (payType): ค่าทักษะ/อายุงาน/โบนัสยอดขาย ให้เฉพาะ permanent */
export type EmploymentType = "permanent" | "daily" | "part_time" | "temporary";
/** withholding_tax = ภาษีหัก ณ ที่จ่ายโหมดกรอกเอง (คิดแยกในเงินเดือนขั้นสูง ไม่นับเป็นโบนัส/รายการหัก) */
export type AdjustmentType = "penalty" | "bonus" | "leave" | "absent" | "late" | "withholding_tax";

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
  /** รหัสพนักงาน (ไม่ซ้ำในสาขา) */
  employeeCode?: string;
  /** ชื่อ-สกุลจริงสำหรับสลิป (displayName = ชื่อเล่นในระบบ) */
  fullName?: string;
  position?: string;
  employmentType: EmploymentType;
  /** วันที่เป็นพนักงานประจำ (YYYY-MM-DD) — สิทธิ์ ②③④ เริ่มงวดถัดไปจากวันนี้ */
  permanentSince?: string;
  /** วันเริ่มนับอายุงาน — ระบบตั้งจากการลงเวลาครั้งแรกในสาขา ผู้จัดการแก้ย้อนหลังได้ */
  seniorityStartDate?: string;
  /** วันออกงาน — งวดสุดท้ายคิดถึงวันนี้ หลังจากนี้พนักงานดูสลิปเองไม่ได้ */
  employmentEndDate?: string;
  bankName?: string;
  /** เลขบัญชีเต็ม — อ่านได้เฉพาะฝั่ง server (หน้า /staff ตัดออกก่อนส่งให้ browser) */
  bankAccountNo?: string;
  /** เลขบัญชีแบบปิดหลัก "••7890" สำหรับแสดงผลฝั่ง browser */
  bankAccountMasked?: string;
  bankAccountName?: string;
  /** หักประกันสังคมคนนี้ไหม (มีผลเมื่อร้านเปิดสวิตช์ประกันสังคม) */
  ssoEnabled?: boolean;
  /** อัตราภาษีหัก ณ ที่จ่าย % (โหมด % คงที่ต่อคน) */
  withholdingTaxRate?: number;
  /** รอบจ่าย: รายเดือน (เดิม) / รายสัปดาห์แยกรอบ / รายสัปดาห์จ่ายล่วงหน้า — มีผลเมื่อร้านเปิดสวิตช์จ่ายรายสัปดาห์ */
  payFrequency?: "monthly" | "weekly" | "weekly_advance";
  createdAt: string;
  updatedAt: string;
}

export const EMPLOYMENT_TYPES: EmploymentType[] = ["permanent", "daily", "part_time", "temporary"];

export const EMPLOYMENT_TYPE_LABEL: Record<EmploymentType, string> = {
  permanent: "พนักงานประจำ",
  daily: "รายวัน",
  part_time: "พาร์ทไทม์",
  temporary: "ชั่วคราว",
};

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
  /** ข้อมูลนิติบุคคลบนสลิป — ว่าง = ใช้ชื่อ/ที่อยู่/เลขภาษีจากตั้งค่าใบเสร็จ */
  payslipLegalName?: string;
  payslipAddress?: string;
  payslipTaxId?: string;
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
  withholding_tax: "ภาษีหัก ณ ที่จ่าย",
};

/** Adjustment types that reduce pay (bonus increases). */
export const DEDUCTION_TYPES: AdjustmentType[] = ["penalty", "leave", "absent", "late"];
