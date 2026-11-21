import { getInventoryAccess } from "@/modules/inventory/access";
import { listInventoryItems, listRecentMovements, listSuppliers } from "@/modules/inventory/repository";
import { CostingHeader, CostingLocked } from "../CostingChrome";
import { InventoryManager } from "./InventoryManager";

export const dynamic = "force-dynamic";

export default async function CostingInventoryPage() {
  const { ctx, decision } = await getInventoryAccess();
  if (!decision.allowed) return <CostingLocked message={decision.message} />;

  const [itemsRes, suppliersRes, movementsRes] = await Promise.all([
    listInventoryItems(ctx.storeId),
    listSuppliers(ctx.storeId),
    decision.enabled ? listRecentMovements(ctx.storeId, null, 30) : Promise.resolve({ data: [], error: null }),
  ]);
  const error = itemsRes.error ?? suppliersRes.error ?? movementsRes.error;
  if (error) return <CostingLocked message={error} />;

  return (
    <section className="page-shell max-w-5xl space-y-5">
      <CostingHeader
        active="/costing/inventory"
        title="คลังวัตถุดิบ"
        description="ยอดคงเหลือและต้นทุนเฉลี่ยของวัตถุดิบ (หน่วยที่ใช้ในสูตร) · ทุกการเปลี่ยนยอดมีประวัติ"
      />
      <InventoryManager
        items={itemsRes.data ?? []}
        suppliers={(suppliersRes.data ?? []).filter((s) => s.isActive)}
        movements={movementsRes.data ?? []}
        enabled={decision.enabled}
        canEdit={decision.canEdit}
        canConfigure={decision.canManageSuppliers}
        canToggle={decision.canToggle}
      />
    </section>
  );
}
