import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { computePayrollLines, otForDay, buildOtDayRules } from "@/modules/hr/payroll";
import { computeAdvancedPayrollLines, type AdvancedComputeContext } from "@/modules/hr/advanced/compute";
import { DEFAULT_ADVANCED_PAYROLL_SETTINGS } from "@/modules/hr/advanced/settings";
import { DEFAULT_HR_SETTINGS, type EmployeeProfile, type StoreHrSettings } from "@/modules/hr/types";
import type { AttendanceRecord, PayrollSummary } from "@/modules/attendance/types";
import { earliestOtDayDate, findPaidLock, toCalendarOtDays, validateOtDayInput } from "@/modules/hr/ot-days";

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");
const TZ = "Asia/Bangkok";

function hr(over: Partial<StoreHrSettings> = {}): StoreHrSettings {
  return { storeId: "s1", organizationId: "o1", ...DEFAULT_HR_SETTINGS, createdAt: "", updatedAt: "", ...over };
}

function prof(over: Partial<EmployeeProfile> = {}): EmployeeProfile {
  return {
    id: "p1",
    organizationId: "o1",
    storeId: "s1",
    userId: "u1",
    payType: "daily",
    monthlySalary: 0,
    dailyRate: 400,
    hourlyRate: 0,
    lateGraceMinutes: 0,
    latePenaltyAmount: 0,
    absentPenaltyAmount: 0,
    workingDays: [],
    otEligible: true,
    employmentType: "daily",
    createdAt: "",
    updatedAt: "",
    ...over,
  };
}

/** ลงเวลา 1 วัน ทำ hours ชั่วโมง (เข้า 08:00 เวลาไทย) */
function rec(date: string, hours: number, userId = "u1"): AttendanceRecord {
  const inAt = new Date(`${date}T01:00:00Z`);
  const outAt = new Date(inAt.getTime() + hours * 3_600_000);
  return {
    id: `${userId}-${date}`,
    storeId: "s1",
    organizationId: "o1",
    userId,
    employeeName: userId,
    date,
    clockInAt: inAt.toISOString(),
    clockOutAt: outAt.toISOString(),
    status: "completed",
    createdAt: "",
    updatedAt: "",
  };
}

function sum(records: AttendanceRecord[], userId = "u1"): PayrollSummary {
  const mine = records.filter((r) => r.userId === userId);
  const totalHours = mine.reduce((s, r) => s + (Date.parse(r.clockOutAt!) - Date.parse(r.clockInAt)) / 3_600_000, 0);
  return {
    id: userId, storeId: "s1", organizationId: "o1", userId, employeeName: userId,
    periodStart: "2026-11-01", periodEnd: "2026-11-30",
    totalDays: new Set(mine.map((r) => r.date)).size, totalHours, regularHours: totalHours, overtimeHours: 0,
    totalPay: 0, records: [], generatedAt: "",
  };
}

const NOV = { periodStart: "2026-11-01", periodEnd: "2026-11-30", today: "2026-11-30", timezone: TZ };

function run(opts: {
  records: AttendanceRecord[];
  profiles?: EmployeeProfile[];
  settings?: StoreHrSettings;
  otDays?: { date: string; capHours: number; multiplier: number | null; userIds: string[] }[];
}) {
  const profiles = opts.profiles ?? [prof()];
  return computePayrollLines({
    summaries: profiles.map((p) => sum(opts.records, p.userId)),
    records: opts.records,
    profiles,
    adjustments: [],
    settings: opts.settings ?? hr(),
    otDays: opts.otDays,
    ...NOV,
  });
}

