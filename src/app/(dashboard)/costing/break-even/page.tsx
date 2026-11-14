import { listProducts } from "@/modules/catalog/repository";
import { getCostingAccess } from "@/modules/costing/access";
import { previousMonthRange, type MixRow } from "@/modules/costing/break-even";
import {
  listCostBudgets,
  listExpenseCategories,
  loadActualFixedCosts,
  loadLatestPayroll,
} from "@/modules/costing/break-even-repository";
import { plateIngredientCost } from "@/modules/costing/math";
import { loadCostingWorkspace } from "@/modules/costing/repository";
import { bangkokToday } from "@/modules/reports/insights";
import { getSalesInsights } from "@/modules/reports/insights-repository";
import { logSystemEvent } from "@/modules/system/event-log";
import { CostingHeader, CostingLocked } from "../CostingChrome";
import { BreakEvenPlanner, type PlannerProduct } from "./BreakEvenPlanner";

export const dynamic = "force-dynamic";

const SALES_WINDOW_DAYS = 30;

function shiftDate(date: string, days: number) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export default async function BreakEvenPage() {
  const { user, ctx, decision } = await getCostingAccess();
  if (!decision.allowed) return <CostingLocked message={decision.message} />;

  const today = bangkokToday();
  const salesFrom = shiftDate(today, -(SALES_WINDOW_DAYS - 1));
  const lastMonth = previousMonthRange(today);
  const scope = { organizationId: ctx.organizationId, storeId: ctx.storeId, userId: user.id };

  const [workspace, productsRes, budgetsRes, insights, categoriesRes, payroll] = await Promise.all([
    loadCostingWorkspace(ctx.storeId),
    listProducts(ctx.storeId, { includeInactive: false }),
    listCostBudgets(ctx.storeId),
    getSalesInsights(scope, salesFrom, today),
    listExpenseCategories(ctx.storeId),
    loadLatestPayroll(ctx.storeId),
  ]);
  if (!workspace.data) return <CostingLocked message={workspace.error ?? "โหลดข้อมูลต้นทุนไม่สำเร็จ"} />;
  const data = workspace.data;

  const actual = categoriesRes.error ? null : await loadActualFixedCosts(ctx.storeId, lastMonth, categoriesRes.data);

  const loadErrors = [budgetsRes.error, categoriesRes.error, actual?.error].filter(Boolean);
  if (loadErrors.length > 0) {
    await logSystemEvent({
      level: "warn",
      source: "costing.break_even",
      action: "loadPage",
      message: `โหลดข้อมูลหน้าจุดคุ้มทุนไม่ครบ: ${loadErrors.join(" | ")}`,
      organizationId: ctx.organizationId,
      storeId: ctx.storeId,
      actorUserId: user.id,
    }).catch(() => undefined);
  }

  const ingredientsById = new Map(data.ingredients.map((i) => [i.id, i]));
  const packagingBy = new Map(data.productSettings.map((s) => [s.productId, s.packagingCost]));
  const unitCostOf = (productId: string): number | null => {
    const ingredient = plateIngredientCost(data.recipeLines, ingredientsById, productId, null);
    return ingredient === null ? null : ingredient + (packagingBy.get(productId) ?? 0);
  };

  // สัดส่วนเมนูที่ขายจริง 30 วัน (ราคาเฉลี่ยจริง = ยอดก่อนส่วนลดท้ายบิล ÷ จำนวน)
  const mix: MixRow[] = (insights.data?.products ?? []).flatMap((p) => {
    if (!p.productId || !(p.qty > 0)) return [];
    return [{ productId: p.productId, name: p.name, qty: p.qty, price: p.revenue / p.qty, unitCost: unitCostOf(p.productId) }];
  });

  const products: PlannerProduct[] = (productsRes.data ?? []).map((product) => ({
    id: product.id,
    name: product.name,
    price: product.basePrice,
    unitCost: unitCostOf(product.id),
  }));

  return (
    <section className="page-shell max-w-5xl space-y-5">
      <CostingHeader
        active="/costing/break-even"
        title="จุดคุ้มทุน"
        description="ต้องขายวันละกี่ชิ้นถึงคุ้มทุน ต้นทุนคงที่ ค่าเสื่อม และราคาที่ควรขายเมื่อคิดต้นทุนทั้งหมด"
      />
      <BreakEvenPlanner
        canEdit={decision.canEdit}
        settings={data.settings}
        budgets={budgetsRes.data}
        budgetsError={budgetsRes.error}
        mix={mix}
        windowDays={SALES_WINDOW_DAYS}
        salesError={insights.error}
        salesRangeLabel={`${salesFrom} – ${today}`}
        products={products}
        categories={categoriesRes.data}
        categoriesError={categoriesRes.error}
        actual={actual && !actual.error ? { ...actual.data, label: lastMonth.label } : null}
        payroll={payroll}
      />
    </section>
  );
}
