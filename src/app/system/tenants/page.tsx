import Link from "next/link";
import { requireSystemAccess } from "@/modules/auth/guards";
import { listTenantOverview } from "@/modules/system/repository";
import { PLAN_LABELS } from "@/modules/billing/types";
import type { BillingStatus } from "@/modules/billing/types";

export const dynamic = "force-dynamic";

const STATUS_LABELS: Record<BillingStatus, string> = {
  active: "ใช้งานอยู่",
  trialing: "ทดลองใช้",
  past_due: "ค้างชำระ",
  incomplete: "รอชำระครั้งแรก",
  incomplete_expired: "หมดอายุ",
  unpaid: "ยังไม่ชำระ",
  canceled: "ยกเลิก",
  paused: "พักใช้งาน",
};

const STATUS_BADGE: Record<BillingStatus, string> = {
  active: "badge-success",
  trialing: "badge-brand",
  past_due: "badge-warning",
  incomplete: "badge-warning",
  incomplete_expired: "badge-warning",
  unpaid: "badge-warning",
  canceled: "badge-warning",
  paused: "badge-warning",
};

export default async function SystemTenantsPage() {
  await requireSystemAccess();
  const tenants = await listTenantOverview();

  return (
    <div className="space-y-5">
      <div className="page-header">
        <div>
          <h1 className="page-title">Tenants</h1>
          <p className="page-kicker">รายการ organization ทั้งหมดในระบบ ({tenants.length})</p>
        </div>
      </div>

      <section className="panel overflow-x-auto p-0">
        {tenants.length === 0 ? (
          <p className="p-6 text-sm text-[var(--muted)]">ยังไม่มี tenant ในระบบ</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--border)] text-left text-xs text-[var(--muted)]">
                <th className="px-4 py-3 font-bold">ชื่อ Organization</th>
                <th className="px-4 py-3 font-bold">Slug</th>
                <th className="px-4 py-3 font-bold">แพ็กเกจ</th>
                <th className="px-4 py-3 font-bold">สถานะ</th>
                <th className="px-4 py-3 text-right font-bold">สาขา</th>
                <th className="px-4 py-3 text-right font-bold">สมาชิก</th>
                <th className="px-4 py-3 font-bold">สร้างเมื่อ</th>
              </tr>
            </thead>
            <tbody>
              {tenants.map((t) => (
                <tr key={t.organizationId} className="border-b border-[var(--border)] last:border-0">
                  <td className="px-4 py-3 font-bold text-[var(--ink)]">
                    <Link href={`/system/tenants/${t.organizationId}`} className="text-[var(--color-brand)] hover:underline">
                      {t.name}
                    </Link>
                    {t.suspended && <span className="badge badge-warning ml-2">ถูกระงับ</span>}
                  </td>
                  <td className="px-4 py-3 text-[var(--muted)]">{t.slug}</td>
                  <td className="px-4 py-3">{PLAN_LABELS[t.plan]}</td>
                  <td className="px-4 py-3">
                    <span className={`badge ${STATUS_BADGE[t.status]}`}>{STATUS_LABELS[t.status]}</span>
                  </td>
                  <td className="px-4 py-3 text-right">{t.storeCount}</td>
                  <td className="px-4 py-3 text-right">{t.memberCount}</td>
                  <td className="px-4 py-3 text-[var(--muted)]">
                    {new Date(t.createdAt).toLocaleDateString("th-TH", {
                      year: "numeric",
                      month: "short",
                      day: "numeric",
                    })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
