import { getConsignmentAccess } from "@/modules/consignment/access";
import { listOpenLots, listResaleProducts } from "@/modules/consignment/repository";
import { listSuppliers } from "@/modules/inventory/repository";
import { ConsignmentHeader, ConsignmentLocked, NotEnabledNotice } from "../ConsignmentChrome";
import { ReceiveWizard } from "./ReceiveWizard";

export const dynamic = "force-dynamic";

export default async function ConsignmentReceivePage() {
  const { ctx, decision } = await getConsignmentAccess();
  if (!decision.allowed) return <ConsignmentLocked message={decision.message} />;
  if (!decision.enabled) {
    return (
      <section className="page-shell max-w-4xl space-y-5">
        <ConsignmentHeader active="/consignment/receive" description="รับของจากเจ้าของ" />
        <NotEnabledNotice />
      </section>
    );
  }
  const [productsRes, suppliersRes, lotsRes] = await Promise.all([
    listResaleProducts(ctx.storeId),
    listSuppliers(ctx.storeId),
    listOpenLots(ctx.storeId),
  ]);
  const error = productsRes.error ?? suppliersRes.error ?? lotsRes.error;
  if (error) return <ConsignmentLocked message={error} />;
  const products = (productsRes.data ?? []).filter((p) => p.sourcingMode !== "made" && p.isActive);

  return (
    <section className="page-shell max-w-4xl space-y-5">
      <ConsignmentHeader
        active="/consignment/receive"
        description="รับของจากเจ้าของ · ฝากขายแบบ เคลียร์ตอนเติมของ จะนับของเหลือและเคลียร์เงินก่อนรับล็อตใหม่"
      />
      <ReceiveWizard products={products} suppliers={(suppliersRes.data ?? []).filter((s) => s.isActive)} lots={lotsRes.data ?? []} />
    </section>
  );
}
