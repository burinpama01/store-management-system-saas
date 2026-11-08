import Link from "next/link";
import { listProducts } from "@/modules/catalog/repository";
import { effectiveAllocation, menuAllocationCard } from "@/modules/costing/allocation";
import { getCostingAccess } from "@/modules/costing/access";
import { foodCostPct, plateIngredientCost } from "@/modules/costing/math";
import { loadCostingWorkspace } from "@/modules/costing/repository";
import { DEFAULT_ALLOCATION } from "@/modules/costing/types";
import { CostingHeader, CostingLocked, money } from "./CostingChrome";

export const dynamic = "force-dynamic";

export default async function CostingOverviewPage() {
  const { ctx, decision } = await getCostingAccess();
  if (!decision.allowed) return <CostingLocked message={decision.message} />;
  const [workspace, productsRes] = await Promise.all([
    loadCostingWorkspace(ctx.storeId),
    listProducts(ctx.storeId, { includeInactive: false }),
  ]);
  if (!workspace.data) return <CostingLocked message={workspace.error ?? "โหลดข้อมูลต้นทุนไม่สำเร็จ"} />;
  const data = workspace.data;
  const products = productsRes.data ?? [];
  const ingredientsById = new Map(data.ingredients.map((i) => [i.id, i]));
  const packagingBy = new Map(data.productSettings.map((s) => [s.productId, s.packagingCost]));

  const costed = products.flatMap((product) => {
    const ingredientCost = plateIngredientCost(data.recipeLines, ingredientsById, product.id, null);
    if (ingredientCost === null) return [];
    const packaging = packagingBy.get(product.id) ?? 0;
    const pcts = effectiveAllocation(data.templates, product.id)?.pcts ?? DEFAULT_ALLOCATION;
    const card = menuAllocationCard({ price: product.basePrice, ingredientCost, packagingCost: packaging, pcts, rounding: data.settings.priceRounding });
    const profit = card.lines.find((l) => l.bucket === "profit");
    return [{ product, food: foodCostPct(ingredientCost + packaging, product.basePrice), profitOff: Boolean(profit?.offTarget), profitPct: profit?.actualPct ?? 0 }];
  });
  const offTarget = costed.filter((c) => c.profitOff).sort((a, b) => a.profitPct - b.profitPct);
  const avgFood = costed.length > 0 ? costed.reduce((sum, c) => sum + (c.food ?? 0), 0) / costed.length : null;

  const stats = [
    { label: "เมนูที่มีสูตรแล้ว", value: `${costed.length}/${products.length}` },
    { label: "food cost เฉลี่ย (ไม่ถ่วงยอดขาย)", value: avgFood === null ? "—" : `${avgFood.toFixed(1)}%` },
    { label: "เมนูที่กำไรต่ำกว่าเป้า", value: String(offTarget.length) },
    { label: "วัตถุดิบ", value: String(data.ingredients.length) },
  ];

  return (
    <section className="page-shell max-w-5xl space-y-5">
      <CostingHeader active="/costing" title="ต้นทุนและสัดส่วน" description="ต้นทุนต่อจาน สัดส่วน 5 ส่วนต่อราคาขาย และราคาที่ควรขาย — ข้อมูลระดับผู้จัดการขึ้นไป" />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {stats.map((s) => (
          <div key={s.label} className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
            <p className="text-sm text-[var(--muted)]">{s.label}</p>
            <p className="mt-1 text-2xl font-bold tabular-nums text-[var(--ink)]">{s.value}</p>
          </div>
        ))}
      </div>

      {costed.length === 0 ? (
        <div className="space-y-2 rounded-xl border border-dashed border-[var(--border)] p-6 text-sm text-[var(--ink)]">
          <p className="font-semibold">เริ่มต้น 2 ขั้น</p>
          <ol className="list-decimal space-y-1 pl-5 text-[var(--muted)]">
            <li>
              เพิ่มวัตถุดิบและราคาซื้อที่ <Link className="font-semibold text-[var(--tenant-primary)]" href="/costing/ingredients">วัตถุดิบ</Link>
            </li>
            <li>
              ผูกสูตรกับเมนูที่ <Link className="font-semibold text-[var(--tenant-primary)]" href="/costing/menu">ต้นทุนเมนู</Link> แล้วดูสัดส่วนและราคาแนะนำ
            </li>
          </ol>
        </div>
      ) : (
        <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <h2 className="text-base font-semibold text-[var(--ink)]">เมนูที่กำไรต่ำกว่าเป้า</h2>
          {offTarget.length === 0 ? (
            <p className="mt-2 text-sm text-green-700">ทุกเมนูที่มีสูตรได้กำไรตามเป้า ✓</p>
          ) : (
            <ul className="mt-2 divide-y divide-[var(--border)] text-sm">
              {offTarget.slice(0, 10).map((c) => (
                <li key={c.product.id} className="flex justify-between gap-2 py-2">
                  <span className="text-[var(--ink)]">{c.product.name}</span>
                  <span className="tabular-nums text-orange-600">
                    กำไร {c.profitPct}% · ราคา {money(c.product.basePrice)} ฿
                  </span>
                </li>
              ))}
            </ul>
          )}
          <Link href="/costing/menu" className="mt-3 inline-flex min-h-11 items-center text-sm font-semibold text-[var(--tenant-primary)]">
            ดูการ์ดทุกเมนู →
          </Link>
        </section>
      )}
      <p className="text-xs text-[var(--muted)]">
        ต้นทุนที่ขายจริงจะถูกบันทึกตอนขายทุกบิล (ใช้ในรายงานแบ่งเก็บเงินเฟสถัดไป) · ราคาตัวเลือกเสริม (เช่น เพิ่มไข่) ยังไม่มีต้นทุน
      </p>
    </section>
  );
}
