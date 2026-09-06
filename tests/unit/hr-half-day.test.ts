import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { computePayrollLines, isHalfDay, HALF_DAY_TOLERANCE_HOURS } from "@/modules/hr/payroll";
import { computeDayStatuses } from "@/modules/attendance/calendar";
import { DEFAULT_HR_SETTINGS, type EmployeeProfile, type StoreHrSettings } from "@/modules/hr/types";
import type { AttendanceRecord, PayrollSummary } from "@/modules/attendance/types";

const TZ = "Asia/Bangkok";

/** ค่าเริ่มต้นของระบบคือปิดครึ่งวัน — เทสที่วัดพฤติกรรมครึ่งวันต้องเปิดเอง */
const HALF_DAY_ON = { halfDayMaxHours: 4 } as const;

const settings = (over: Partial<StoreHrSettings> = {}): StoreHrSettings => ({
  ...DEFAULT_HR_SETTINGS,
  storeId: "store-1",
  organizationId: "org-1",
  createdAt: "",
  updatedAt: "",
  ...over,
});

const profile = (over: Partial<EmployeeProfile> = {}): EmployeeProfile => ({
  id: "p1",
  organizationId: "org-1",
  storeId: "store-1",
  userId: "u1",
  payType: "daily",
  monthlySalary: 0,
  dailyRate: 500,
  hourlyRate: 0,
  lateGraceMinutes: 0,
  latePenaltyAmount: 0,
  absentPenaltyAmount: 0,
  workingDays: [0, 1, 2, 3, 4, 5, 6],
  otEligible: false,
  createdAt: "",
  updatedAt: "",
  ...over,
});

const summary = (over: Partial<PayrollSummary> = {}): PayrollSummary =>
  ({
    userId: "u1",
    employeeName: "Alice",
    totalDays: 0,
    totalHours: 0,
    regularHours: 0,
    overtimeHours: 0,
    ...over,
  }) as PayrollSummary;

/** เข้างานเวลา 09:00 ไทย ทำงาน `hours` ชั่วโมง (hours = null คือยังไม่ลงออก) */
function record(date: string, hours: number | null, over: Partial<AttendanceRecord> = {}): AttendanceRecord {
  const clockIn = `${date}T02:00:00.000Z`; // 09:00 ตามเวลาไทย
  return {
    id: `${date}-${over.userId ?? "u1"}`,
    organizationId: "org-1",
    storeId: "store-1",
    userId: "u1",
    employeeName: "Alice",
    date,
    clockInAt: clockIn,
    clockOutAt: hours === null ? null : new Date(Date.parse(clockIn) + hours * 3_600_000).toISOString(),
    ...over,
  } as AttendanceRecord;
}

function run(args: {
  records: AttendanceRecord[];
  holidays?: string[];
  profileOver?: Partial<EmployeeProfile>;
  settingsOver?: Partial<StoreHrSettings>;
  summaryOver?: Partial<PayrollSummary>;
  periodStart?: string;
  periodEnd?: string;
}) {
  return computePayrollLines({
    summaries: [summary({ totalDays: args.records.length, ...args.summaryOver })],
    records: args.records,
    profiles: [profile(args.profileOver)],
    adjustments: [],
    settings: settings(args.settingsOver),
    holidayDates: args.holidays ?? [],
    periodStart: args.periodStart ?? "2026-09-01",
    periodEnd: args.periodEnd ?? "2026-09-30",
    today: "2026-09-30",
    timezone: TZ,
  })[0];
}