describe("โหมด OT ทุกวัน (แบบเดิม) — ต้องได้เท่าเดิมทุกสตางค์", () => {
  it("รายวัน ฿400 ทำ 11 ชม. = OT 2 ชม. (ติดเพดานร้าน) × 1.5 × ฿50", () => {
    const [l] = run({ records: [rec("2026-11-20", 11)] });
    expect(l.otHours).toBe(2);
    expect(l.otPay).toBe(150);
    expect(l.otMultiplierUsed).toBe(1.5);
  });

  it("มีรายการวันให้ OT แต่ยังเป็นโหมดทุกวัน = ไม่สนใจรายการ", () => {
    const [l] = run({
      records: [rec("2026-11-20", 13)],
      otDays: [{ date: "2026-11-20", capHours: 4, multiplier: 2, userIds: ["u1"] }],
    });
    expect(l.otHours).toBe(2);
    expect(l.otPay).toBe(150);
  });

  it("settings เก่าที่ไม่มี otMode/otOverflowPay = แบบเดิม", () => {
    const legacy = { ...hr() } as Partial<StoreHrSettings>;
    delete legacy.otMode;
    delete legacy.otOverflowPay;
    const [l] = run({ records: [rec("2026-11-20", 11)], settings: legacy as StoreHrSettings });
    expect(l.otPay).toBe(150);
  });
});

describe("โหมด OT เฉพาะวันที่กำหนด", () => {
  const scheduled = hr({ otMode: "scheduled" });

  it("ตัวอย่างในแผน: 20 ไม่มี OT · 21 ให้ ≤4 ชม. ทำ 13 = OT 4 × 1.5 × 50 = ฿300 · 22 ไม่มี OT", () => {
    const [l] = run({
      settings: scheduled,
      records: [rec("2026-11-20", 11), rec("2026-11-21", 13), rec("2026-11-22", 10)],
      otDays: [{ date: "2026-11-21", capHours: 4, multiplier: null, userIds: ["u1"] }],
    });
    expect(l.otHours).toBe(4);
    expect(l.otPay).toBe(300);
    expect(l.basePay).toBe(1200); // 3 วัน × 400 ไม่เปลี่ยน
  });

  it("ไม่มีรายการเลย = ไม่มี OT แม้จะมีสิทธิ์ OT", () => {
    const [l] = run({ settings: scheduled, records: [rec("2026-11-20", 12)] });
    expect(l.otHours).toBe(0);
    expect(l.otPay).toBe(0);
  });

  it("คนที่ไม่อยู่ในรายชื่อของวันนั้นไม่ได้ OT · คนที่ไม่ได้ติ๊กมีสิทธิ์ OT แต่ถูกเลือก = ได้", () => {
    const records = [rec("2026-11-21", 12, "u1"), rec("2026-11-21", 12, "u2")];
    const result = run({
      settings: scheduled,
      records,
      profiles: [prof(), prof({ id: "p2", userId: "u2", otEligible: false })],
      otDays: [{ date: "2026-11-21", capHours: 4, multiplier: null, userIds: ["u2"] }],
    });
    const u1 = result.find((l) => l.userId === "u1")!;
    const u2 = result.find((l) => l.userId === "u2")!;
    expect(u1.otHours).toBe(0);
    expect(u2.otHours).toBe(4);
    expect(u2.otPay).toBe(300);
  });

  it("ตัวคูณรายวัน: วันเทศกาล ×2 + วันปกติใช้ค่าร้าน = รวมรายวัน และบอกว่าหลายอัตรา", () => {
    const [l] = run({
      settings: scheduled,
      records: [rec("2026-11-21", 10), rec("2026-11-22", 10)],
      otDays: [
        { date: "2026-11-21", capHours: 4, multiplier: 2, userIds: ["u1"] },
        { date: "2026-11-22", capHours: 4, multiplier: null, userIds: ["u1"] },
      ],
    });
    // 2 ชม. × 2 × 50 + 2 ชม. × 1.5 × 50 = 200 + 150
    expect(l.otHours).toBe(4);
    expect(l.otPay).toBe(350);
    expect(l.otMultiplierUsed).toBeNull();
  });

  it("ตัวคูณรายวันเท่ากันทุกวัน = แสดงตัวคูณนั้น", () => {
    const [l] = run({
      settings: scheduled,
      records: [rec("2026-11-21", 10)],
      otDays: [{ date: "2026-11-21", capHours: 4, multiplier: 2, userIds: ["u1"] }],
    });
    expect(l.otMultiplierUsed).toBe(2);
    expect(l.otPay).toBe(200);
  });
});

