import { getCostingAccess } from "@/modules/costing/access";
import { loadCostingWorkspace } from "@/modules/costing/repository";
import { CostingHeader, CostingLocked } from "../CostingChrome";
import { IngredientsManager } from "./IngredientsManager";

export const dynamic = "force-dynamic";

export default async function CostingIngredientsPage() {
  const { ctx, decision } = await getCostingAccess();
  if (!decision.allowed) return <CostingLocked message={decision.message} />;
  const workspace = await loadCostingWorkspace(ctx.storeId);
  if (!workspace.data) return <CostingLocked message={workspace.error ?? "โหลดข้อมูลต้นทุนไม่สำเร็จ"} />;

  const usage = new Map<string, number>();
  for (const line of workspace.data.recipeLines) usage.set(line.ingredientId, (usage.get(line.ingredientId) ?? 0) + 1);

  return (
    <section className="page-shell max-w-5xl space-y-5">
      <CostingHeader
        active="/costing/ingredients"
        title="วัตถุดิบ"
        description="ราคาซื้อ → ต้นทุนต่อหน่วยที่ใช้จริง (หักส่วนที่ทิ้ง) ใช้คำนวณต้นทุนต่อจานทุกเมนู"
      />
      <IngredientsManager
        ingredients={workspace.data.ingredients}
        usageCount={Object.fromEntries(usage)}
        canEdit={decision.canEdit}
      />
    </section>
  );
}
