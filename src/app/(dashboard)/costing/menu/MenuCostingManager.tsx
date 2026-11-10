"use client";

import { useMemo, useState, useTransition } from "react";
import { allocationSum, menuAllocationCard, validateAllocation } from "@/modules/costing/allocation";
import {
  deliveryPriceForCommission,
  foodCostPct,
  plateIngredientCost,
  suggestedPriceForFoodCost,
} from "@/modules/costing/math";
import {
  COST_BUCKETS,
  COST_BUCKET_LABELS,
  type AllocationPcts,
  type CostBucket,
  type Ingredient,
  type PriceRounding,
  type ProductCostSetting,
  type RecipeLine,
  type StoreCostSettings,
} from "@/modules/costing/types";
import {
  clearProductAllocationAction,
  saveAllocationAction,
  saveCostSettingsAction,
  saveMenuCostingAction,
} from "../actions";

export interface MenuProduct {
  id: string;
  name: string;
  basePrice: number;
  deliveryPrice: number | null;
  variants: Array<{ id: string; name: string; priceAdjustment: number }>;
}

const BAR_COLORS: Record<CostBucket, string> = {
  ingredient: "#16a34a",
  packaging: "#0d9488",
  labor: "#ea580c",
  overhead: "#64748b",
  profit: "#2563eb",
};

const ROUNDING_LABELS: Record<PriceRounding, string> = {
  none: "ไม่ปัด",
  ceil_1: "ปัดขึ้นเต็มบาท",
  ceil_5: "ปัดขึ้นทีละ 5",
  ceil_10: "ปัดขึ้นทีละ 10",
};

const inputClass = "min-h-11 w-full rounded-lg border border-[var(--border)] bg-white px-3 text-[var(--ink)]";
const baht = (n: number) => n.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

type Flash = { tone: "ok" | "error"; text: string } | null;

function AllocationInputs({
  value,
  onChange,
  disabled,
}: {
  value: Record<CostBucket, string>;
  onChange: (next: Record<CostBucket, string>) => void;
  disabled?: boolean;
}) {
  const sum = allocationSum(Object.fromEntries(COST_BUCKETS.map((b) => [b, Number(value[b]) || 0])) as AllocationPcts);
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        {COST_BUCKETS.map((bucket) => (
          <label key={bucket} className="space-y-1 text-sm">
            <span className="flex items-center gap-1 text-[var(--muted)]">
              <i aria-hidden="true" className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: BAR_COLORS[bucket] }} />
              {COST_BUCKET_LABELS[bucket]} %
            </span>
            <input
              className={inputClass}
              inputMode="decimal"
              disabled={disabled}
              value={value[bucket]}
              onChange={(e) => onChange({ ...value, [bucket]: e.target.value })}
            />
          </label>
        ))}
      </div>
      <p className={`text-sm font-semibold ${sum === 100 ? "text-green-700" : "text-red-600"}`}>รวม {sum}% {sum === 100 ? "✓" : "— ต้องเท่ากับ 100%"}</p>
    </div>
  );
}

const toStrings = (pcts: AllocationPcts) => Object.fromEntries(COST_BUCKETS.map((b) => [b, String(pcts[b])])) as Record<CostBucket, string>;
const toNumbers = (value: Record<CostBucket, string>) => Object.fromEntries(COST_BUCKETS.map((b) => [b, Number(value[b])])) as AllocationPcts;