describe("ชั่วโมงที่เกินแต่ไม่ได้เป็น OT (รายชั่วโมง)", () => {
  const hourly = prof({ payType: "hourly", hourlyRate: 60, dailyRate: 0 });

  it("regular (ค่าเริ่มต้น): วันไม่มี OT ทำ 11 ชม. = จ่าย 11 × 60", () => {
    const [l] = run({ settings: hr({ otMode: "scheduled" }), records: [rec("2026-11-20", 11)], profiles: [hourly] });
    expect(l.basePay).toBe(660);
    expect(l.unpaidOverflowHours).toBe(0);
  });

  it("none: วันไม่มี OT ทำ 11 ชม. = จ่ายแค่ 8 × 60 · บันทึกชั่วโมงที่ไม่จ่าย 3", () => {
    const [l] = run({ settings: hr({ otMode: "scheduled", otOverflowPay: "none" }), records: [rec("2026-11-20", 11)], profiles: [hourly] });
    expect(l.basePay).toBe(480);
    expect(l.regularHours).toBe(8);
    expect(l.unpaidOverflowHours).toBe(3);
  });

  it("none: วันมี OT ≤2 ชม. ทำ 12 = ปกติ 8 + OT 2 · 2 ชม. ที่เกินเพดานไม่จ่าย", () => {
    const [l] = run({
      settings: hr({ otMode: "scheduled", otOverflowPay: "none" }),
      records: [rec("2026-11-21", 12)],
      profiles: [hourly],
      otDays: [{ date: "2026-11-21", capHours: 2, multiplier: null, userIds: ["u1"] }],
    });
    expect(l.basePay).toBe(480);
    expect(l.otPay).toBe(180);
    expect(l.unpaidOverflowHours).toBe(2);
  });

  it("none ใช้กับโหมดทุกวันด้วย: เกินเพดานร้านไม่จ่าย", () => {
    const [l] = run({ settings: hr({ otOverflowPay: "none" }), records: [rec("2026-11-20", 11)], profiles: [hourly] });
    expect(l.otPay).toBe(180); // 2 × 1.5 × 60
    expect(l.basePay).toBe(480);
  });

  it("รายวันไม่ได้รับผลจาก none", () => {
    const [l] = run({ settings: hr({ otMode: "scheduled", otOverflowPay: "none" }), records: [rec("2026-11-20", 11)] });
    expect(l.basePay).toBe(400);
    expect(l.unpaidOverflowHours).toBe(0);
  });
});

describe("หลายเรทกลางงวด ใช้กติกา OT ชุดเดียวกัน", () => {
  it("ขึ้นค่าแรงรายวันกลางงวด: OT คิดตามวันในรายการ + เรทของวันนั้น", () => {
    const records = [rec("2026-11-10", 12), rec("2026-11-25", 12)];
    const ctx: AdvancedComputeContext = {
      settings: DEFAULT_ADVANCED_PAYROLL_SETTINGS,
      employees: new Map([["u1", { skills: [], rates: [
        { payType: "daily", monthlySalary: 0, dailyRate: 400, hourlyRate: 0, effectiveFrom: "2026-01-01" },
        { payType: "daily", monthlySalary: 0, dailyRate: 480, hourlyRate: 0, effectiveFrom: "2026-11-20" },
      ] }]]),
      dailySales: new Map(),
      maxSalesBeforePeriod: 0,
    };
    const [l] = computeAdvancedPayrollLines(
      {
        summaries: [sum(records)],
        records,
        profiles: [prof()],
        adjustments: [],
        settings: hr({ otMode: "scheduled" }),
        otDays: [{ date: "2026-11-25", capHours: 4, multiplier: 2, userIds: ["u1"] }],
        ...NOV,
      },
      ctx,
    );
    // 10 พ.ย. ไม่อยู่ในรายการ = 0 · 25 พ.ย. OT 4 × 2 × (480/8) = 480
    expect(l.otHours).toBe(4);
    expect(l.otPay).toBe(480);
    expect(l.otMultiplierUsed).toBe(2);
  });
});

