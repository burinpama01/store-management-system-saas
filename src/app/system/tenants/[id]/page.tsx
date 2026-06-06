import Link from "next/link";
import { notFound } from "next/navigation";
import { requireSystemAccess } from "@/modules/auth/guards";
import { getTenantDetail, getTenantOperations, listTenantPayments } from "@/modules/system/repository";
import { PLAN_LABELS } from "@/modules/billing/types";
import type { BillingPlan, BillingStatus } from "@/modules/billing/types";
import { SuspendControl } from "./SuspendControl";
import { TenantPlanControl } from "./TenantPlanControl";

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

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleDateString("th-TH", { year: "numeric", month: "short", day: "numeric" });
}

export default async function TenantDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireSystemAccess();
  const { id } = await params;
  const tenant = await getTenantDetail(id);
  if (!tenant) notFound();
  const ops = await getTenantOperations(id);
  const payments = await listTenantPayments(id);

  return (
    <div className="space-y-5">
      <div className="page-header">
        <div>
          <Link href="/system/tenants" className="text-sm font-bold text-[var(--color-brand)]">
            ← กลับไปรายการ tenant
          </Link>
          <h1 className="page-title mt-1">{tenant.name}</h1>
          <p className="page-kicker">{tenant.slug} · สร้างเมื่อ {formatDate(tenant.createdAt)}</p>
        </div>
        <span className={`badge ${tenant.suspended ? "badge-warning" : "badge-success"}`}>
          {tenant.suspended ? "ถูกระงับ" : "ใช้งานอยู่"}
        </span>
      </div>

      <SuspendControl organizationId={tenant.organizationId} suspended={tenant.suspended} />

      <section className="panel max-w-3xl p-5">
        <h2 className="panel-title mb-3">การสมัครใช้งาน</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <InfoItem label="เจ้าของ (owner)" value={tenant.ownerEmail ?? tenant.ownerId} />
          <InfoItem
            label="แพ็กเกจ"
            value={tenant.subscription ? PLAN_LABELS[tenant.subscription.plan] : "Free (ไม่มี subscription)"}
          />
          <InfoItem
            label="สถานะ"
            value={tenant.subscription ? STATUS_LABELS[tenant.subscription.status] : "—"}
          />
          <InfoItem
            label="รอบบิลถัดไป"
            value={tenant.subscription ? formatDate(tenant.subscription.currentPeriodEnd) : "—"}
          />
        </div>
        <div className="mt-4">
          <TenantPlanControl
            organizationId={tenant.organizationId}
            currentPlan={(tenant.subscription?.plan ?? "free") as BillingPlan}
          />
        </div>
      </section>

      <section className="panel overflow-x-auto p-0">
        <h2 className="panel-title px-4 pt-4">บิลลิ่ง / สลิป ({payments.length})</h2>
        {payments.length === 0 ? (
          <p className="p-4 text-sm text-[var(--muted)]">ยังไม่มีรายการชำระเงิน</p>
        ) : (
          <table className="mt-3 w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--border)] text-left text-xs text-[var(--muted)]">
                <th className="px-4 py-2 font-bold">แพ็กเกจ</th>
                <th className="px-4 py-2 text-right font-bold">ยอด</th>
                <th className="px-4 py-2 font-bold">สถานะ</th>
                <th className="px-4 py-2 font-bold">เลขอ้างอิงสลิป</th>
                <th className="px-4 py-2 font-bold">วันที่</th>
              </tr>
            </thead>
            <tbody>
              {payments.map((p, i) => (
                <tr key={i} className="border-b border-[var(--border)] last:border-0">
                  <td className="px-4 py-2">{p.plan} · {p.duration}</td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    ฿{(p.verifiedAmount ?? p.amountExpected).toLocaleString("th-TH")}
                  </td>
                  <td className="px-4 py-2">
                    <span className={`badge ${p.status === "verified" ? "badge-success" : "badge-warning"}`}>
                      {p.status}
                    </span>
                  </td>
                  <td className="px-4 py-2 font-mono text-xs text-[var(--muted)]">{p.slipRef ?? "—"}</td>
                  <td className="px-4 py-2 text-[var(--muted)]">{formatDate(p.verifiedAt ?? p.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="panel p-5">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="panel-title">ภาพรวมการใช้งาน (อ่านอย่างเดียว)</h2>
          <span className="badge">read-only</span>
        </div>
        <div className="grid gap-3 sm:grid-cols-4">
          <InfoItem label="ยอดขายรวม (ชำระแล้ว)" value={`฿${ops.salesTotal.toLocaleString("th-TH")}`} />
          <InfoItem label="ออร์เดอร์ทั้งหมด" value={String(ops.orderCount)} />
          <InfoItem label="ชำระเงินแล้ว" value={String(ops.paidCount)} />
          <InfoItem label="จำนวนสินค้า" value={String(ops.productCount)} />
        </div>
        {ops.recentOrders.length > 0 && (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--border)] text-left text-xs text-[var(--muted)]">
                  <th className="px-3 py-2 font-bold">ออร์เดอร์</th>
                  <th className="px-3 py-2 font-bold">สถานะ</th>
                  <th className="px-3 py-2 text-right font-bold">ยอด</th>
                  <th className="px-3 py-2 font-bold">เวลา</th>
                </tr>
              </thead>
              <tbody>
                {ops.recentOrders.map((o) => (
                  <tr key={o.orderNumber} className="border-b border-[var(--border)] last:border-0">
                    <td className="px-3 py-2 font-bold text-[var(--ink)]">{o.orderNumber}</td>
                    <td className="px-3 py-2">
                      <span className={`badge ${o.paid ? "badge-success" : "badge-warning"}`}>
                        {o.paid ? "ชำระแล้ว" : o.status}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">฿{o.total.toLocaleString("th-TH")}</td>
                    <td className="px-3 py-2 text-[var(--muted)]">
                      {new Date(o.createdAt).toLocaleString("th-TH", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel p-5">
        <h2 className="panel-title mb-3">สาขา ({tenant.stores.length})</h2>
        {tenant.stores.length === 0 ? (
          <p className="text-sm text-[var(--muted)]">ยังไม่มีสาขา</p>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2">
            {tenant.stores.map((s) => (
              <div
                key={s.id}
                className="flex items-center justify-between rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-muted)] p-3"
              >
                <div className="min-w-0">
                  <p className="truncate font-bold text-[var(--ink)]">{s.name}</p>
                  <p className="text-xs text-[var(--muted)]">{s.slug}</p>
                </div>
                <span className={`badge ${s.isActive ? "badge-success" : "badge-warning"}`}>
                  {s.isActive ? "เปิด" : "ปิด"}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="panel overflow-x-auto p-0">
        <h2 className="panel-title px-4 pt-4">สมาชิก ({tenant.members.length})</h2>
        {tenant.members.length === 0 ? (
          <p className="p-4 text-sm text-[var(--muted)]">ยังไม่มีสมาชิก</p>
        ) : (
          <table className="mt-3 w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--border)] text-left text-xs text-[var(--muted)]">
                <th className="px-4 py-3 font-bold">อีเมล</th>
                <th className="px-4 py-3 font-bold">บทบาท</th>
                <th className="px-4 py-3 font-bold">ขอบเขต</th>
                <th className="px-4 py-3 font-bold">เข้าร่วมเมื่อ</th>
              </tr>
            </thead>
            <tbody>
              {tenant.members.map((m) => (
                <tr key={`${m.userId}-${m.storeId ?? "org"}`} className="border-b border-[var(--border)] last:border-0">
                  <td className="px-4 py-3 font-bold text-[var(--ink)]">{m.email ?? m.userId}</td>
                  <td className="px-4 py-3 capitalize">{m.role}</td>
                  <td className="px-4 py-3 text-[var(--muted)]">{m.storeId ? "ราย store" : "ทั้งองค์กร"}</td>
                  <td className="px-4 py-3 text-[var(--muted)]">{formatDate(m.joinedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

function InfoItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-muted)] p-3">
      <p className="label-muted">{label}</p>
      <p className="mt-1 text-sm font-bold text-[var(--ink-2)]">{value}</p>
    </div>
  );
}
