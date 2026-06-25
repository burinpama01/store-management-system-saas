import { redirect } from "next/navigation";
import { getResolvedCurrentPermissions } from "@/modules/auth/guards";
import { getOrganizationBillingState } from "@/modules/billing/billing-service";
import { canUseFeature, DEFAULT_BILLING_STATE, explainFeatureLock } from "@/modules/billing/types";
import { getBranchReportData, getReportData } from "@/modules/reports/repository";
import { ReportsManager } from "./ReportsManager";

export const dynamic = "force-dynamic";

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string>>;
}) {
  const { ctx, resolved } = await getResolvedCurrentPermissions();
  if (!resolved.can("reports.view")) redirect("/dashboard");

  const params = await searchParams;
  const today = new Date().toISOString().split("T")[0];
  const monthStart = today.slice(0, 7) + "-01";
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const isValidDate = (s: string) => {
    if (!DATE_RE.test(s) || isNaN(Date.parse(s))) return false;
    // Reject dates that JS normalises (e.g. Feb-30 rolls over to Mar-2)
    return new Date(s).toISOString().startsWith(s);
  };
  let dateFrom = isValidDate(params.dateFrom ?? "") ? params.dateFrom : monthStart;
  let dateTo = isValidDate(params.dateTo ?? "") ? params.dateTo : today;
  // Enforce chronological order and cap range at 366 days
  if (dateFrom > dateTo) [dateFrom, dateTo] = [dateTo, dateFrom];
  const MS_PER_DAY = 86_400_000;
  const MAX_DAYS = 366;
  if ((Date.parse(dateTo) - Date.parse(dateFrom)) / MS_PER_DAY > MAX_DAYS) {
    dateTo = new Date(Date.parse(dateFrom) + MAX_DAYS * MS_PER_DAY).toISOString().split("T")[0];
  }

  const billingState = (await getOrganizationBillingState(ctx.organizationId)) ?? DEFAULT_BILLING_STATE;
  const branchReportingEnabled = canUseFeature(billingState, "multiBranchReporting");
  const branchReportingUnavailableMessage = branchReportingEnabled
    ? null
    : explainFeatureLock(billingState, "multiBranchReporting");
  const [reportData, branchSummaries] = await Promise.all([
    getReportData(ctx.storeId, dateFrom, dateTo),
    branchReportingEnabled
      ? getBranchReportData(ctx.organizationId, dateFrom, dateTo)
      : Promise.resolve([]),
  ]);

  return (
    <ReportsManager
      reportData={reportData}
      branchSummaries={branchSummaries}
      branchReportingEnabled={branchReportingEnabled}
      branchReportingUnavailableMessage={branchReportingUnavailableMessage}
      dateFrom={dateFrom}
      dateTo={dateTo}
    />
  );
}
