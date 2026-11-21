import { getInventoryAccess } from "@/modules/inventory/access";
import { listSuppliers } from "@/modules/inventory/repository";
import { CostingHeader, CostingLocked } from "../CostingChrome";
import { SuppliersManager } from "./SuppliersManager";

export const dynamic = "force-dynamic";

export default async function CostingSuppliersPage() {
  const { ctx, decision } = await getInventoryAccess();
  if (!decision.allowed) return <CostingLocked message={decision.message} />;
  const suppliersRes = await listSuppliers(ctx.storeId);
  if (suppliersRes.error) return <CostingLocked message={suppliersRes.error} />;

  return (
    <section className="page-shell max-w-5xl space-y-5">
      <CostingHeader
        active="/costing/suppliers"
        title="ผู้ขาย"
        description="ร้านที่ซื้อวัตถุดิบประจำ · ใช้กับบิลซื้อ ใบสั่งซื้อ และรายงานภาษีซื้อ"
      />
      <SuppliersManager suppliers={suppliersRes.data ?? []} canEdit={decision.canManageSuppliers} />
    </section>
  );
}
