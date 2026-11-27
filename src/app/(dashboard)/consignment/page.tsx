import { getConsignmentAccess } from "@/modules/consignment/access";
import {
  getSettlementPreview,
  listNeedsFlavor,
  listOpenLots,
  listResaleProducts,
} from "@/modules/consignment/repository";
import type { SettlementPreview } from "@/modules/consignment/types";
import { listSuppliers } from "@/modules/inventory/repository";
import { SuppliersManager } from "../costing/suppliers/SuppliersManager";
import { saveConsignmentSupplierAction } from "./actions";
import { ConsignmentHeader, ConsignmentLocked } from "./ConsignmentChrome";
import { ConsignmentToggle } from "./ConsignmentToggle";
import { LotsPanel } from "./LotsPanel";
import { NeedsFlavorPanel } from "./NeedsFlavorPanel";
import { OutstandingPanel } from "./OutstandingPanel";

export const dynamic = "force-dynamic";

export default async function ConsignmentPage() {
  const { ctx, decision } = await getConsignmentAccess();
  if (!decision.allowed) return <ConsignmentLocked message={decision.message} />;
  const suppliersRes = await listSuppliers(ctx.storeId);
  if (suppliersRes.error) return <ConsignmentLocked message={suppliersRes.error} />;
  const suppliers = suppliersRes.data ?? [];

  let products: Awaited<ReturnType<typeof listResaleProducts>>["data"] = [];
  let previews: SettlementPreview[] = [];
  let needsFlavor: Awaited<ReturnType<typeof listNeedsFlavor>>["data"] = [];
  let lots: Awaited<ReturnType<typeof listOpenLots>>["data"] = [];
  let loadError: string | null = null;
  if (decision.enabled) {
    const [productsRes, needsRes, lotsRes] = await Promise.all([
      listResaleProducts(ctx.storeId),
      listNeedsFlavor(ctx.storeId),
      listOpenLots(ctx.storeId),
    ]);
    loadError = productsRes.error ?? needsRes.error ?? lotsRes.error;
    products = productsRes.data ?? [];
    needsFlavor = needsRes.data ?? [];
    lots = lotsRes.data ?? [];
    // ยอดค้าง: เฉพาะเจ้าของที่มีเมนูฝากขาย
    const consignOwners = new Set(products.filter((p) => p.sourcingMode === "consignment" && p.supplierId).map((p) => p.supplierId as string));
    const results = await Promise.all([...consignOwners].map((id) => getSettlementPreview(id)));
    previews = results.map((r) => r.data).filter((p): p is SettlementPreview => !!p);
  }

  return (
    <section className="page-shell max-w-5xl space-y-6">
      <ConsignmentHeader active="/consignment" description="รับขนมหรือสินค้าจากร้านอื่นมาขาย · ซื้อขาดจ่ายตอนรับของ · ฝากขายจ่ายเจ้าของเฉพาะที่ขายได้" />

      <ConsignmentToggle enabled={decision.enabled} canToggle={decision.canToggle} />

      {loadError && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{loadError}</p>}

      {decision.enabled && (
        <>
          <OutstandingPanel previews={previews} products={products ?? []} />
          {(needsFlavor ?? []).length > 0 && <NeedsFlavorPanel rows={needsFlavor ?? []} products={products ?? []} />}
          <LotsPanel lots={lots ?? []} products={products ?? []} suppliers={suppliers} />
        </>
      )}

      <div className="space-y-2">
        <h2 className="text-lg font-semibold text-[var(--ink)]">เจ้าของสินค้า / ผู้ขาย</h2>
        <p className="text-sm text-[var(--muted)]">
          ตั้งวิธีรับเงิน (เงินสด/โอน) และรอบเคลียร์เงิน (ทุกวันตอนปิดรอบ หรือตอนมาเติมของ) ของแต่ละราย · ใช้ทะเบียนเดียวกับผู้ขายวัตถุดิบ
        </p>
      </div>
      <SuppliersManager suppliers={suppliers} canEdit={decision.canManageSuppliers} saveAction={saveConsignmentSupplierAction} showConsignment />
    </section>
  );
}
