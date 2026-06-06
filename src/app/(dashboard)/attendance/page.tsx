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
  if (!resolved.can("attendance.clock")) redirect("/");
  const billingState =
    (await getOrganizationBillingState(ctx.organizationId)) ??
    DEFAULT_BILLING_STATE;
  const features = getPlanFeatures(billingState);

  const today = getStoreLocalDate(ctx.storeTimezone);
  const [todayRecord, attendanceSettingsResult] = await Promise.all([
    getTodayRecord(user.id, ctx.organizationId, ctx.storeId, today),
    getAttendanceSettings(ctx.storeId, ctx.organizationId),
  ]);
  const attendanceSettings = attendanceSettingsResult.data;

  const canManage = resolved.can("attendance.manage");

  let dateFrom = today.slice(0, 7) + "-01";
  let dateTo = today;
  let records = null;
  let payrollSummaries = null;

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

    const recRes = await listAttendanceRecords(ctx.organizationId, ctx.storeId, dateFrom, dateTo);
    records = recRes.data ?? [];
    payrollSummaries = computePayrollSummaries(
      records,
      ctx.storeId,
      ctx.organizationId,
      dateFrom,
      dateTo,
    );
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
    />
  );
}