export function MenuCostingManager({
  products,
  ingredients,
  recipeLines,
  productSettings,
  storeAllocation,
  storeAllocationSaved,
  productOverrides,
  settings,
  deliveryCommissionPct,
  canEdit,
}: {
  products: MenuProduct[];
  ingredients: Ingredient[];
  recipeLines: RecipeLine[];
  productSettings: ProductCostSetting[];
  storeAllocation: AllocationPcts;
  storeAllocationSaved: boolean;
  productOverrides: Record<string, AllocationPcts>;
  settings: StoreCostSettings;
  deliveryCommissionPct: number | null;
  canEdit: boolean;
}) {
  const [flash, setFlash] = useState<Flash>(null);
  const [isPending, startTransition] = useTransition();
  const [query, setQuery] = useState("");
  const [onlyMissing, setOnlyMissing] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [storeDraft, setStoreDraft] = useState(() => toStrings(storeAllocation));
  const [settingsDraft, setSettingsDraft] = useState({ targetFoodCostPct: String(settings.targetFoodCostPct), priceRounding: settings.priceRounding });

  const ingredientsById = useMemo(() => new Map(ingredients.map((i) => [i.id, i])), [ingredients]);
  const settingsByProduct = useMemo(() => new Map(productSettings.map((s) => [s.productId, s])), [productSettings]);

  const rows = useMemo(
    () =>
      products.map((product) => {
        const setting = settingsByProduct.get(product.id);
        const ingredientCost = plateIngredientCost(recipeLines, ingredientsById, product.id, null);
        const packagingCost = setting?.packagingCost ?? 0;
        const pcts = productOverrides[product.id] ?? storeAllocation;
        const card = menuAllocationCard({ price: product.basePrice, ingredientCost, packagingCost, pcts, rounding: settings.priceRounding });
        const plate = (ingredientCost ?? 0) + packagingCost;
        const targetFood = setting?.targetFoodCostPct ?? settings.targetFoodCostPct;
        return {
          product,
          setting,
          ingredientCost,
          packagingCost,
          card,
          foodPct: ingredientCost === null ? null : foodCostPct(plate, product.basePrice),
          suggested: ingredientCost === null ? null : suggestedPriceForFoodCost(plate, targetFood, settings.priceRounding),
          targetFood,
          hasOverride: Boolean(productOverrides[product.id]),
        };
      }),
    [products, recipeLines, ingredientsById, settingsByProduct, productOverrides, storeAllocation, settings],
  );

  const filtered = rows.filter(
    (row) => (!onlyMissing || row.ingredientCost === null) && row.product.name.toLowerCase().includes(query.trim().toLowerCase()),
  );
  const withRecipe = rows.filter((r) => r.ingredientCost !== null).length;

  function run(task: () => Promise<{ error: string | null }>, okText: string, after?: () => void) {
    startTransition(async () => {
      const result = await task();
      if (result.error) {
        setFlash({ tone: "error", text: result.error });
        return;
      }
      setFlash({ tone: "ok", text: okText });
      after?.();
    });
  }

  const storeInvalid = validateAllocation(toNumbers(storeDraft));

  return (
    <div className="space-y-5">
      {flash && (
        <p role="status" className={`rounded-lg px-3 py-2 text-sm ${flash.tone === "ok" ? "bg-green-50 text-green-800" : "bg-red-50 text-red-700"}`}>
          {flash.text}
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <section className="space-y-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <div>
            <h2 className="text-base font-semibold text-[var(--ink)]">สัดส่วนเป้าหมายของร้าน (ต่อราคาขาย)</h2>
            <p className="text-sm text-[var(--muted)]">
              ใช้กับทุกเมนู เว้นแต่ตั้งเฉพาะเมนู · แก้แล้วบันทึกเป็นชุดใหม่ ประวัติเดิมไม่เปลี่ยน
              {!storeAllocationSaved && " · ตอนนี้ใช้ค่าเริ่มต้น 30/10/10/15/35"}
            </p>
          </div>
          <AllocationInputs value={storeDraft} onChange={setStoreDraft} disabled={!canEdit} />
          {canEdit && (
            <button
              type="button"
              className="btn-primary min-h-11"
              disabled={isPending || Boolean(storeInvalid)}
              onClick={() => run(() => saveAllocationAction({ productId: null, pcts: toNumbers(storeDraft) }), "บันทึกสัดส่วนของร้านแล้ว")}
            >
              บันทึกสัดส่วนร้าน
            </button>
          )}
        </section>

        <section className="space-y-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <h2 className="text-base font-semibold text-[var(--ink)]">ตั้งค่าราคาแนะนำ</h2>
          <label className="block space-y-1 text-sm">
            <span className="text-[var(--muted)]">เป้า food cost ของร้าน (%)</span>
            <input
              className={inputClass}
              inputMode="decimal"
              disabled={!canEdit}
              value={settingsDraft.targetFoodCostPct}
              onChange={(e) => setSettingsDraft({ ...settingsDraft, targetFoodCostPct: e.target.value })}
            />
          </label>
          <label className="block space-y-1 text-sm">
            <span className="text-[var(--muted)]">ปัดราคาแนะนำ</span>
            <select
              className={inputClass}
              disabled={!canEdit}
              value={settingsDraft.priceRounding}
              onChange={(e) => setSettingsDraft({ ...settingsDraft, priceRounding: e.target.value as PriceRounding })}
            >
              {(Object.keys(ROUNDING_LABELS) as PriceRounding[]).map((rule) => (
                <option key={rule} value={rule}>
                  {ROUNDING_LABELS[rule]}
                </option>
              ))}
            </select>
          </label>
          <p className="text-xs text-[var(--muted)]">
            GP เดลิเวอรี: {deliveryCommissionPct === null ? "ยังไม่ได้เชื่อมช่องทาง" : `${deliveryCommissionPct}% (จากช่องทางที่เชื่อมอยู่)`}
          </p>
          {canEdit && (
            <button
              type="button"
              className="btn-secondary min-h-11"
              disabled={isPending}
              onClick={() =>
                run(
                  () => saveCostSettingsAction({ targetFoodCostPct: Number(settingsDraft.targetFoodCostPct), priceRounding: settingsDraft.priceRounding }),
                  "บันทึกค่าตั้งราคาแนะนำแล้ว",
                )
              }
            >
              บันทึก
            </button>
          )}
        </section>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <input
          className={`${inputClass} max-w-xs`}
          placeholder="ค้นหาเมนู"
          aria-label="ค้นหาเมนู"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <label className="flex min-h-11 items-center gap-2 text-sm text-[var(--ink)]">
          <input type="checkbox" checked={onlyMissing} onChange={(e) => setOnlyMissing(e.target.checked)} />
          เฉพาะเมนูที่ยังไม่มีสูตร
        </label>
        <p className="text-sm text-[var(--muted)]">
          มีสูตรแล้ว {withRecipe}/{rows.length} เมนู
        </p>
      </div>

      {ingredients.length === 0 && (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">ยังไม่มีวัตถุดิบ — เพิ่มที่แท็บ &quot;วัตถุดิบ&quot; ก่อน แล้วค่อยกลับมาผูกสูตร</p>
      )}

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {filtered.map((row) => (
          <article
            key={row.product.id}
            // กำลังแก้สูตร → ขยายเต็มแถวให้ฟอร์มไม่อัดในการ์ดแคบ
            className={`flex flex-col rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 ${
              editingId === row.product.id ? "md:col-span-2 xl:col-span-3" : ""
            }`}
          >
            <header className="flex items-baseline justify-between gap-2 border-b border-[var(--border)] pb-2">
              <h3 className="min-w-0 truncate text-base font-semibold text-[var(--ink)]">{row.product.name}</h3>
              <strong className="shrink-0 tabular-nums text-green-700">{baht(row.product.basePrice)} ฿</strong>
            </header>

            {row.ingredientCost === null ? (
              <p className="my-3 rounded-lg bg-[var(--surface-muted)] px-3 py-3 text-sm text-[var(--muted)]">ยังไม่มีสูตร — ยังคำนวณต้นทุนไม่ได้</p>
            ) : (
              <ul className="my-2 space-y-2" aria-label={`สัดส่วนต้นทุน ${row.product.name}`}>
                {row.card.lines.map((line) => (
                  <li key={line.bucket} className="space-y-1">
                    <div className="flex items-baseline justify-between gap-2 text-sm">
                      <span className="font-medium text-[var(--ink)]">
                        {COST_BUCKET_LABELS[line.bucket]}
                        <small className="ml-1 text-xs font-normal text-[var(--muted)]">
                          เป้า {line.targetPct}% · {baht(line.targetAmount)}
                        </small>
                      </span>
                      <span className={`tabular-nums ${line.offTarget ? "font-semibold text-orange-600" : "text-[var(--ink)]"}`}>
                        {line.actualPct}% · {baht(line.actualAmount)}
                      </span>
                    </div>
                    <div className="relative h-2 rounded-full bg-[var(--surface-muted)]">
                      <i
                        className="block h-full rounded-full"
                        style={{ width: `${Math.max(0, Math.min(100, line.actualPct))}%`, background: BAR_COLORS[line.bucket] }}
                      />
                      <s
                        aria-hidden="true"
                        className="absolute -top-1 h-4 w-0.5 bg-[var(--ink)] opacity-60"
                        style={{ left: `${Math.min(100, line.targetPct)}%` }}
                      />
                    </div>
                  </li>
                ))}
              </ul>
            )}

            <footer className="mt-auto space-y-1 border-t border-[var(--border)] pt-2 text-sm text-[var(--ink)]">
              {row.ingredientCost !== null && (
                <>
                  <p>
                    ต้นทุนต่อจาน <strong className="tabular-nums">{baht(row.ingredientCost + row.packagingCost)}</strong> · food cost{" "}
                    <strong className="tabular-nums">{row.foodPct === null ? "—" : `${row.foodPct.toFixed(1)}%`}</strong>
                  </p>
                  {row.card.priceForTarget !== null && (
                    <p>
                      ราคาที่กำไรตามเป้า <strong className="tabular-nums">{row.card.priceForTarget} ฿</strong>
                      {row.suggested !== null && <span className="text-[var(--muted)]"> · ตามเป้า food cost {row.targetFood}%: {row.suggested} ฿</span>}
                    </p>
                  )}
                  {deliveryCommissionPct !== null && (
                    <p className="text-[var(--muted)]">
                      เดลิเวอรีควรขาย {deliveryPriceForCommission(row.product.basePrice, deliveryCommissionPct, settings.priceRounding) ?? "—"} ฿
                      {row.product.deliveryPrice !== null && ` (ตั้งไว้ ${row.product.deliveryPrice} ฿)`}
                    </p>
                  )}
                </>
              )}
              {row.hasOverride && <p className="text-xs text-[var(--muted)]">ใช้สัดส่วนเฉพาะเมนูนี้</p>}
              {canEdit && (
                <button
                  type="button"
                  className="mt-1 min-h-11 w-full rounded-lg border border-[var(--border)] text-sm font-semibold text-[var(--tenant-primary)] hover:bg-[var(--surface-muted)]"
                  onClick={() => setEditingId(editingId === row.product.id ? null : row.product.id)}
                  aria-expanded={editingId === row.product.id}
                >
                  {editingId === row.product.id ? "ปิด" : row.ingredientCost === null ? "+ ผูกสูตร" : "แก้สูตร / ต้นทุน"}
                </button>
              )}
            </footer>

            {editingId === row.product.id && (
              <MenuEditor
                key={row.product.id}
                product={row.product}
                ingredients={ingredients}
                ingredientsById={ingredientsById}
                lines={recipeLines.filter((l) => l.productId === row.product.id)}
                packagingCost={row.packagingCost}
                targetFoodCostPct={row.setting?.targetFoodCostPct ?? null}
                override={productOverrides[row.product.id] ?? null}
                storeAllocation={storeAllocation}
                isPending={isPending}
                run={run}
                onDone={() => setEditingId(null)}
              />
            )}
          </article>
        ))}
      </div>
      {filtered.length === 0 && <p className="text-center text-sm text-[var(--muted)]">ไม่พบเมนู</p>}
    </div>
  );
}

interface DraftLine {
  key: string;
  variantId: string | null;
  ingredientId: string;
  quantity: string;
}

function MenuEditor({
  product,
  ingredients,
  ingredientsById,
  lines,
  packagingCost,
  targetFoodCostPct,
  override,
  storeAllocation,
  isPending,
  run,
  onDone,
}: {
  product: MenuProduct;
  ingredients: Ingredient[];
  ingredientsById: Map<string, Ingredient>;
  lines: RecipeLine[];
  packagingCost: number;
  targetFoodCostPct: number | null;
  override: AllocationPcts | null;
  storeAllocation: AllocationPcts;
  isPending: boolean;
  run: (task: () => Promise<{ error: string | null }>, okText: string, after?: () => void) => void;
  onDone: () => void;
}) {
  const [draftLines, setDraftLines] = useState<DraftLine[]>(() =>
    lines.map((l) => ({ key: l.id, variantId: l.variantId, ingredientId: l.ingredientId, quantity: String(l.quantity) })),
  );
  const [packaging, setPackaging] = useState(String(packagingCost));
  const [targetFood, setTargetFood] = useState(targetFoodCostPct === null ? "" : String(targetFoodCostPct));
  const [useOverride, setUseOverride] = useState(Boolean(override));
  const [overrideDraft, setOverrideDraft] = useState(() => toStrings(override ?? storeAllocation));

  const activeIngredients = ingredients.filter((i) => i.isActive);
  const previewLines: RecipeLine[] = draftLines
    .filter((l) => l.ingredientId && Number(l.quantity) > 0)
    .map((l) => ({ id: l.key, productId: product.id, variantId: l.variantId, ingredientId: l.ingredientId, quantity: Number(l.quantity) }));
  const variantRows = [{ id: null as string | null, name: "ปกติ", price: product.basePrice }, ...product.variants.map((v) => ({ id: v.id as string | null, name: v.name, price: product.basePrice + v.priceAdjustment }))];

  function addLine() {
    setDraftLines((current) => [...current, { key: `new-${Date.now()}-${current.length}`, variantId: null, ingredientId: activeIngredients[0]?.id ?? "", quantity: "" }]);
  }

  function saveRecipe() {
    const cleaned = draftLines.filter((l) => l.ingredientId && l.quantity.trim() !== "");
    run(
      () =>
        saveMenuCostingAction({
          productId: product.id,
          lines: cleaned.map((l) => ({ variantId: l.variantId, ingredientId: l.ingredientId, quantity: Number(l.quantity) })),
          packagingCost: Number(packaging) || 0,
          targetFoodCostPct: targetFood.trim() === "" ? null : Number(targetFood),
        }),
      `บันทึกสูตร ${product.name} แล้ว`,
    );
  }

  return (
    <div className="mt-3 space-y-4 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] p-3">
      <section className="space-y-2">
        <h4 className="text-sm font-semibold text-[var(--ink)]">สูตร (ต่อ 1 ที่)</h4>
        {draftLines.length === 0 && <p className="text-sm text-[var(--muted)]">ยังไม่มีวัตถุดิบในสูตร</p>}
        {draftLines.map((line, index) => {
          const ingredient = ingredientsById.get(line.ingredientId);
          return (
            <div key={line.key} className="grid grid-cols-[minmax(0,1fr)_88px_auto] gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,0.8fr)_88px_auto]">
              <select
                aria-label="วัตถุดิบ"
                className={inputClass}
                value={line.ingredientId}
                onChange={(e) => setDraftLines((c) => c.map((l, i) => (i === index ? { ...l, ingredientId: e.target.value } : l)))}
              >
                <option value="">เลือกวัตถุดิบ</option>
                {activeIngredients.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name} ({i.usageUnit})
                  </option>
                ))}
              </select>
              <select
                aria-label="ใช้กับตัวเลือก"
                className={`${inputClass} col-span-3 sm:col-span-1`}
                value={line.variantId ?? ""}
                onChange={(e) => setDraftLines((c) => c.map((l, i) => (i === index ? { ...l, variantId: e.target.value || null } : l)))}
              >
                <option value="">ทุกตัวเลือก</option>
                {product.variants.map((v) => (
                  <option key={v.id} value={v.id}>
                    เฉพาะ {v.name}
                  </option>
                ))}
              </select>
              <input
                aria-label={`ปริมาณ (${ingredient?.usageUnit ?? "หน่วย"})`}
                className={inputClass}
                inputMode="decimal"
                placeholder={ingredient?.usageUnit ?? "ปริมาณ"}
                value={line.quantity}
                onChange={(e) => setDraftLines((c) => c.map((l, i) => (i === index ? { ...l, quantity: e.target.value } : l)))}
              />
              <button
                type="button"
                aria-label="ลบบรรทัด"
                className="min-h-11 px-2 text-sm font-semibold text-red-600"
                onClick={() => setDraftLines((c) => c.filter((_, i) => i !== index))}
              >
                ✕
              </button>
            </div>
          );
        })}
        <button type="button" className="min-h-11 text-sm font-semibold text-[var(--tenant-primary)]" disabled={activeIngredients.length === 0} onClick={addLine}>
          + เพิ่มวัตถุดิบในสูตร
        </button>
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="space-y-1 text-sm">
            <span className="text-[var(--muted)]">บรรจุภัณฑ์ต่อชิ้น (บาท)</span>
            <input className={inputClass} inputMode="decimal" value={packaging} onChange={(e) => setPackaging(e.target.value)} />
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-[var(--muted)]">เป้า food cost เมนูนี้ (%) — เว้นว่าง = ใช้ของร้าน</span>
            <input className={inputClass} inputMode="decimal" value={targetFood} onChange={(e) => setTargetFood(e.target.value)} />
          </label>
        </div>
        <div className="rounded-lg bg-white p-2 text-sm">
          {variantRows.map((v) => {
            const cost = plateIngredientCost(previewLines, ingredientsById, product.id, v.id);
            const plate = (cost ?? 0) + (Number(packaging) || 0);
            const pct = cost === null ? null : foodCostPct(plate, v.price);
            return (
              <p key={v.id ?? "base"} className="flex justify-between gap-2 tabular-nums">
                <span>
                  {v.name} · {baht(v.price)} ฿
                </span>
                <span>{cost === null ? "ยังไม่มีสูตร" : `ต้นทุน ${baht(plate)} · ${pct === null ? "—" : pct.toFixed(1)}%`}</span>
              </p>
            );
          })}
        </div>
        <button type="button" className="btn-primary min-h-11" disabled={isPending} onClick={saveRecipe}>
          บันทึกสูตร
        </button>
      </section>

      <section className="space-y-2 border-t border-[var(--border)] pt-3">
        <label className="flex min-h-11 items-center gap-2 text-sm font-semibold text-[var(--ink)]">
          <input type="checkbox" checked={useOverride} onChange={(e) => setUseOverride(e.target.checked)} />
          ตั้งสัดส่วนเฉพาะเมนูนี้
        </label>
        {useOverride ? (
          <>
            <AllocationInputs value={overrideDraft} onChange={setOverrideDraft} />
            <button
              type="button"
              className="btn-secondary min-h-11"
              disabled={isPending || Boolean(validateAllocation(toNumbers(overrideDraft)))}
              onClick={() => run(() => saveAllocationAction({ productId: product.id, pcts: toNumbers(overrideDraft) }), `บันทึกสัดส่วนของ ${product.name} แล้ว`)}
            >
              บันทึกสัดส่วนเมนูนี้
            </button>
          </>
        ) : (
          override && (
            <button
              type="button"
              className="btn-secondary min-h-11"
              disabled={isPending}
              onClick={() => run(() => clearProductAllocationAction(product.id), `${product.name} กลับไปใช้สัดส่วนของร้านแล้ว`, onDone)}
            >
              กลับไปใช้สัดส่วนของร้าน
            </button>
          )
        )}
      </section>
    </div>
  );
}
