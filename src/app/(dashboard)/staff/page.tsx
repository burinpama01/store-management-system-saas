import { redirect } from "next/navigation";
import { getResolvedCurrentPermissions } from "@/modules/auth/guards";
import { listStoreMemberships } from "@/modules/settings/repository";
import { listEmployeeProfiles, listPayrollAdjustments, getStoreHrSettings } from "@/modules/hr/repository";
import { listAttendanceRecords, computePayrollSummaries } from "@/modules/attendance/repository";
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

  const [membersRes, profilesRes, recordsRes, adjustmentsRes, storeRes, hrSettings] = await Promise.all([
    listStoreMemberships(ctx.organizationId, ctx.storeId),
    listEmployeeProfiles(ctx.storeId),
    listAttendanceRecords(ctx.organizationId, ctx.storeId, dateFrom, dateTo),
    listPayrollAdjustments(ctx.storeId, dateFrom, dateTo),
    getStore(ctx.storeId),
    getStoreHrSettings(ctx.storeId, ctx.organizationId),
  ]);

  const records = recordsRes.data ?? [];
  const summaries = computePayrollSummaries(records, ctx.storeId, ctx.organizationId, dateFrom, dateTo);
  const profiles = profilesRes.data ?? [];
  const adjustments = adjustmentsRes.data ?? [];
  const payrollLines = computePayrollLines({
    summaries,
    records,
    profiles,
    adjustments,
    settings: hrSettings,
    periodStart: dateFrom,
    periodEnd: dateTo,
    today,
    timezone: ctx.storeTimezone,
  });

  return (
    <StaffManager
      members={membersRes.data ?? []}
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