describe("เริ่มงานกลางงวด + ขึ้นค่าแรงกลางงวด + OT เฉพาะวัน (ทางเดินซับซ้อนสุด)", () => {
  it("เริ่ม 15 พ.ย. · ค่าแรง 400→480 ตั้งแต่ 20 · OT 12 (ก่อนเริ่มงาน) / 22 (≤3 ×2) / 25 (ไม่อยู่ในรายการ)", () => {
    const records = [rec("2026-11-16", 9), rec("2026-11-22", 12), rec("2026-11-25", 12)];
    const ctx: AdvancedComputeContext = {
      settings: DEFAULT_ADVANCED_PAYROLL_SETTINGS,
      employees: new Map([["u1", { skills: [], rates: [
        { payType: "daily", monthlySalary: 0, dailyRate: 400, hourlyRate: 0, effectiveFrom: "2026-01-01" },
        { payType: "daily", monthlySalary: 0, dailyRate: 480, hourlyRate: 0, effectiveFrom: "2026-11-20" },
      ] }]]),
      dailySales: new Map(),
      maxSalesBeforePeriod: 0,
    };
    const [l] = computeAdvancedPayrollLines(
      {
        summaries: [sum(records)],
        records,
        profiles: [prof({ seniorityStartDate: "2026-11-15" })],
        adjustments: [],
        settings: hr({ otMode: "scheduled" }),
        otDays: [
          { date: "2026-11-12", capHours: 4, multiplier: null, userIds: ["u1"] },
          { date: "2026-11-22", capHours: 3, multiplier: 2, userIds: ["u1"] },
        ],
        ...NOV,
      },
      ctx,
    );
    expect(l.days[0].date).toBe("2026-11-15");
    // 16 พ.ย. 400 + 22, 25 พ.ย. 480 × 2
    expect(l.basePay).toBe(1360);
    // เฉพาะ 22 พ.ย.: OT 3 ชม. (เกิน 4 ตัดที่ 3) × 2 × 60
    expect(l.otHours).toBe(3);
    expect(l.otPay).toBe(360);
    expect(l.otMultiplierUsed).toBe(2);
  });
});

describe("otForDay / buildOtDayRules", () => {
  it("วันที่ไม่ได้เกินชั่วโมงปกติ = ไม่มี OT และไม่มีชั่วโมงไม่จ่าย", () => {
    const r = otForDay({
      settings: hr({ otMode: "scheduled", otOverflowPay: "none" }),
      rules: buildOtDayRules([{ date: "2026-11-21", capHours: 4, multiplier: null, userIds: ["u1"] }]),
      profile: { otEligible: true },
      userId: "u1",
      date: "2026-11-21",
      dayHours: 7,
    });
    expect(r).toEqual({ otHours: 0, multiplier: 1.5, unpaidHours: 0 });
  });
});

