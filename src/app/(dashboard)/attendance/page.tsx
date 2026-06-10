import { redirect } from "next/navigation";
import { getOrganizationBillingState } from "@/modules/billing/billing-service";
import {
  DEFAULT_BILLING_STATE,
  getPlanFeatures,
} from "@/modules/billing/types";
import { getResolvedCurrentPermissions } from "@/modules/auth/guards";
import {
  getTodayRecord,
  listAttendanceRecords,
  computePayrollSummaries,
  getAttendanceSettings,
} from "@/modules/attendance/repository";
import { getStoreLocalDate } from "@/modules/attendance/date";
import { countSelfBackdated, nextMonthStart } from "@/modules/attendance/repository";
import { getStoreHrSettings } from "@/modules/hr/repository";
import { listStoreMemberships } from "@/modules/settings/repository";
import { AttendanceManager } from "./AttendanceManager";

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
    getTodayRecord(user.id, ctx.organizationId, ctx.storeId, today),
    getAttendanceSettings(ctx.storeId, ctx.organizationId),
    getStoreHrSettings(ctx.storeId, ctx.organizationId),
    countSelfBackdated(user.id, ctx.storeId, monthStart, nextMonthStart(today)),
    // The viewer's own clock-in/out for this month — powers the personal calendar shown to everyone.
    listAttendanceRecords(ctx.organizationId, ctx.storeId, monthStart, today, user.id),
  ]);
  const attendanceSettings = attendanceSettingsResult.data;
  const myMonthRecords = myRecRes.data ?? [];
  const currentMonth = today.slice(0, 7);

  const canManage = resolved.can("attendance.manage");

  let dateFrom = today.slice(0, 7) + "-01";
  let dateTo = today;
  let records = null;
  let payrollSummaries = null;
  let members: { userId: string; name: string }[] = [];

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

    const [recRes, membersRes] = await Promise.all([
      listAttendanceRecords(ctx.organizationId, ctx.storeId, dateFrom, dateTo),
      listStoreMemberships(ctx.organizationId, ctx.storeId),
    ]);
    records = recRes.data ?? [];
    payrollSummaries = computePayrollSummaries(
      records,
      ctx.storeId,
      ctx.organizationId,
      dateFrom,
      dateTo,
    );
    members = (membersRes.data ?? [])
      .filter((m) => m.role !== "super_admin")
      .map((m) => ({ userId: m.userId, name: m.email }));
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
      attendanceSettings={attendanceSettings}
      members={members}
      today={today}
      backdatedRights={hrSettings.backdatedRightsPerMonth}
      backdatedUsed={backdatedUsed}
      myMonthRecords={myMonthRecords}
      currentMonth={currentMonth}
    />
  );
}
