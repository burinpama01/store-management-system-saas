import { redirect } from "next/navigation";
import { getResolvedCurrentPermissions } from "@/modules/auth/guards";
import { listStoreMemberships } from "@/modules/settings/repository";
import { listEmployeeProfiles, listPayrollAdjustments, getStoreHrSettings } from "@/modules/hr/repository";
import {
  listAttendanceRecords,
  computePayrollSummaries,
  listStoreHolidays,
} from "@/modules/attendance/repository";
// computePayrollLines เดิมถูกห่อด้วย computeAdvancedPayrollLines (ไม่มีสิทธิ์/ปิดสวิตช์ = ผลเท่าเดิม)
import { computeAdvancedPayrollLines, joinedDatesFromMembers } from "@/modules/hr/advanced/compute";
import { getAdvancedPayrollAccess, loadAdvancedContext } from "@/modules/hr/advanced/store-payroll";
import { getCashOnHand, listEmployeeSkillGrants, listPayrollPeriods, listSalaryAdvances, listStoreSkills, listWeeklyPayouts } from "@/modules/hr/advanced/repository";
import { recentWeeks } from "@/modules/hr/advanced/weekly";
import { businessDate, periodContaining, recentPeriods } from "@/modules/hr/advanced/pay-cycle";
import { maskBankAccount } from "@/modules/hr/employee-identity";
import { listEmployeeSelfInfo, listPendingSelfInfoRequests } from "@/modules/hr/self-info-repository";
import { getStore } from "@/modules/stores/repository";
import { getStoreLocalDate } from "@/modules/attendance/date";
import { StaffManager } from "./StaffManager";

export const dynamic = "force-dynamic";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isValidDate = (s: string) => DATE_RE.test(s) && !isNaN(Date.parse(s));