describe("กฎให้ OT ย้อนหลัง 7 วัน + งวดที่จ่ายแล้ว", () => {
  const roster = new Set(["u1", "u2"]);
  const base = { capHours: 4, multiplier: null, userIds: ["u1"], today: "2026-11-21", rosterUserIds: roster };

  it("ย้อนได้ถึง 7 วันพอดี (14 พ.ย.) · 8 วัน (13 พ.ย.) ไม่ได้", () => {
    expect(earliestOtDayDate("2026-11-21")).toBe("2026-11-14");
    expect(validateOtDayInput({ ...base, from: "2026-11-14", to: "2026-11-14" }).ok).toBe(true);
    const bad = validateOtDayInput({ ...base, from: "2026-11-13", to: "2026-11-13" });
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.error).toContain("ไม่เกิน 7 วัน");
  });

  it("ข้ามเดือน/ปี นับถูก", () => {
    expect(earliestOtDayDate("2027-01-03")).toBe("2026-12-27");
  });

  it("ขยายช่วงเป็นรายวัน · วันจบเว้นว่าง = วันเดียว", () => {
    const r = validateOtDayInput({ ...base, from: "2026-12-30", to: "2027-01-02" });
    expect(r.ok && r.draft.dates).toEqual(["2026-12-30", "2026-12-31", "2027-01-01", "2027-01-02"]);
    const one = validateOtDayInput({ ...base, from: "2026-11-25", to: "" });
    expect(one.ok && one.draft.dates).toEqual(["2026-11-25"]);
  });

  it("ปฏิเสธ: ไม่เลือกพนักงาน · คนนอกสาขา · เพดาน 0 / เกิน 12 · ตัวคูณนอก 1–5 · วันที่ผิด · ช่วงยาวเกิน", () => {
    expect(validateOtDayInput({ ...base, from: "2026-11-25", to: "2026-11-25", userIds: [] }).ok).toBe(false);
    expect(validateOtDayInput({ ...base, from: "2026-11-25", to: "2026-11-25", userIds: ["x"] }).ok).toBe(false);
    expect(validateOtDayInput({ ...base, from: "2026-11-25", to: "2026-11-25", capHours: 0 }).ok).toBe(false);
    expect(validateOtDayInput({ ...base, from: "2026-11-25", to: "2026-11-25", capHours: 13 }).ok).toBe(false);
    expect(validateOtDayInput({ ...base, from: "2026-11-25", to: "2026-11-25", multiplier: 0.5 }).ok).toBe(false);
    expect(validateOtDayInput({ ...base, from: "2026-02-30", to: "2026-02-30" }).ok).toBe(false);
    expect(validateOtDayInput({ ...base, from: "2026-11-25", to: "2026-11-24" }).ok).toBe(false);
    expect(validateOtDayInput({ ...base, from: "2026-11-21", to: "2027-02-01" }).ok).toBe(false);
  });

  it("งวดที่ปิดแล้วล็อก · งวดที่เปิดแก้ (reopened) ไม่ล็อก", () => {
    const periods = [{ periodStart: "2026-11-01", periodEnd: "2026-11-15", status: "closed" as const }];
    expect(findPaidLock(["2026-11-14", "2026-11-16"], ["u1"], periods, [])?.date).toBe("2026-11-14");
    expect(findPaidLock(["2026-11-16"], ["u1"], periods, [])).toBeNull();
    expect(findPaidLock(["2026-11-14"], ["u1"], [{ ...periods[0], status: "reopened" }], [])).toBeNull();
  });

  it("สัปดาห์ที่บันทึกยอดรายสัปดาห์แล้ว ล็อกเฉพาะเมื่อมีคนนั้นอยู่ในรายชื่อ", () => {
    const weeks = [{ userId: "u2", weekStart: "2026-11-16", weekEnd: "2026-11-22" }];
    expect(findPaidLock(["2026-11-18"], ["u1"], [], weeks)).toBeNull();
    expect(findPaidLock(["2026-11-18"], ["u1", "u2"], [], weeks)?.reason).toContain("รายสัปดาห์");
  });
});

