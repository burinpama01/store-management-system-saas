import { redirect } from "next/navigation";
import { getResolvedCurrentPermissions } from "@/modules/auth/guards";
import { listStoreMemberships } from "@/modules/settings/repository";
import { listEmployeeProfiles, listPayrollAdjustments, getStoreHrSettings } from "@/modules/hr/repository";
import {
  listAttendanceRecords,
  computePayrollSummaries,
  listStoreHolidays,
} from "@/modules/attendance/repository";
import { computePayrollLines } from "@/modules/hr/payroll";
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
  let dateFrom = isValidDate(params.dateFrom ?? "") ? params.dateFrom! : today.slice(0, 7) + "-01";
  let dateTo = isValidDate(params.dateTo ?? "") ? params.dateTo! : today;
  if (dateFrom > dateTo) [dateFrom, dateTo] = [dateTo, dateFrom];

  const [membersRes, profilesRes, recordsRes, adjustmentsRes, holidaysRes, storeRes, hrSettings] = await Promise.all([
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
  ]);

  const members = membersRes.data ?? [];
  const roster = new Set(members.filter((m) => m.role !== "super_admin").map((m) => m.userId));
  const records = (recordsRes.data ?? []).filter((r) => roster.has(r.userId));
  const summaries = computePayrollSummaries(records, null, ctx.organizationId, dateFrom, dateTo);
  const profiles = profilesRes.data ?? [];
  const adjustments = adjustmentsRes.data ?? [];
  const payrollLines = computePayrollLines({
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
  });

  return (
    <StaffManager
      members={members}
      profiles={profiles}
      payrollLines={payrollLines}
      adjustments={adjustments}
      hrSettings={hrSettings}
      currency={storeRes.data?.currencyCode ?? "THB"}
      dateFrom={dateFrom}
      dateTo={dateTo}
      today={today}
      canAddStaff={resolved.can("users.manage")}
    />
  );
}