describe("ทำงานครึ่งวัน = จ่ายครึ่งเดียว", () => {
  it("รายวัน: วันที่ทำงานไม่เกินเกณฑ์ครึ่งวัน คิดเป็น 0.5 วัน", () => {
    const line = run({ records: [record("2026-09-01", 8), record("2026-09-02", 3)], settingsOver: HALF_DAY_ON });
    expect(line.fullDays).toBe(1);
    expect(line.halfDays).toBe(1);
    expect(line.payableDays).toBe(1.5);
    expect(line.basePay).toBe(750); // 500 × 1.5
  });

  it("ทำงานพอดีเกณฑ์ (4 ชม.) ยังนับครึ่งวัน แต่เกินเกณฑ์+ผ่อนผัน นับเต็มวัน", () => {
    expect(run({ records: [record("2026-09-01", 4)], settingsOver: HALF_DAY_ON }).halfDays).toBe(1);
    expect(run({ records: [record("2026-09-01", 4.6)], settingsOver: HALF_DAY_ON }).halfDays).toBe(0);
  });

  it("ผ่อนผัน 15 นาที — ตอกออกช้า 6 นาที (4.10 ชม.) ยังเป็นครึ่งวัน", () => {
    // เคสจริงของร้าน: เข้า 07:24 ออก 11:30 = 4 ชม. 6 นาที ต้องไม่กลายเป็นเต็มวัน
    expect(HALF_DAY_TOLERANCE_HOURS).toBe(0.25);
    expect(isHalfDay(4.1, 4)).toBe(true);
    expect(isHalfDay(4.25, 4)).toBe(true);
    expect(isHalfDay(4.26, 4)).toBe(false);
    expect(isHalfDay(0, 4)).toBe(false);
    expect(isHalfDay(3, 0)).toBe(false); // ปิดการคิดครึ่งวัน
    expect(run({ records: [record("2026-09-01", 4.1)], settingsOver: HALF_DAY_ON }).halfDays).toBe(1);
  });

  it("ค่าเริ่มต้นของระบบคือปิด (0)", () => {
    expect(DEFAULT_HR_SETTINGS.halfDayMaxHours).toBe(0);
  });

  it("ตั้งค่า 0 = ปิดการคิดครึ่งวัน ทุกวันที่มาทำงานนับเต็ม", () => {
    const line = run({ records: [record("2026-09-01", 2)], settingsOver: { halfDayMaxHours: 0 } });
    expect(line.halfDays).toBe(0);
    expect(line.payableDays).toBe(1);
    expect(line.basePay).toBe(500);
  });

  it("รายเดือน: หักครึ่งของค่าวันนั้นแทนการลดวัน", () => {
    const line = run({
      records: [record("2026-09-01", 3)],
      settingsOver: HALF_DAY_ON,
      profileOver: { payType: "monthly", monthlySalary: 30000, dailyRate: 0, absentPenaltyAmount: 600 },
    });
    expect(line.basePay).toBe(30000);
    expect(line.halfDayDeduction).toBe(300); // 0.5 × 600
    expect(line.netPay).toBe(30000 - 300 - line.absentPenalty);
  });

  it("รายชั่วโมงไม่ถูกหักซ้ำ เพราะจ่ายตามชั่วโมงอยู่แล้ว", () => {
    const line = run({
      records: [record("2026-09-01", 3)],
      profileOver: { payType: "hourly", hourlyRate: 60, dailyRate: 0 },
      summaryOver: { totalHours: 3 },
    });
    expect(line.halfDayDeduction).toBe(0);
    expect(line.basePay).toBe(180);
  });
});

describe("วันหยุดที่เข้างานแต่ไม่ลงออกงาน", () => {
  const holiday = "2026-09-05";

  it("ไม่คิดค่าแรง และไม่นับเป็นขาดงาน", () => {
    // จำกัดงวดให้เหลือแค่วันหยุดวันนั้น เพื่อวัดเฉพาะพฤติกรรมของวันหยุด
    const line = run({
      records: [record(holiday, null)],
      holidays: [holiday],
      periodStart: holiday,
      periodEnd: holiday,
    });
    expect(line.unpaidHolidayDays).toBe(1);
    expect(line.payableDays).toBe(0);
    expect(line.basePay).toBe(0);
    expect(line.absentDays).toBe(0);
    expect(line.absentPenalty).toBe(0);
  });

  it("วันหยุดที่ลงออกงานครบ ยังจ่ายตามจริง", () => {
    const line = run({
      records: [record(holiday, 8)],
      holidays: [holiday],
      periodStart: holiday,
      periodEnd: holiday,
    });
    expect(line.unpaidHolidayDays).toBe(0);
    expect(line.payableDays).toBe(1);
    expect(line.basePay).toBe(500);
  });

  it("วันธรรมดาที่เข้าไม่ออก ยังถือเป็นขาดงานตามกฎเดิม", () => {
    const line = run({ records: [record("2026-09-02", null)], periodStart: "2026-09-02", periodEnd: "2026-09-02" });
    expect(line.unpaidHolidayDays).toBe(0);
    expect(line.absentDays).toBeGreaterThan(0);
  });
});