describe("ต่อสายครบทุกเส้นทาง (source)", () => {
  it("migration: ค่าเริ่มต้น = แบบเดิม · ตาราง store_ot_days + RLS อ่านอย่างเดียว", () => {
    const sql = read("supabase/migrations/20261128120000_scheduled_ot_days.sql");
    expect(sql).toContain("ot_mode text not null default 'daily'");
    expect(sql).toContain("ot_overflow_pay text not null default 'regular'");
    expect(sql).toContain("create table if not exists store_ot_days");
    expect(sql).toContain("unique (store_id, date)");
    expect(sql).toContain("enable row level security");
    expect(sql).not.toMatch(/on store_ot_days for (all|insert|update|delete)/);
  });

  it("หน้าเงินเดือน สลิป และปิดงวด ส่ง otDays เข้า compute", () => {
    for (const f of ["src/app/(dashboard)/staff/page.tsx", "src/app/payslip/page.tsx", "src/modules/hr/advanced/store-payroll.ts"]) {
      const src = read(f);
      expect(src, f).toContain("listStoreOtDays(");
      expect(src, f).toMatch(/\n\s+otDays,\n/);
    }
  });

  it("action ตรวจสิทธิ์ + กฎย้อนหลัง + ล็อกงวด + log ทั้งเพิ่มและลบ", () => {
    const src = read("src/app/(dashboard)/staff/ot-day-actions.ts");
    expect(src.match(/requirePermission\("attendance\.manage"\)/g)?.length).toBe(2);
    expect(src.match(/validateOtDayInput\(/g)?.length).toBe(2);
    expect(src.match(/findPaidLock\(/g)?.length).toBe(2);
    expect(src).toContain('"otDayBackdated"');
    expect(src).toContain('"otDayDeleted"');
  });
});

describe("จุดบอกวันให้ OT บนปฏิทินลงเวลา", () => {
  const rows = [
    { date: "2026-11-21", capHours: 4, multiplier: 2, userIds: ["u1", "u2"], note: "เทศกาล" },
    { date: "2026-11-20", capHours: 2.5, multiplier: null, userIds: ["u2"] },
  ];

  it("ปฏิทินส่วนตัว: เหลือเฉพาะวันที่ตัวเองได้ และไม่ส่งรายชื่อคนอื่น", () => {
    const mine = toCalendarOtDays(rows, "u1");
    expect(mine).toEqual([{ date: "2026-11-21", capHours: 4, multiplier: 2, userIds: ["u1"], note: "เทศกาล" }]);
    expect(toCalendarOtDays(rows, "u3")).toEqual([]);
  });

  it("ปฏิทินทีม: ครบทุกวัน เรียงวันที่ พร้อมรายชื่อ", () => {
    const team = toCalendarOtDays(rows);
    expect(team.map((d) => d.date)).toEqual(["2026-11-20", "2026-11-21"]);
    expect(team[1].userIds).toEqual(["u1", "u2"]);
    expect(team[0].note).toBeNull();
  });

  it("หน้าลงเวลาโหลดวัน OT เฉพาะโหมด scheduled และส่งเข้าปฏิทินทั้งสองแบบ", () => {
    const page = read("src/app/(dashboard)/attendance/page.tsx");
    expect(page).toContain('hrSettings.otMode === "scheduled"');
    expect(page.match(/loadCalendarOtDays\(/g)?.length).toBe(2);
    // DB error = log + ไม่แสดงป้าย ห้ามทำหน้าลงเวลาพัง
    expect(page).toContain('action: "loadCalendarOtDays"');
    expect(page).toMatch(/listStoreOtDays\(ctx\.storeId, from, to\)\.catch\(/);
    expect(page).toContain("toCalendarOtDays(myOtDayRows, user.id)");
    const manager = read("src/app/(dashboard)/attendance/AttendanceManager.tsx");
    expect(manager).toContain("otDays={myOtDays}");
    expect(manager).toContain("otDays={teamOtDays}");
    const calendar = read("src/app/(dashboard)/attendance/AttendanceCalendar.tsx");
    expect(calendar).toContain("data-ot-day");
    expect(calendar).toContain("ot.userIds.filter((id) => id === filterUser)");
    expect(calendar).toContain("วันให้ OT");
  });
});
