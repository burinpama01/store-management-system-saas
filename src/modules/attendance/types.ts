export type ClockActionType = "clock_in" | "clock_out";
export type AttendanceStatus = "active" | "completed" | "backdated" | "adjusted";

export interface AttendanceRecord {
  id: string;
  storeId: string;
  organizationId: string;
  userId: string;
  employeeName: string;
  date: string;
  clockInAt: string;
  clockOutAt: string | null;
  clockInLat?: number;
  clockInLng?: number;
  clockInLocationLabel?: string;
  clockOutLat?: number;
  clockOutLng?: number;
  clockOutLocationLabel?: string;
  status: AttendanceStatus;
  note?: string;
  adjustedByUserId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ClockAction {
  type: ClockActionType;
  userId: string;
  storeId: string;
  organizationId: string;
  lat?: number;
  lng?: number;
  locationLabel?: string;
  note?: string;
  timestamp?: string;
}

export interface PayrollSummary {
  id: string;
  storeId: string;
  organizationId: string;
  userId: string;
  employeeName: string;
  periodStart: string;
  periodEnd: string;
  totalDays: number;
  totalHours: number;
  regularHours: number;
  overtimeHours: number;
  hourlyRate?: number;
  dailyRate?: number;
  totalPay: number;
  records: AttendanceRecord[];
  generatedAt: string;
}

export interface AttendanceFilter {
  storeId: string;
  organizationId: string;
  userId?: string;
  dateFrom: string;
  dateTo: string;
}