describe("ตารางรายวันบนสลิปเงินเดือน", () => {
  it("บอกที่มาของทุกวันในงวด แยกครึ่งวัน/ขาด/เข้าไม่ออก", () => {
    const line = run({
      records: [record("2026-09-01", 8), record("2026-09-02", 4.1), record("2026-09-03", null)],
      settingsOver: HALF_DAY_ON,
      periodStart: "2026-09-01",
      periodEnd: "2026-09-04",
    });
    const byDate = Object.fromEntries(line.days.map((d) => [d.date, d.status]));
    expect(byDate["2026-09-01"]).toBe("full");
    expect(byDate["2026-09-02"]).toBe("half");
    expect(byDate["2026-09-03"]).toBe("in_no_out");
    expect(byDate["2026-09-04"]).toBe("absent");
    // จำนวนวันที่ระบบหักต้องตรงกับตารางที่โชว์ให้พนักงานดู
    expect(line.absentDays).toBe(line.days.filter((d) => d.status === "absent" || d.status === "in_no_out").length);
  });

  it("แสดงเวลาเข้า-ออกและนาทีที่มาสายของแต่ละวัน", () => {
    const line = run({
      records: [record("2026-09-01", 8)], // เข้า 09:00 ตามเวลาไทย
      profileOver: { expectedStartTime: "08:00", lateGraceMinutes: 15 },
      periodStart: "2026-09-01",
      periodEnd: "2026-09-01",
    });
    const day = line.days[0];
    expect(day.clockInAt).toBeTruthy();
    expect(day.clockOutAt).toBeTruthy();
    expect(day.late).toBe(true);
    expect(day.lateMinutes).toBe(45); // 09:00 − (08:00 + 15 นาที)
  });

  it("บอกอัตราค่าแรงต่อวันที่ใช้คิดค่าปรับ เพื่อให้ตรวจยอดย้อนได้", () => {
    const line = run({
      records: [],
      profileOver: { payType: "monthly", monthlySalary: 30000, dailyRate: 0, absentPenaltyAmount: 500 },
      periodStart: "2026-09-01",
      periodEnd: "2026-09-02",
    });
    expect(line.absentRatePerDay).toBe(500);
    expect(line.absentPenalty).toBe(line.absentDays * 500);
  });
});

describe("สถานะรายวันในปฏิทิน", () => {
  const base = {
    month: "2026-09",
    today: "2026-09-30",
    timezone: TZ,
    profile: { lateGraceMinutes: 0, workingDays: [0, 1, 2, 3, 4, 5, 6] },
    holidays: new Set<string>(),
    leaveDates: new Set<string>(),
    halfDayMaxHours: 4,
  };

  it("แยกครึ่งวันออกจากวันครบ", () => {
    const out = computeDayStatuses({ ...base, records: [record("2026-09-01", 3), record("2026-09-02", 8)] });
    expect(out.get("2026-09-01")).toBe("half_day");
    expect(out.get("2026-09-02")).toBe("completed");
  });

  it("วันหยุด + เข้าไม่ออก = holiday_open ไม่ใช่ขาดงาน", () => {
    const out = computeDayStatuses({
      ...base,
      records: [record("2026-09-05", null)],
      holidays: new Set(["2026-09-05"]),
    });
    expect(out.get("2026-09-05")).toBe("holiday_open");
  });

  it("วันธรรมดาที่ผ่านมาแล้วและไม่มีบันทึก = ขาดงาน (เจ้าของต้องเห็น)", () => {
    const out = computeDayStatuses({ ...base, records: [] });
    expect(out.get("2026-09-03")).toBe("absent");
  });

  it("วันนอกช่วงที่โหลดข้อมูลมา ต้องไม่ถูกมาร์กว่าขาดงาน", () => {
    const out = computeDayStatuses({ ...base, records: [], scanFrom: "2026-09-06", scanTo: "2026-09-30" });
    expect(out.get("2026-09-03")).toBe("off");
    expect(out.get("2026-09-07")).toBe("absent");
  });
});

describe("migration ครึ่งวัน", () => {
  it("เพิ่มคอลัมน์ half_day_max_hours พร้อมค่าเริ่มต้นและขอบเขต", () => {
    const path = "supabase/migrations/20260906000000_hr_half_day.sql";
    expect(existsSync(join(process.cwd(), path))).toBe(true);
    const sql = readFileSync(join(process.cwd(), path), "utf8").toLowerCase().replace(/\s+/g, " ");
    // ค่าเริ่มต้นต้องเป็น 0 = ปิด: การเปิดให้ทุกร้านอัตโนมัติจะไปลดค่าแรงโดยที่ร้านไม่ได้สั่ง
    expect(sql).toContain("add column if not exists half_day_max_hours numeric(4,2) not null default 0");
    expect(sql).toContain("check (half_day_max_hours >= 0 and half_day_max_hours <= 24)");
  });
});
