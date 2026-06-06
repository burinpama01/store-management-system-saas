import { requireSystemAccess } from "@/modules/auth/guards";
import { listTenantOverview, summarizeTenants } from "@/modules/system/repository";
import { PLAN_LABELS } from "@/modules/billing/types";
import type { BillingPlan } from "@/modules/billing/types";

export const dynamic = "force-dynamic";

const PLAN_ORDER: BillingPlan[] = ["free", "starter", "standard", "premium", "enterprise"];

export default async function SystemOverviewPage() {
  await requireSystemAccess();
  const tenants = await listTenantOverview();
  const summary = summarizeTenants(tenants);

  return (
    <div className="space-y-5">
      <div className="page-header">
        <div>
          <h1 className="page-title">ภาพรวมแพลตฟอร์ม</h1>
          <p className="page-kicker">สถานะ tenant, แพ็กเกจ และความเสี่ยงด้านการชำระเงินทั้งระบบ</p>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="จำนวน Tenant" value={summary.totalTenants} />
        <StatCard label="จำนวนสาขา" value={summary.totalStores} />
        <StatCard label="จำนวนสมาชิก" value={summary.totalMembers} />
        <StatCard label="กำลังทดลองใช้" value={summary.trialingCount} />
      </div>

      {summary.pastDueCount > 0 && (
        <p className="rounded-[var(--radius-md)] border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          มี {summary.pastDueCount} tenant ที่ค้างชำระหรือยังไม่ชำระเงิน ควรติดตาม
        </p>
      )}

      <section className="panel p-5">
        <h2 className="panel-title mb-3">จำนวน Tenant ตามแพ็กเกจ</h2>
        <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-5">
          {PLAN_ORDER.map((plan) => (
            <div
              key={plan}
              className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-muted)] p-3"
            >
              <p className="label-muted">{PLAN_LABELS[plan]}</p>
              <p className="mt-1 text-2xl font-extrabold text-[var(--ink)]">{summary.byPlan[plan]}</p>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="panel p-4">
      <p className="label-muted">{label}</p>
      <p className="stat-value mt-1">{value}</p>
    </div>
  );
}
