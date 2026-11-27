import { getConsignmentAccess } from "@/modules/consignment/access";
import { getStockLevels, listResaleProducts } from "@/modules/consignment/repository";
import { listSuppliers } from "@/modules/inventory/repository";
import { ConsignmentHeader, ConsignmentLocked, NotEnabledNotice } from "../ConsignmentChrome";
import { ProductSourcingManager } from "./ProductSourcingManager";

export const dynamic = "force-dynamic";

export default async function ConsignmentProductsPage({ searchParams }: { searchParams: Promise<{ product?: string }> }) {
  const { ctx, decision } = await getConsignmentAccess();
  if (!decision.allowed) return <ConsignmentLocked message={decision.message} />;
  const { product } = await searchParams;
  if (!decision.enabled) {
    return (
      <section className="page-shell max-w-5xl space-y-5">
        <ConsignmentHeader active="/consignment/products" description="ตั้งว่าเมนูไหนซื้อมาขายหรือรับฝากขาย" />
        <NotEnabledNotice />
      </section>
    );
  }
  const [productsRes, suppliersRes, stockRes] = await Promise.all([
    listResaleProducts(ctx.storeId),
    listSuppliers(ctx.storeId),
    getStockLevels(ctx.storeId),
  ]);
  const error = productsRes.error ?? suppliersRes.error ?? stockRes.error;
  if (error) return <ConsignmentLocked message={error} />;

  return (
    <section className="page-shell max-w-5xl space-y-5">
      <ConsignmentHeader
        active="/consignment/products"
        description="ตั้งว่าเมนูไหนซื้อมาขายหรือรับฝากขาย ของใคร คิดเงินแบบไหน และราคาต่อชิ้นแยกรายรส"
      />
      <ProductSourcingManager
        products={productsRes.data ?? []}
        suppliers={(suppliersRes.data ?? []).filter((s) => s.isActive)}
        stock={stockRes.data ?? []}
        initialProductId={typeof product === "string" ? product : null}
      />
    </section>
  );
}
