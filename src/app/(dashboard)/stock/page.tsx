import { redirect } from "next/navigation";
import { getOrganizationBillingState } from "@/modules/billing/billing-service";
import {
  DEFAULT_BILLING_STATE,
  getPlanFeatures,
  PLAN_LABELS,
} from "@/modules/billing/types";
import { getResolvedCurrentPermissions, requirePermission } from "@/modules/auth/guards";
import {
  getCurrentUser,
  getUserStores,
  resolveCurrentStore,
} from "@/modules/auth/session";
import { listProducts } from "@/modules/catalog/repository";
import { listStockPoolLinks, listStockPools } from "@/modules/stock/pool-repository";
import { StockManager } from "./StockManager";

export const dynamic = "force-dynamic";

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

  const productsRes = await listProducts(ctx.storeId, { includeInactive: false });
  const [poolsRes, { resolved }] = await Promise.all([
    // รวม Pool ที่ปิดใช้งานด้วย — variant ที่ผูกอยู่ต้องยังแก้ยอดได้ (ดู listStockPools)
    listStockPools(ctx.storeId, { includeInactive: true }),
    getResolvedCurrentPermissions(),
  ]);
  const variantIds = (productsRes.data ?? []).flatMap((product) =>
    product.variants.map((variant) => variant.id),
  );
  const linksRes = poolsRes.error
    ? { data: [], error: poolsRes.error }
    : await listStockPoolLinks(ctx.storeId, variantIds);
  const stockDataError = Boolean(productsRes.error || poolsRes.error || linksRes.error);
  return (
    <StockManager
      products={productsRes.data ?? []}
      pools={poolsRes.data}
      links={linksRes.data}
      canManageStock={resolved.can("stock.manage")}
      canManageCatalog={resolved.can("catalog.manage")}
      stockDataError={stockDataError}
    />
  );
}
