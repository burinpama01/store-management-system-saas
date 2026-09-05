import { redirect } from "next/navigation";
import { getOrganizationBillingState } from "@/modules/billing/billing-service";
import {
  DEFAULT_BILLING_STATE,
  getPlanFeatures,
} from "@/modules/billing/types";
import { getResolvedCurrentPermissions } from "@/modules/auth/guards";
import {
  getActiveRecordToday,
  listAttendanceRecords,
  computePayrollSummaries,
  getAttendanceSettings,
} from "@/modules/attendance/repository";
import { getStoreLocalDate } from "@/modules/attendance/date";
import { countSelfBackdated, nextMonthStart, listStoreHolidays } from "@/modules/attendance/repository";
import { computeDayStatuses, type DayStatus } from "@/modules/attendance/calendar";
import { getStoreHrSettings, listEmployeeProfiles, listLeaveDatesForUser, listPayrollAdjustments } from "@/modules/hr/repository";
import { listStoreMemberships } from "@/modules/settings/repository";
import { listBranchStores } from "@/modules/stores/repository";
import { AttendanceManager } from "./AttendanceManager";
import type { AttendanceRecord, PayrollSummary } from "@/modules/attendance/types";
import type { PayrollAdjustment } from "@/modules/hr/types";

export const dynamic = "force-dynamic";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isValidDate(s: string) {
  if (!DATE_RE.test(s) || isNaN(Date.parse(s))) return false;
  return new Date(s).toISOString().startsWith(s);
}

