import { getInventoryAccess } from "@/modules/inventory/access";
import { listInventoryItems, listSuppliers } from "@/modules/inventory/repository";
import { listExpenseCategories, listPurchaseBills } from "@/modules/purchasing/repository";
import { CostingHeader, CostingLocked } from "../CostingChrome";
import { PurchaseBillsManager } from "./PurchaseBillsManager";

export const dynamic = "force-dynamic";

export default async function CostingPurchasesPage() {
  const { ctx, decision } = await getInventoryAccess();
  if (!decision.allowed) return <CostingLocked message={decision.message} />;

  const [billsRes, itemsRes, suppliersRes, categoriesRes] = await Promise.all([
    listPurchaseBills(ctx.storeId),
    listInventoryItems(ctx.storeId),
    listSuppliers(ctx.storeId),
    listExpenseCategories(ctx.storeId),
  ]);
  const error = billsRes.error ?? itemsRes.error ?? suppliersRes.error ?? categoriesRes.error;
  if (error) return <CostingLocked message={error} />;

  return (
    <section className="page-shell max-w-5xl space-y-5">
      <CostingHeader
        active="/costing/purchases"
        title="บิลซื้อ"
        description="บันทึกบิลซื้อ → รับเข้าคลัง + อัปเดตราคาซื้อ/ต้นทุนเฉลี่ย + ลงรายจ่าย · สต็อกติดลบ: ซื้อเข้าแล้วนับใหม่ตามที่ซื้อ"
      />
      <PurchaseBillsManager
        bills={billsRes.data ?? []}
        items={(itemsRes.data ?? []).filter((i) => i.isActive)}
        suppliers={(suppliersRes.data ?? []).filter((s) => s.isActive)}
        categories={categoriesRes.data ?? []}
        enabled={decision.enabled}
        canEdit={decision.canEdit}
      />
    </section>
  );
}
