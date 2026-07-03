import Link from "next/link";
import { requireSystemAccess } from "@/modules/auth/guards";
import { getPlatformDashboard } from "@/modules/system/repository";
import { PLAN_LABELS } from "@/modules/billing/types";
import type { BillingPlan } from "@/modules/billing/types";

export const dynamic = "force-dynamic";

const PLAN_ORDER: BillingPlan[] = ["free", "starter", "standard", "premium", "business", "enterprise"];

function baht(n: number) {
  return `฿${n.toLocaleString("th-TH")}`;
}
function fmtDate(iso: string | null) {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString("th-TH", { day: "numeric", month: "short" });
}

export default async function SystemOverviewPage() {
  await requireSystemAccess();
  const { summary, totals, recentPayments, recentTenants } = await getPlatformDashboard();

  return (
    <div className="space-y-5">
      <div className="page-header">
        <div>
          <h1 className="page-title">ภาพรวมแพลตฟอร์ม</h1>
          <p className="page-kicker">รายได้ การสมัคร และสถานะ tenant ทั้งระบบ</p>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="รายได้รวม (ยืนยันแล้ว)" value={baht(totals.total)} accent />
        <StatCard label="รายได้เดือนนี้" value={baht(totals.thisMonth)} />
        <StatCard label="จำนวน Tenant" value={String(summary.totalTenants)} />
        <StatCard label="กำลังทดลองใช้" value={String(summary.trialingCount)} />
      </div>

      {summary.pastDueCount > 0 && (
        <p className="rounded-[var(--radius-md)] border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          มี {summary.pastDueCount} tenant ค้างชำระ/ยังไม่ชำระ ควรติดตาม
        </p>
      )}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        {/* Recent payments */}
        <section className="panel overflow-x-auto p-0">
          <div className="panel-header">
            <h2 className="panel-title">การชำระเงินล่าสุด</h2>
            <span className="badge">{totals.count} รายการ</span>
          </div>
          {recentPayments.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-[var(--muted)]">ยังไม่มีการชำระเงิน</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--border)] text-left text-xs text-[var(--muted)]">
                  <th className="px-4 py-2 font-bold">Tenant</th>
                  <th className="px-4 py-2 font-bold">แพ็กเกจ</th>
                  <th className="px-4 py-2 text-right font-bold">ยอด</th>
                  <th className="px-4 py-2 font-bold">วันที่</th>
                </tr>
              </thead>
              <tbody>
                {recentPayments.map((p, i) => (
                  <tr key={i} className="border-b border-[var(--border)] last:border-0">
                    <td className="px-4 py-2 font-bold text-[var(--ink)]">
                      <Link href={`/system/tenants/${p.organizationId}`} className="text-[var(--color-brand)] hover:underline">
                        {p.orgName}
                      </Link>
                    </td>
                    <td className="px-4 py-2">{p.plan} · {p.duration}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{baht(p.amount)}</td>
                    <td className="px-4 py-2 text-[var(--muted)]">{fmtDate(p.verifiedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        {/* By plan + recent tenants */}
        <div className="space-y-4">
          <section className="panel p-4">
            <h2 className="panel-title mb-3">Tenant ตามแพ็กเกจ</h2>
            <div className="space-y-2">
              {PLAN_ORDER.map((plan) => (
                <div key={plan} className="flex items-center justify-between text-sm">
                  <span className="text-[var(--ink-2)]">{PLAN_LABELS[plan]}</span>
                  <span className="font-extrabold tabular-nums text-[var(--ink)]">{summary.byPlan[plan]}</span>
                </div>
              ))}
            </div>
          </section>

          <section className="panel p-4">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="panel-title">Tenant ล่าสุด</h2>
              <Link href="/system/tenants" className="text-xs font-bold text-[var(--color-brand)]">ดูทั้งหมด</Link>
            </div>
            <div className="space-y-2">
              {recentTenants.map((t) => (
                <Link
                  key={t.organizationId}
                  href={`/system/tenants/${t.organizationId}`}
                  className="flex items-center justify-between rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2 text-sm hover:border-[var(--tenant-primary)]"
                >
                  <span className="min-w-0 truncate font-bold text-[var(--ink)]">{t.name}</span>
                  <span className="text-xs text-[var(--muted)]">{PLAN_LABELS[t.plan]}</span>
                </Link>
              ))}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function StatCard({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className={`panel p-4 ${accent ? "border-[var(--tenant-primary)] bg-[var(--tenant-primary-soft)]" : ""}`}>
      <p className="label-muted">{label}</p>
      <p className="stat-value mt-1">{value}</p>
    </div>
  );
}
