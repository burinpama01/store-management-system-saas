import { redirect } from "next/navigation";
import type { CSSProperties } from "react";
import { getResolvedCurrentPermissions, shouldStartAtAttendance } from "@/modules/auth/guards";
import type { PermissionKey } from "@/modules/tenants/types";
import { getDashboardData } from "@/modules/reports/repository";
import { getLatestCashBalance } from "@/modules/accounting/repository";

export const dynamic = "force-dynamic";

function fmt(n: number) {
  return n.toLocaleString("th-TH", { minimumFractionDigits: 2 });
}

export default async function DashboardPage() {
  const { user, ctx, resolved } = await getResolvedCurrentPermissions();
  if (await shouldStartAtAttendance({ user, ctx, resolved })) redirect("/attendance");
  if (!resolved.can("dashboard.view")) {
    const fallback = firstAllowedRoute((permission) => resolved.can(permission));
    if (fallback) redirect(fallback);
    return (
      <div className="page-shell">
        <div className="panel max-w-xl p-6">
          <h1 className="page-title">ไม่มีสิทธิ์เข้าถึงภาพรวม</h1>
          <p className="page-kicker">
            บัญชีนี้ยังไม่มีเมนูที่เปิดใช้งานได้ โปรดติดต่อผู้ดูแลระบบร้านค้า
          </p>
        </div>
      </div>
    );
  }

  const [dashData, cashBalance] = await Promise.all([
    getDashboardData(ctx.storeId),
    getLatestCashBalance(ctx.storeId),
  ]);

  const { todaySales, pendingOrderCount, topProductsToday } = dashData;

  return (
    <div className="page-shell">
      <div className="page-header">
        <div>
          <h1 className="page-title">ภาพรวมวันนี้</h1>
          <p className="page-kicker">ยอดขาย เงินสด และสถานะหน้าร้านแบบ real-time สำหรับทีมปฏิบัติการ</p>
        </div>
        <div className="hidden items-center gap-2 md:flex">
          <span className="badge badge-success">เปิดร้าน</span>
          <span className="badge">กะเช้า 08:00</span>
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KpiCard
          label="ยอดขายวันนี้"
          value={`฿${fmt(todaySales.revenue)}`}
          sub={`${todaySales.orderCount} ออร์เดอร์`}
          accent="var(--tenant-primary)"
          spark={[42, 48, 34, 58, 50, 68, 61, 78]}
        />
        <KpiCard
          label="เงินสดปัจจุบัน"
          value={`฿${fmt(cashBalance)}`}
          accent={cashBalance >= 0 ? "var(--cat-cold)" : "var(--color-danger)"}
          spark={[28, 36, 35, 44, 39, 42, 40, 46]}
        />
        <KpiCard
          label="ออร์เดอร์รอดำเนินการ"
          value={String(pendingOrderCount)}
          sub="รายการ"
          accent="var(--cat-bakery)"
          spark={[22, 30, 24, 35, 31, 38, 33, 41]}
        />
        <KpiCard
          label="ค่าเฉลี่ย/ออร์เดอร์"
          value={`฿${fmt(todaySales.avgOrderValue)}`}
          sub={`QR ${todaySales.qrOrderCount} / POS ${todaySales.posOrderCount}`}
          accent="var(--cat-tea)"
          spark={[30, 33, 37, 34, 40, 39, 43, 42]}
        />
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="panel overflow-hidden">
          <div className="panel-header">
            <div>
              <h2 className="panel-title">สินค้าขายดีวันนี้</h2>
              <p className="label-muted">Top products</p>
            </div>
            <span className="badge badge-brand">วันนี้</span>
          </div>
          {topProductsToday.length === 0 ? (
            <p className="px-4 py-8 text-sm text-[var(--color-text-muted)] text-center">ยังไม่มีออร์เดอร์วันนี้</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-[520px] w-full text-sm">
                <thead className="bg-[var(--surface-muted)] text-xs text-[var(--muted)]">
                  <tr>
                    <th className="px-3 py-2 text-left">#</th>
                    <th className="px-3 py-2 text-left">สินค้า</th>
                    <th className="px-3 py-2 text-right">จำนวนที่ขาย</th>
                    <th className="px-3 py-2 text-right">ยอดขาย</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--border)]">
                  {topProductsToday.map((p, i) => (
                    <tr key={p.productId} className="hover:bg-[var(--surface-muted)]">
                      <td className="px-3 py-3 text-[var(--muted)]">{i + 1}</td>
                      <td className="px-3 py-3 font-bold text-[var(--ink)]">{p.productName}</td>
                      <td className="px-3 py-3 text-right text-[var(--ink-2)] tabular-nums">{p.quantitySold}</td>
                      <td className="px-3 py-3 text-right font-extrabold tabular-nums text-[var(--tenant-primary-strong)]">
                        ฿{fmt(p.revenue)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="panel p-4">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div>
              <h2 className="panel-title">สถานะหน้าร้าน</h2>
              <p className="label-muted">Operational pulse</p>
            </div>
            <span className="badge badge-success">พร้อมขาย</span>
          </div>
          <div className="space-y-3">
            <StatusRow label="QR Order" value={`${todaySales.qrOrderCount} รายการ`} color="var(--cat-cold)" />
            <StatusRow label="POS" value={`${todaySales.posOrderCount} รายการ`} color="var(--tenant-primary)" />
            <StatusRow label="Cash drawer" value={`฿${fmt(cashBalance)}`} color="var(--cat-tea)" />
          </div>
        </div>
      </div>
    </div>
  );
}

function firstAllowedRoute(can: (permission: PermissionKey) => boolean) {
  const routes: { permission: PermissionKey; href: string }[] = [
    { permission: "pos.use", href: "/pos" },
    { permission: "catalog.view", href: "/catalog" },
    { permission: "stock.manage", href: "/stock" },
    { permission: "cashflow.view", href: "/accounting" },
    { permission: "reports.view", href: "/reports" },
    { permission: "attendance.clock", href: "/attendance" },
    { permission: "settings.view", href: "/settings" },
  ];
  return routes.find((route) => can(route.permission))?.href ?? null;
}

function KpiCard({
  label,
  value,
  sub,
  accent,
  spark,
}: {
  label: string;
  value: string;
  sub?: string;
  accent: string;
  spark: number[];
}) {
  const max = Math.max(...spark, 1);
  return (
    <div className="metric-card metric-card-accent p-4" style={{ "--accent": accent } as CSSProperties}>
      <p className="label-muted mb-1">{label}</p>
      <p className="text-xl font-extrabold tabular-nums text-[var(--ink)]">{value}</p>
      {sub && <p className="mt-1 text-xs text-[var(--color-text-muted)]">{sub}</p>}
      <div className="spark-row mt-4" aria-hidden="true">
        {spark.map((v, i) => (
          <span key={i} className="spark-bar" style={{ height: `${Math.max(18, (v / max) * 100)}%` }} />
        ))}
      </div>
    </div>
  );
}

function StatusRow({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2">
      <span className="flex items-center gap-2 text-sm font-bold text-[var(--ink-2)]">
        <span className="h-2.5 w-2.5 rounded-full" style={{ background: color }} />
        {label}
      </span>
      <span className="text-sm font-extrabold tabular-nums text-[var(--ink)]">{value}</span>
    </div>
  );
}
