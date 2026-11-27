import { redirect } from "next/navigation";
import { getOrganizationBillingState } from "@/modules/billing/billing-service";
import {
  DEFAULT_BILLING_STATE,
  getPlanFeatures,
} from "@/modules/billing/types";
import { getResolvedCurrentPermissions } from "@/modules/auth/guards";
import { getUserStores } from "@/modules/auth/session";
import {
  getActiveRecordToday,
  listAttendanceRecords,
  computePayrollSummaries,
  getAttendanceSettings,
} from "@/modules/attendance/repository";
import { getStoreLocalDate } from "@/modules/attendance/date";
import { nextMonthStart, listStoreHolidays } from "@/modules/attendance/repository";
import { countBackdateRequestsInMonth, listBackdateRequests, type BackdateRequest } from "@/modules/attendance/backdate-requests";
import { computeDayStatuses, employmentWindow, resignedBefore, type DayStatus } from "@/modules/attendance/calendar";
import {
  getStoreHrSettings,
  listEmployeeProfiles,
  listLeaveDatesForUser,
  listPayrollAdjustments,
  listStoreOtDays,
} from "@/modules/hr/repository";
import { toCalendarOtDays, type CalendarOtDay } from "@/modules/hr/ot-days";
import { logSystemEvent } from "@/modules/system/event-log";
import { listStoreMemberships } from "@/modules/settings/repository";
import { listBranchStores } from "@/modules/stores/repository";
import { SalesTargetBar } from "@/shared/components/SalesTargetBar";
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
  // ย้อนหลังได้ไม่เกิน 35 วัน — ครอบคลุมเดือนก่อนหน้าช่วงต้นเดือน
  const lookbackFrom = new Date(Date.parse(today) - 35 * 86_400_000).toISOString().slice(0, 10);
  const [todayRecord, attendanceSettingsResult, hrSettings, backdatedUsed, myRecRes, myRecentRes, myRequestsRes] = await Promise.all([
    // Org-wide active record: show the clock-out button wherever the shift was opened.
    getActiveRecordToday(user.id, ctx.organizationId, today),
    getAttendanceSettings(ctx.storeId, ctx.organizationId),
    getStoreHrSettings(ctx.storeId, ctx.organizationId),
    countBackdateRequestsInMonth(user.id, ctx.storeId, monthStart, nextMonthStart(today)),
    // The viewer's own clock-in/out for this month — powers the personal calendar shown to everyone.
    listAttendanceRecords(ctx.organizationId, ctx.storeId, monthStart, today, user.id),
    listAttendanceRecords(ctx.organizationId, ctx.storeId, lookbackFrom, today, user.id),
    listBackdateRequests({ storeIds: [ctx.storeId], userId: user.id, sinceDate: lookbackFrom, limit: 10 }),
  ]);
  const myRequests = myRequestsRes.data;
  const pendingRecordIds = new Set(
    myRequests.filter((r) => r.status === "pending" && r.attendanceRecordId).map((r) => r.attendanceRecordId as string),
  );
  // แถวที่ลืมกดออกงาน (วันที่ผ่านมาแล้ว ยังไม่มีเวลาออก ยังไม่มีคำขอค้าง) → ขอได้แค่เวลาออก
  const myOpenRecords = (myRecentRes.data ?? [])
    .filter((r) => !r.clockOutAt && r.date < today && !pendingRecordIds.has(r.id))
    .map((r) => ({ id: r.id, date: r.date, clockInAt: r.clockInAt }));
  const attendanceSettings = attendanceSettingsResult.data;
  const myMonthRecords = myRecRes.data ?? [];
  const currentMonth = today.slice(0, 7);

  // Month bounds (full month) for holidays/leave so future days in the month show too.
  const [my, mm] = currentMonth.split("-").map(Number);
  const monthEnd = `${currentMonth}-${String(new Date(Date.UTC(my, mm, 0)).getUTCDate()).padStart(2, "0")}`;

  // Per-day status for the viewer's personal calendar (holiday/leave/absent/late/in-no-out).
  // วันให้ OT แสดงบนปฏิทินเฉพาะร้านที่ใช้โหมด "เฉพาะวันที่กำหนด" (โหมดทุกวันไม่มีวันพิเศษให้บอก)
  const otScheduled = hrSettings.otMode === "scheduled";
  // ป้ายบนปฏิทินเป็นแค่การแสดงผล — DB error ห้ามทำหน้าลงเวลาพังทั้งหน้า (log แล้วไม่แสดงป้าย)
  const loadCalendarOtDays = (from: string, to: string) =>
    otScheduled
      ? listStoreOtDays(ctx.storeId, from, to).catch(async (e: unknown) => {
          await logSystemEvent({
            level: "error",
            source: "hr.ot-days",
            action: "loadCalendarOtDays",
            message: `โหลดวันให้ OT บนปฏิทินลงเวลาไม่สำเร็จ: ${e instanceof Error ? e.message : String(e)}`,
            organizationId: ctx.organizationId,
            storeId: ctx.storeId,
            actorUserId: user.id,
            context: { from, to },
          });
          return [];
        })
      : Promise.resolve([]);
  const [holidaysRes, profilesRes, myLeaveDates, userStores, myOtDayRows] = await Promise.all([
    listStoreHolidays(ctx.storeId, monthStart, monthEnd),
    listEmployeeProfiles(ctx.storeId),
    listLeaveDatesForUser(ctx.storeId, user.id, monthStart, monthEnd),
    getUserStores(),
    loadCalendarOtDays(monthStart, monthEnd),
  ]);
  // ปฏิทินส่วนตัว: เฉพาะวันที่ตัวเองได้ OT (ไม่ส่งรายชื่อคนอื่นไปหน้าเว็บ)
  const myOtDays = toCalendarOtDays(myOtDayRows, user.id);
  // สมาชิกภาพของตัวเองที่ครอบสาขานี้ (ผูกสาขาก่อน ไม่มีค่อยใช้ระดับองค์กร) — ใช้หาวันเข้าร่วมร้าน
  const myMemberships = userStores.memberships.filter((m) => m.organization_id === ctx.organizationId);
  const myMembership =
    myMemberships.find((m) => m.store_id === ctx.storeId) ?? myMemberships.find((m) => m.store_id === null) ?? null;
  const holidays = holidaysRes.data ?? [];
  const ownProfile = (profilesRes.data ?? []).find((p) => p.userId === user.id) ?? null;
  // Store-level open days are the calendar default; a per-employee schedule still overrides.
  const storeWorkingDays = hrSettings.workingDays?.length ? hrSettings.workingDays : [0, 1, 2, 3, 4, 5, 6];
  const effectiveWorkingDays =
    ownProfile?.workingDays?.length ? ownProfile.workingDays : storeWorkingDays;
  const ownWindow = employmentWindow(ownProfile, myMembership?.joined_at ?? null, ctx.storeTimezone);
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
    // ก่อนวันเริ่มงาน/หลังวันออกงาน ไม่ฟ้องขาด — คิดแบบเดียวกับปฏิทินทีม
    employedFrom: ownWindow.from,
    employedTo: ownWindow.to,
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
  let teamOtDays: CalendarOtDay[] = [];
  let pendingBackdateRequests: BackdateRequest[] = [];

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
    const pendingRes = await listBackdateRequests({
      storeIds: recordStoreId ? [recordStoreId] : branchStores.length > 0 ? branchStores.map((b) => b.id) : [ctx.storeId],
      status: "pending",
      limit: 50,
    });
    pendingBackdateRequests = pendingRes.data;

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
    const allProfiles = profilesRes.data ?? [];
    // คนเดียวอาจมีทั้งสมาชิกภาพผูกสาขาและระดับองค์กร → เหลือแถวเดียว (ผูกสาขาก่อน) กันชื่อซ้ำ/วันเข้าร่วมผิด
    const memberByUser = new Map<string, NonNullable<typeof membersRes.data>[number]>();
    for (const m of (membersRes.data ?? []).filter((row) => row.role !== "super_admin")) {
      const prev = memberByUser.get(m.userId);
      if (!prev || (prev.storeId === null && m.storeId !== null)) memberByUser.set(m.userId, m);
    }
    const memberRows = [...memberByUser.values()];
    const windowByUser = new Map(
      memberRows.map((m) => [
        m.userId,
        employmentWindow(allProfiles.find((p) => p.userId === m.userId), m.joinedAt, ctx.storeTimezone),
      ]),
    );
    // ลาออกก่อนช่วงที่ดู = ไม่แสดงในรายชื่อ/ปฏิทิน (ยังมีลงเวลาในช่วงนี้ = ยังแสดง เพื่อให้ตรวจย้อนหลังได้)
    const hasRecordInRange = new Set((records ?? []).map((r) => r.userId));
    members = memberRows
      .filter((m) => !resignedBefore(windowByUser.get(m.userId)?.to, dateFrom) || hasRecordInRange.has(m.userId))
      .map((m) => ({ userId: m.userId, name: m.email }));

    // สถานะรายวันต่อคนสำหรับปฏิทินทีม — คิดเฉพาะเดือนที่ปฏิทินแสดง และเฉพาะช่วงวันที่
    // ที่โหลด record มาจริง (วันนอกช่วงต้องไม่ถูกมาร์กว่าขาดงาน)
    const calendarMonth = dateFrom.slice(0, 7);
    const [cy, cm] = calendarMonth.split("-").map(Number);
    const calMonthStart = `${calendarMonth}-01`;
    const calMonthEnd = `${calendarMonth}-${String(new Date(Date.UTC(cy, cm, 0)).getUTCDate()).padStart(2, "0")}`;
    const [calHolidaysRes, calOtDayRows] = await Promise.all([
      listStoreHolidays(ctx.storeId, calMonthStart, calMonthEnd),
      loadCalendarOtDays(calMonthStart, calMonthEnd),
    ]);
    teamOtDays = toCalendarOtDays(calOtDayRows);
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
        employedFrom: windowByUser.get(member.userId)?.from ?? null,
        employedTo: windowByUser.get(member.userId)?.to ?? null,
      });
      for (const [date, status] of memberStatuses) {
        if (status === "off") continue;
        (statusByDate[date] ??= {})[member.userId] = status;
      }
    }
    teamDayStatus = statusByDate;
  }

  return (
    <>
    <SalesTargetBar className="mb-3 rounded-lg border" />
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
      myOpenRecords={myOpenRecords}
      myBackdateRequests={myRequests}
      pendingBackdateRequests={pendingBackdateRequests}
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
      myOtDays={myOtDays}
      teamOtDays={teamOtDays}
    />
    </>
  );
}
