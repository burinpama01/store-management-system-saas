import Link from "next/link";
import { redirect } from "next/navigation";
import { getResolvedCurrentPermissions } from "@/modules/auth/guards";
import { getOrganizationBillingState } from "@/modules/billing/billing-service";
import { canUseFeature, DEFAULT_BILLING_STATE, explainFeatureLock } from "@/modules/billing/types";
import { bangkokToday, resolveInsightsRange } from "@/modules/reports/insights";
import { getSalesInsights } from "@/modules/reports/insights-repository";
import { InsightsView } from "./InsightsView";

export const dynamic = "force-dynamic";

export default async function SalesInsightsPage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const { user, ctx, resolved } = await getResolvedCurrentPermissions();
  if (!resolved.can("reports.view")) redirect("/dashboard");

  const billingState = (await getOrganizationBillingState(ctx.organizationId)) ?? DEFAULT_BILLING_STATE;
  if (!canUseFeature(billingState, "advancedReports")) {
    return (
      <div className="page-shell">
        <div className="page-header">
          <div>
            <h1 className="page-title">รายงานเชิงลึก</h1>
            <p className="page-kicker">กราฟยอดขายตามหมวด เมนูขายดี ยอดรายเมนู และคำแนะนำจากระบบ</p>
          </div>
        </div>
        <div className="panel p-5">
          <p className="text-sm font-bold text-[var(--color-text-primary)]">ต้องใช้แพ็กเกจที่มีรายงานขั้นสูง</p>
          <p className="mt-1 text-sm text-[var(--color-text-muted)]">
            {explainFeatureLock(billingState, "advancedReports") ?? "แพ็กเกจนี้ยังไม่รองรับรายงานขั้นสูง"}
          </p>
          <Link href="/reports" className="mt-3 inline-block text-sm font-bold text-[var(--color-brand)]">
            ← กลับหน้ารายงาน
          </Link>
        </div>
      </div>
    );
  }

  const params = await searchParams;
  const today = bangkokToday();
  const range = resolveInsightsRange({ range: params.range, from: params.from, to: params.to }, today);
  const result = await getSalesInsights(
    { organizationId: ctx.organizationId, storeId: ctx.storeId, userId: user.id },
    range.from,
    range.to,
  );

  // key ผูกกับช่วงวันที่: เปลี่ยนช่วงแล้วช่องวันที่กำหนดเองต้องรีเซ็ตตามค่าใหม่ (App Router เก็บ state ของ client component ไว้)
  return (
    <InsightsView
      key={`${range.from}_${range.to}`}
      preset={range.preset}
      from={range.from}
      to={range.to}
      today={today}
      data={result.data}
      error={result.error}
    />
  );
}