export default async function StaffPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string>>;
}) {
  const { ctx, resolved } = await getResolvedCurrentPermissions();
  if (!resolved.can("attendance.manage")) redirect("/dashboard");

  const params = await searchParams;
  const today = getStoreLocalDate(ctx.storeTimezone);
  const [access, storeForCycle] = await Promise.all([
    getAdvancedPayrollAccess(ctx.organizationId, ctx.storeId),
    getStore(ctx.storeId),
  ]);
  const asw = access.settings.switches;
  const businessToday = businessDate(new Date(), ctx.storeTimezone, storeForCycle.data?.closingTime ?? null);
  // เปิดรอบเงินเดือน = ค่าเริ่มต้นเป็นงวดปัจจุบัน (เช่น 24–23) แทนวันที่ 1 ถึงวันนี้
  const currentPeriod = asw.payCycle
    ? periodContaining(businessToday, access.settings.payCycleStartDay, access.settings.payDay)
    : null;
  let dateFrom = isValidDate(params.dateFrom ?? "") ? params.dateFrom! : currentPeriod?.start ?? today.slice(0, 7) + "-01";
  let dateTo = isValidDate(params.dateTo ?? "") ? params.dateTo! : currentPeriod?.end ?? today;
  if (dateFrom > dateTo) [dateFrom, dateTo] = [dateTo, dateFrom];

  const [membersRes, profilesRes, recordsRes, adjustmentsRes, holidaysRes, storeRes, hrSettings, selfInfoMap, selfInfoRequests] = await Promise.all([
    listStoreMemberships(ctx.organizationId, ctx.storeId),
    listEmployeeProfiles(ctx.storeId),
    // Attendance is read org-wide (null) and then narrowed to this store's roster below: a shift
    // covered at another branch still belongs to the employee, and to the payroll of the branch
    // that pays them. Filtering by punch location instead would score it as absence.
    listAttendanceRecords(ctx.organizationId, null, dateFrom, dateTo),
    listPayrollAdjustments(ctx.storeId, dateFrom, dateTo),
    listStoreHolidays(ctx.storeId, dateFrom, dateTo),
    getStore(ctx.storeId),
    getStoreHrSettings(ctx.storeId, ctx.organizationId),
    listEmployeeSelfInfo(ctx.storeId),
    listPendingSelfInfoRequests(ctx.storeId),
  ]);

  const members = membersRes.data ?? [];
  const roster = new Set(members.filter((m) => m.role !== "super_admin").map((m) => m.userId));
  const records = (recordsRes.data ?? []).filter((r) => roster.has(r.userId));
  const summaries = computePayrollSummaries(records, null, ctx.organizationId, dateFrom, dateTo);
  const profiles = profilesRes.data ?? [];
  // เลขบัญชีเต็มห้ามไปถึง browser (RSC payload) — ส่งแค่แบบปิดหลัก
  const clientProfiles = profiles.map(({ bankAccountNo, ...p }) => ({
    ...p,
    bankAccountMasked: maskBankAccount(bankAccountNo),
  }));
  const adjustments = adjustmentsRes.data ?? [];
  // ข้อมูลที่พนักงานกรอกเอง — เลขบัญชีเต็มไม่ส่งไป browser เช่นกัน
  const selfInfo = Object.fromEntries(
    [...selfInfoMap].map(([userId, { bankAccountNo, ...rest }]) => [userId, { ...rest, bankAccountMasked: maskBankAccount(bankAccountNo) }]),
  );
  const weeks = asw.weeklyPay ? recentWeeks(businessToday, access.settings.weeklyStartDay, 9) : [];
  const [adv, skills, skillGrants, closedRows, weeklyRows, advanceRows, cashNow] = await Promise.all([
    loadAdvancedContext(ctx.storeId, access.settings, dateFrom, dateTo),
    access.entitled ? listStoreSkills(ctx.storeId) : Promise.resolve([]),
    asw.skillPay ? listEmployeeSkillGrants(ctx.storeId) : Promise.resolve(new Map()),
    asw.payCycle ? listPayrollPeriods(ctx.storeId) : Promise.resolve([]),
    weeks.length ? listWeeklyPayouts(ctx.storeId, weeks[weeks.length - 1].start) : Promise.resolve([]),
    asw.salaryAdvance ? listSalaryAdvances(ctx.storeId, { limit: 60 }) : Promise.resolve([]),
    asw.salaryAdvance ? getCashOnHand(ctx.storeId).catch(() => null) : Promise.resolve(null),
  ]);
  const nameOf = (userId: string) =>
    profiles.find((p) => p.userId === userId)?.displayName || members.find((m) => m.userId === userId)?.email || "พนักงาน";
  const employeeSkillIds: Record<string, string[]> = {};
  for (const [userId, grants] of skillGrants) {
    employeeSkillIds[userId] = (grants as { skillId: string; revokedAt?: string | null }[])
      .filter((g) => !g.revokedAt)
      .map((g) => g.skillId);
  }
  const payrollLines = computeAdvancedPayrollLines({
    summaries,
    records,
    profiles,
    adjustments,
    settings: hrSettings,
    holidayDates: (holidaysRes.data ?? []).map((h) => h.date),
    periodStart: dateFrom,
    periodEnd: dateTo,
    today,
    timezone: ctx.storeTimezone,
    joinedDates: joinedDatesFromMembers(members.filter((m) => m.role !== "super_admin"), ctx.storeTimezone),
  }, adv);

  return (
    <StaffManager
      members={members}
      profiles={clientProfiles}
      selfInfo={selfInfo}
      selfInfoRequests={selfInfoRequests}
      payrollLines={payrollLines}
      adjustments={adjustments}
      hrSettings={hrSettings}
      currency={storeRes.data?.currencyCode ?? "THB"}
      dateFrom={dateFrom}
      dateTo={dateTo}
      today={today}
      canAddStaff={resolved.can("users.manage")}
      advanced={{
        entitled: access.entitled,
        settings: access.settings,
        stored: access.stored,
        skills,
        employeeSkillIds,
        periods: asw.payCycle ? recentPeriods(businessToday, access.settings.payCycleStartDay, access.settings.payDay, 12) : [],
        closedRows,
        businessToday,
        cashOnHand: cashNow?.amount ?? null,
        advances: advanceRows.map((a) => ({
          id: a.id,
          userId: a.userId,
          name: nameOf(a.userId),
          status: a.status,
          requestedAmount: a.requestedAmount,
          approvedAmount: a.approvedAmount,
          reason: a.reason,
          decisionNote: a.decisionNote,
          payMethod: a.payMethod,
          paidDate: a.paidDate,
          createdAt: a.createdAt,
          deducted: a.deducted,
        })),
        weekly: {
          weeks,
          // ส่งเฉพาะที่ต้องแสดง (ไม่มีข้อมูลบัญชีใน data อยู่แล้ว)
          rows: weeklyRows.map((r) => ({
            userId: r.userId,
            weekStart: r.weekStart,
            mode: r.mode,
            amount: r.amount,
            workedDays: Number((r.data as { workedDays?: number }).workedDays ?? 0),
            name: String((r.data as { employeeName?: string }).employeeName ?? ""),
          })),
        },
      }}
    />
  );
}
