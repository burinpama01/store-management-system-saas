import { listProducts } from "@/modules/catalog/repository";
import { effectiveAllocation } from "@/modules/costing/allocation";
import { getCostingAccess } from "@/modules/costing/access";
import { loadCostingWorkspace } from "@/modules/costing/repository";
import { DEFAULT_ALLOCATION } from "@/modules/costing/types";
import { CostingHeader, CostingLocked } from "../CostingChrome";
import { MenuCostingManager, type MenuProduct } from "./MenuCostingManager";

export const dynamic = "force-dynamic";

export default async function CostingMenuPage() {
  const { ctx, decision } = await getCostingAccess();
  if (!decision.allowed) return <CostingLocked message={decision.message} />;
  const [workspace, productsRes] = await Promise.all([
    loadCostingWorkspace(ctx.storeId),
    listProducts(ctx.storeId, { includeInactive: false }),
  ]);
  if (!workspace.data) return <CostingLocked message={workspace.error ?? "โหลดข้อมูลต้นทุนไม่สำเร็จ"} />;
  const data = workspace.data;

  const products: MenuProduct[] = (productsRes.data ?? []).map((product) => ({
    id: product.id,
    name: product.name,
    basePrice: product.basePrice,
    deliveryPrice: product.deliveryPrice ?? null,
    variants: product.variants.filter((v) => v.isActive).map((v) => ({ id: v.id, name: v.name, priceAdjustment: v.priceAdjustment })),
  }));
  const storeTemplate = effectiveAllocation(data.templates, null);
  const productOverrides = Object.fromEntries(
    products.flatMap((product) => {
      const t = data.templates.find((template) => template.productId === product.id);
      return t ? [[product.id, t.pcts]] : [];
    }),
  );

  return (
    <section className="page-shell max-w-6xl space-y-5">
      <CostingHeader
        active="/costing/menu"
        title="ต้นทุนเมนู"
        description="ผูกสูตรกับเมนู ดูสัดส่วน 5 ส่วนต่อหน่วยเทียบเป้า และราคาที่ควรขาย"
      />
      <MenuCostingManager
        products={products}
        ingredients={data.ingredients}
        recipeLines={data.recipeLines}
        productSettings={data.productSettings}
        storeAllocation={storeTemplate?.pcts ?? DEFAULT_ALLOCATION}
        storeAllocationSaved={Boolean(storeTemplate)}
        productOverrides={productOverrides}
        settings={data.settings}
        deliveryCommissionPct={data.deliveryCommissionPct}
        canEdit={decision.canEdit}
      />
    </section>
  );
}