export default async function AttendancePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string>>;
}) {
  const { user, ctx, resolved } = await getResolvedCurrentPermissions();
  if (!resolved.can("attendance.clock")) redirect("/dashboard");
  const billingState =
    (await getOrganizationBillingState(ctx.organizationId)) ??
    DEFAULT_BILLING_STATE;
  const features = getPlanFeatures(billingState);

  const today = getStoreLocalDate(ctx.storeTimezone);
  const monthStart = today.slice(0, 7) + "-01";
  const [todayRecord, attendanceSettingsResult, hrSettings, backdatedUsed, myRecRes] = await Promise.all([
    // Org-wide active record: show the clock-out button wherever the shift was opened.
    getActiveRecordToday(user.id, ctx.organizationId, today),
    getAttendanceSettings(ctx.storeId, ctx.organizationId),
    getStoreHrSettings(ctx.storeId, ctx.organizationId),
    countSelfBackdated(user.id, ctx.storeId, monthStart, nextMonthStart(today)),
    // The viewer's own clock-in/out for this month — powers the personal calendar shown to everyone.
    listAttendanceRecords(ctx.organizationId, ctx.storeId, monthStart, today, user.id),
  ]);
  const attendanceSettings = attendanceSettingsResult.data;
  const myMonthRecords = myRecRes.data ?? [];
  const currentMonth = today.slice(0, 7);

  // Month bounds (full month) for holidays/leave so future days in the month show too.
  const [my, mm] = currentMonth.split("-").map(Number);
  const monthEnd = `${currentMonth}-${String(new Date(Date.UTC(my, mm, 0)).getUTCDate()).padStart(2, "0")}`;

  // Per-day status for the viewer's personal calendar (holiday/leave/absent/late/in-no-out).
  const [holidaysRes, profilesRes, myLeaveDates] = await Promise.all([
    listStoreHolidays(ctx.storeId, monthStart, monthEnd),
    listEmployeeProfiles(ctx.storeId),
    listLeaveDatesForUser(ctx.storeId, user.id, monthStart, monthEnd),
  ]);
  const holidays = holidaysRes.data ?? [];
  const ownProfile = (profilesRes.data ?? []).find((p) => p.userId === user.id) ?? null;
  // Store-level open days are the calendar default; a per-employee schedule still overrides.
  const storeWorkingDays = hrSettings.workingDays?.length ? hrSettings.workingDays : [0, 1, 2, 3, 4, 5, 6];
  const effectiveWorkingDays =
    ownProfile?.workingDays?.length ? ownProfile.workingDays : storeWorkingDays;
  const dayStatusMap = computeDayStatuses({
    month: currentMonth,
    today,
    timezone: ctx.storeTimezone,
    records: myMonthRecords,
    profile: {
      expectedStartTime: ownProfile?.expectedStartTime,
      lateGraceMinutes: ownProfile?.lateGraceMinutes ?? 0,
      workingDays: effectiveWorkingDays,
    },
    holidays: new Set(holidays.map((h) => h.date)),
    leaveDates: new Set(myLeaveDates),
    halfDayMaxHours: hrSettings.halfDayMaxHours,
  });
  const dayStatus = Object.fromEntries(dayStatusMap);
  const holidayDates = holidays.map((h) => h.date);
  const canManageHolidays = resolved.can("settings.manage_store");

  const canManage = resolved.can("attendance.manage");

  let dateFrom = today.slice(0, 7) + "-01";
  let dateTo = today;
  let records: AttendanceRecord[] | null = null;
  let payrollSummaries: PayrollSummary[] | null = null;
  let members: { userId: string; name: string }[] = [];
  let leaveAdjustments: PayrollAdjustment[] = [];
  let branchStores: { id: string; name: string }[] = [];
  let branchFilter = ctx.storeId;
  // ปฏิทินทีม: สถานะรายวันของพนักงานแต่ละคน (ครบ/สาย/ครึ่งวัน/ขาด/ลา/วันหยุด)
  let teamDayStatus: Record<string, Record<string, DayStatus>> = {};

  if (canManage) {
    const params = await searchParams;
    if (isValidDate(params.dateFrom ?? "")) dateFrom = params.dateFrom!;
    if (isValidDate(params.dateTo ?? "")) dateTo = params.dateTo!;
    if (dateFrom > dateTo) [dateFrom, dateTo] = [dateTo, dateFrom];
    const MS_PER_DAY = 86_400_000;
    const MAX_DAYS = 92;
    if ((Date.parse(dateTo) - Date.parse(dateFrom)) / MS_PER_DAY > MAX_DAYS) {
      dateTo = new Date(Date.parse(dateFrom) + MAX_DAYS * MS_PER_DAY)
        .toISOString()
        .split("T")[0];
    }

    // พนักงานลงเวลาที่สาขาของตัวเอง แต่คอมที่เปิดดูอาจอยู่คนละสาขา — org ที่มี
    // หลายสาขาจึงดูแบบ "ทุกสาขา" เป็นค่าเริ่มต้น (เลือกกรองรายสาขาได้)
    const branchesRes = await listBranchStores(ctx.organizationId);
    branchStores = (branchesRes.data ?? []).map((s) => ({ id: s.id, name: s.name }));
    const requestedBranch = params.branch ?? "";
    branchFilter =
      requestedBranch === "all" || branchStores.some((s) => s.id === requestedBranch)
        ? (requestedBranch || (branchStores.length > 1 ? "all" : ctx.storeId))
        : branchStores.length > 1
          ? "all"
          : ctx.storeId;
    const recordStoreId = branchFilter === "all" ? null : branchFilter;

    const [recRes, membersRes, adjustmentsRes] = await Promise.all([
      listAttendanceRecords(ctx.organizationId, recordStoreId, dateFrom, dateTo),
      listStoreMemberships(ctx.organizationId, ctx.storeId),
      listPayrollAdjustments(ctx.storeId, dateFrom, dateTo),
    ]);
    records = recRes.data ?? [];
    leaveAdjustments = (adjustmentsRes.data ?? []).filter((a) => a.type === "leave");
    payrollSummaries = computePayrollSummaries(
      records,
      recordStoreId,
      ctx.organizationId,
      dateFrom,
      dateTo,
    );
    members = (membersRes.data ?? [])
      .filter((m) => m.role !== "super_admin")
      .map((m) => ({ userId: m.userId, name: m.email }));

    // สถานะรายวันต่อคนสำหรับปฏิทินทีม — คิดเฉพาะเดือนที่ปฏิทินแสดง และเฉพาะช่วงวันที่
    // ที่โหลด record มาจริง (วันนอกช่วงต้องไม่ถูกมาร์กว่าขาดงาน)
    const calendarMonth = dateFrom.slice(0, 7);
    const [cy, cm] = calendarMonth.split("-").map(Number);
    const calMonthStart = `${calendarMonth}-01`;
    const calMonthEnd = `${calendarMonth}-${String(new Date(Date.UTC(cy, cm, 0)).getUTCDate()).padStart(2, "0")}`;
    const calHolidaysRes = await listStoreHolidays(ctx.storeId, calMonthStart, calMonthEnd);
    const calHolidays = new Set((calHolidaysRes.data ?? []).map((h) => h.date));
    const profiles = profilesRes.data ?? [];
    const scanFrom = dateFrom > calMonthStart ? dateFrom : calMonthStart;
    const scanTo = dateTo < today ? dateTo : today;

    const statusByDate: Record<string, Record<string, DayStatus>> = {};
    for (const member of members) {
      const profile = profiles.find((p) => p.userId === member.userId) ?? null;
      const memberStatuses = computeDayStatuses({
        month: calendarMonth,
        today,
        timezone: ctx.storeTimezone,
        records: (records ?? []).filter((r) => r.userId === member.userId),
        profile: {
          expectedStartTime: profile?.expectedStartTime,
          lateGraceMinutes: profile?.lateGraceMinutes ?? 0,
          workingDays: profile?.workingDays?.length ? profile.workingDays : storeWorkingDays,
        },
        holidays: calHolidays,
        leaveDates: new Set(
          leaveAdjustments.filter((a) => a.userId === member.userId).map((a) => a.date),
        ),
        halfDayMaxHours: hrSettings.halfDayMaxHours,
        scanFrom,
        scanTo,
      });
      for (const [date, status] of memberStatuses) {
        if (status === "off") continue;
        (statusByDate[date] ??= {})[member.userId] = status;
      }
    }
    teamDayStatus = statusByDate;
  }

  return (
    <AttendanceManager
      todayRecord={todayRecord}
      canManage={canManage}
      records={records}
      payrollSummaries={payrollSummaries}
      dateFrom={dateFrom}
      dateTo={dateTo}
      canUseGps={features.attendanceGps}
      userEmail={user.email ?? user.id}
      storeTimezone={ctx.storeTimezone}
      attendanceSettings={attendanceSettings}
      members={members}
      today={today}
      backdatedRights={hrSettings.backdatedRightsPerMonth}
      backdatedUsed={backdatedUsed}
      storeWorkingDays={storeWorkingDays}
      myMonthRecords={myMonthRecords}
      currentMonth={currentMonth}
      dayStatus={dayStatus}
      holidays={holidays}
      holidayDates={holidayDates}
      canManageHolidays={canManageHolidays}
      leaveAdjustments={leaveAdjustments}
      teamDayStatus={teamDayStatus}
      branchStores={branchStores}
      branchFilter={branchFilter}
    />
  );
}
