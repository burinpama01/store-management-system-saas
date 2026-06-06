import { redirect } from "next/navigation";
import { getOrganizationBillingState } from "@/modules/billing/billing-service";
import {
  DEFAULT_BILLING_STATE,
  getPlanFeatures,
  PLAN_LABELS,
} from "@/modules/billing/types";
import { requirePermission } from "@/modules/auth/guards";
import {
  getCurrentUser,
  getUserStores,
  resolveCurrentStore,
} from "@/modules/auth/session";
import { listLowStockAlerts } from "@/modules/stock/repository";

export const dynamic = "force-dynamic";

function fmtStock(n: number) {
  return n.toLocaleString("th-TH");
}

export default async function StockPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  await requirePermission("stock.manage");

  const { organizations, stores, memberships } = await getUserStores();
  const ctx = await resolveCurrentStore(stores, organizations, memberships);
  if (!ctx) redirect("/dashboard");

  const billingState =
    (await getOrganizationBillingState(ctx.organizationId)) ??
    DEFAULT_BILLING_STATE;
  const features = getPlanFeatures(billingState);

  if (!features.stockManagement) {
    return (
      <section className="page-shell max-w-3xl">
        <div className="rounded-md border border-amber-200 bg-amber-50 p-5">
          <p className="text-sm font-bold text-amber-900">
            สต็อกถูกจำกัดในแพ็กเกจ {PLAN_LABELS[billingState.plan]}
          </p>
          <p className="mt-2 text-sm text-amber-800">
            ใช้งานฟีเจอร์พื้นฐานได้ฟรี ส่วนการแจ้งเตือนสต็อกต่ำต้องใช้แพ็กเกจ Standard ขึ้นไป
          </p>
        </div>
      </section>
    );
  }

  const alertsRes = await listLowStockAlerts(ctx.storeId);
  const alerts = alertsRes.data ?? [];

  return (
    <section className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-bold uppercase tracking-wide text-[var(--color-text-muted)]">
            Stock Control
          </p>
          <h1 className="text-2xl font-bold text-[var(--color-text-primary)]">
            แจ้งเตือนสต็อกต่ำ
          </h1>
          <p className="mt-1 text-sm text-[var(--color-text-secondary)]">
            แสดงตัวเลือกสินค้าที่เปิดติดตามสต็อกและเหลือไม่เกิน 5 หน่วย
          </p>
        </div>
        <div className="rounded-md border border-[var(--color-border)] bg-white px-3 py-2 text-right">
          <p className="text-xs text-[var(--color-text-muted)]">รายการที่ต้องดูแล</p>
          <p className="text-xl font-bold text-[var(--color-text-primary)]">
            {fmtStock(alerts.length)}
          </p>
        </div>
      </header>

      {alertsRes.error && (
        <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {alertsRes.error.userMessage}
        </p>
      )}

      <div className="overflow-x-auto rounded-md border border-[var(--color-border)] bg-white">
        <table className="min-w-[720px] w-full text-sm">
          <thead className="bg-[var(--color-surface-muted)] text-xs font-bold uppercase tracking-wide text-[var(--color-text-muted)]">
            <tr>
              <th className="px-4 py-3 text-left">สินค้า</th>
              <th className="px-4 py-3 text-left">ตัวเลือก</th>
              <th className="px-4 py-3 text-right">คงเหลือ</th>
              <th className="px-4 py-3 text-left">สถานะ</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--color-border)]">
            {alerts.map((alert) => (
              <tr key={alert.variantId}>
                <td className="px-4 py-3 font-semibold text-[var(--color-text-primary)]">
                  {alert.productName}
                </td>
                <td className="px-4 py-3 text-[var(--color-text-secondary)]">
                  {alert.variantName}
                </td>
                <td className="px-4 py-3 text-right font-mono text-[var(--color-text-primary)]">
                  {fmtStock(alert.stockQuantity)}
                </td>
                <td className="px-4 py-3">
                  <span
                    className={
                      alert.severity === "out"
                        ? "rounded-md bg-red-50 px-2 py-1 text-xs font-bold text-red-700"
                        : "rounded-md bg-amber-50 px-2 py-1 text-xs font-bold text-amber-700"
                    }
                  >
                    {alert.severity === "out" ? "หมดสต็อก" : "ใกล้หมด"}
                  </span>
                </td>
              </tr>
            ))}
            {alerts.length === 0 && !alertsRes.error && (
              <tr>
                <td
                  colSpan={4}
                  className="px-4 py-8 text-center text-sm text-[var(--color-text-muted)]"
                >
                  ยังไม่มีรายการสต็อกต่ำ
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
