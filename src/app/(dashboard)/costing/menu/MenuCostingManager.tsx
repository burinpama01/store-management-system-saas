"use client";

import { useMemo, useState, useTransition } from "react";
import { allocationSum, menuAllocationCard, validateAllocation } from "@/modules/costing/allocation";
import {
  deliveryPriceForCommission,
  foodCostPct,
  ingredientUnitCost,
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
  modifierGroups: Array<{ id: string; name: string; options: Array<{ id: string; name: string; priceAdjustment: number }> }>;
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
        // บรรทัดที่บวกเพิ่มตามตัวเลือกเสริม — ภาพรวมแสดงต้นทุนสูตรหลักเท่านั้น จึงต้องบอกผู้ใช้
        const optionLineCount = recipeLines.filter((l) => l.productId === product.id && l.modifierOptionId !== null).length;
        return {
          product,
          optionLineCount,
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
              <p className="my-3 rounded-lg bg-[var(--surface-muted)] px-3 py-3 text-sm text-[var(--muted)]">
                {row.optionLineCount > 0
                  ? `ยังไม่มีสูตรหลัก — มีวัตถุดิบตามตัวเลือกเสริม ${row.optionLineCount} บรรทัด (เพิ่มสูตรหลักเพื่อคำนวณต้นทุน)`
                  : "ยังไม่มีสูตร — ยังคำนวณต้นทุนไม่ได้"}
              </p>
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
                    ต้นทุนต่อจาน{row.optionLineCount > 0 ? " (สูตรหลัก)" : ""} <strong className="tabular-nums">{baht(row.ingredientCost + row.packagingCost)}</strong> · food cost{" "}
                    <strong className="tabular-nums">{row.foodPct === null ? "—" : `${row.foodPct.toFixed(1)}%`}</strong>
                  </p>
                  {row.optionLineCount > 0 && (
                    <p className="text-xs text-[var(--muted)]">ตัวเลือกเสริม (เช่น เย็น/ปั่น) บวกต้นทุนเพิ่ม — ดูในแก้สูตร</p>
                  )}
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

/** ป้ายตัวเลือก — บอกหน่วยในสูตร และเตือนถ้ายังไม่ใส่ราคา (ต้นทุนจะเป็น 0) */
function ingredientOptionLabel(i: Ingredient) {
  return `${i.name} (${i.usageUnit})${i.purchasePrice === 0 ? " · ยังไม่ใส่ราคา" : ""}`;
}

interface DraftLine {
  key: string;
  variantId: string | null;
  modifierOptionId: string | null;
  ingredientId: string;
  quantity: string;
}

/** ค่าในช่อง "ใช้กับ": "" = สูตรหลัก · v:<id> = เฉพาะตัวเลือกสินค้า · m:<id> = บวกเพิ่มเมื่อเลือกตัวเลือกเสริม */
function scopeValue(line: Pick<DraftLine, "variantId" | "modifierOptionId">) {
  if (line.modifierOptionId) return `m:${line.modifierOptionId}`;
  if (line.variantId) return `v:${line.variantId}`;
  return "";
}

function parseScope(value: string): Pick<DraftLine, "variantId" | "modifierOptionId"> {
  if (value.startsWith("m:")) return { variantId: null, modifierOptionId: value.slice(2) };
  if (value.startsWith("v:")) return { variantId: value.slice(2), modifierOptionId: null };
  return { variantId: null, modifierOptionId: null };
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
    lines.map((l) => ({
      key: l.id,
      variantId: l.variantId,
      modifierOptionId: l.modifierOptionId,
      ingredientId: l.ingredientId,
      quantity: String(l.quantity),
    })),
  );
  const [packaging, setPackaging] = useState(String(packagingCost));
  const [targetFood, setTargetFood] = useState(targetFoodCostPct === null ? "" : String(targetFoodCostPct));
  const [useOverride, setUseOverride] = useState(Boolean(override));
  const [overrideDraft, setOverrideDraft] = useState(() => toStrings(override ?? storeAllocation));

  const [ingredientQuery, setIngredientQuery] = useState("");
  const activeIngredients = useMemo(() => ingredients.filter((i) => i.isActive), [ingredients]);
  /** ตัวเลือกวัตถุดิบจัดกลุ่มตามหมวด ("ไม่ระบุหมวด" ไว้ท้าย) — ร้านที่มีวัตถุดิบเป็นร้อยหาง่ายขึ้น */
  const ingredientGroups = useMemo(() => {
    const q = ingredientQuery.trim().toLowerCase();
    const map = new Map<string, Ingredient[]>();
    for (const i of activeIngredients) {
      if (q && !i.name.toLowerCase().includes(q) && !(i.category ?? "").toLowerCase().includes(q)) continue;
      const key = i.category ?? "";
      const list = map.get(key);
      if (list) list.push(i);
      else map.set(key, [i]);
    }
    return [...map.entries()]
      .sort(([a], [b]) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b, "th")))
      .map(([key, items]) => ({ label: key || "ไม่ระบุหมวด", items: items.sort((a, b) => a.name.localeCompare(b.name, "th")) }));
  }, [activeIngredients, ingredientQuery]);
  const hasCategories = useMemo(() => activeIngredients.some((i) => i.category), [activeIngredients]);
  const matchCount = ingredientGroups.reduce((sum, g) => sum + g.items.length, 0);
  const previewLines: RecipeLine[] = draftLines
    .filter((l) => l.ingredientId && Number(l.quantity) > 0)
    .map((l) => ({
      id: l.key,
      productId: product.id,
      variantId: l.variantId,
      modifierOptionId: l.modifierOptionId,
      ingredientId: l.ingredientId,
      quantity: Number(l.quantity),
    }));
  const optionInfo = useMemo(() => {
    const map = new Map<string, { groupName: string; name: string; priceAdjustment: number }>();
    for (const group of product.modifierGroups) {
      for (const option of group.options) map.set(option.id, { groupName: group.name, name: option.name, priceAdjustment: option.priceAdjustment });
    }
    return map;
  }, [product.modifierGroups]);
  /** ตัวเลือกเสริมที่มีวัตถุดิบเพิ่ม — แสดงต้นทุนที่บวกขึ้นในกล่องสรุป */
  const optionPreview = [...new Set(previewLines.flatMap((l) => (l.modifierOptionId ? [l.modifierOptionId] : [])))].map((optionId) => {
    let extra = 0;
    for (const line of previewLines) {
      if (line.modifierOptionId !== optionId) continue;
      const ingredient = ingredientsById.get(line.ingredientId);
      if (ingredient) extra += line.quantity * ingredientUnitCost(ingredient);
    }
    const info = optionInfo.get(optionId);
    return { optionId, label: info ? `${info.groupName}: ${info.name}` : "ตัวเลือกที่ปิด/ลบแล้ว", priceAdjustment: info?.priceAdjustment ?? 0, extra };
  });
  const hasChoices = product.variants.length > 0 || product.modifierGroups.length > 0;
  const variantRows = [{ id: null as string | null, name: "ปกติ", price: product.basePrice }, ...product.variants.map((v) => ({ id: v.id as string | null, name: v.name, price: product.basePrice + v.priceAdjustment }))];

  function addLine() {
    // ค้นหาแล้วเหลือรายการเดียว → เลือกให้เลย; ไม่งั้นให้ผู้ใช้เลือกเอง (เดิมเติมตัวแรกของรายการ ทำให้ผูกผิดได้ง่าย)
    const only = matchCount === 1 ? ingredientGroups[0].items[0].id : "";
    setDraftLines((current) => [
      ...current,
      { key: `new-${Date.now()}-${current.length}`, variantId: null, modifierOptionId: null, ingredientId: only, quantity: "" },
    ]);
    // เลือกให้แล้ว → ล้างคำค้นเพื่อให้บรรทัดถัดไปเห็นรายการครบ
    if (only) setIngredientQuery("");
  }

  function saveRecipe() {
    const cleaned = draftLines.filter((l) => l.ingredientId && l.quantity.trim() !== "");
    run(
      () =>
        saveMenuCostingAction({
          productId: product.id,
          lines: cleaned.map((l) => ({
            variantId: l.variantId,
            modifierOptionId: l.modifierOptionId,
            ingredientId: l.ingredientId,
            quantity: Number(l.quantity),
          })),
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
        {product.modifierGroups.length > 0 && (
          <p className="text-xs text-[var(--muted)]">
            เลือก &quot;เพิ่มเมื่อเลือก …&quot; ในช่องใช้กับ เพื่อบวกวัตถุดิบเฉพาะตอนลูกค้าเลือกตัวเลือกนั้น เช่น เย็น = น้ำแข็ง, ปั่น = น้ำแข็ง + ผงปั่น
            (สูตรหลักควรเป็นแก้วร้อน/จานพื้นฐาน)
          </p>
        )}
        {activeIngredients.length > 15 && (
          <label className="block">
            <span className="sr-only">ค้นหาวัตถุดิบในรายการเลือก</span>
            <input
              type="search"
              className={inputClass}
              style={{ fontSize: 16 }}
              value={ingredientQuery}
              onChange={(e) => setIngredientQuery(e.target.value)}
              placeholder={hasCategories ? "ค้นหาวัตถุดิบหรือหมวด เพื่อย่อรายการให้เลือก" : "ค้นหาวัตถุดิบ เพื่อย่อรายการให้เลือก"}
            />
            {ingredientQuery.trim() !== "" && (
              <span className="mt-1 block text-xs text-[var(--muted)]" aria-live="polite">
                พบ {matchCount} รายการ{matchCount === 0 ? " — ลองคำอื่น" : ""}
              </span>
            )}
          </label>
        )}
        {draftLines.length === 0 && <p className="text-sm text-[var(--muted)]">ยังไม่มีวัตถุดิบในสูตร</p>}
        {draftLines.map((line, index) => {
          const ingredient = ingredientsById.get(line.ingredientId);
          // บรรทัดที่เลือกไว้แล้วต้องยังแสดงชื่อเดิมแม้ถูกกรองออกจากผลค้นหา
          const selectedHidden = ingredient && !ingredientGroups.some((g) => g.items.some((i) => i.id === ingredient.id));
          return (
            <div key={line.key} className="grid grid-cols-[minmax(0,1fr)_88px_auto] gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,0.8fr)_88px_auto]">
              <select
                aria-label="วัตถุดิบ"
                className={inputClass}
                value={line.ingredientId}
                onChange={(e) => setDraftLines((c) => c.map((l, i) => (i === index ? { ...l, ingredientId: e.target.value } : l)))}
              >
                <option value="">เลือกวัตถุดิบ</option>
                {selectedHidden && <option value={ingredient.id}>{ingredientOptionLabel(ingredient)}</option>}
                {hasCategories
                  ? ingredientGroups.map((group) => (
                      <optgroup key={group.label} label={group.label}>
                        {group.items.map((i) => (
                          <option key={i.id} value={i.id}>
                            {ingredientOptionLabel(i)}
                          </option>
                        ))}
                      </optgroup>
                    ))
                  : ingredientGroups.flatMap((group) => group.items).map((i) => (
                      <option key={i.id} value={i.id}>
                        {ingredientOptionLabel(i)}
                      </option>
                    ))}
              </select>
              <select
                aria-label="ใช้กับตัวเลือก"
                className={`${inputClass} col-span-3 sm:col-span-1`}
                value={scopeValue(line)}
                onChange={(e) => setDraftLines((c) => c.map((l, i) => (i === index ? { ...l, ...parseScope(e.target.value) } : l)))}
              >
                <option value="">{hasChoices ? "สูตรหลัก (ทุกแก้ว/ทุกจาน)" : "ทุกตัวเลือก"}</option>
                {product.variants.length > 0 && (
                  <optgroup label="ตัวเลือกสินค้า">
                    {product.variants.map((v) => (
                      <option key={v.id} value={`v:${v.id}`}>
                        เฉพาะ {v.name}
                      </option>
                    ))}
                  </optgroup>
                )}
                {product.modifierGroups.map((group) => (
                  <optgroup key={group.id} label={`เพิ่มเมื่อเลือก · ${group.name}`}>
                    {group.options.map((o) => (
                      <option key={o.id} value={`m:${o.id}`}>
                        + {o.name}
                      </option>
                    ))}
                  </optgroup>
                ))}
                {/* บรรทัดของตัวเลือกที่ถูกปิดไปแล้ว — คงไว้ไม่ให้หายตอนบันทึก */}
                {line.modifierOptionId && !optionInfo.has(line.modifierOptionId) && (
                  <option value={`m:${line.modifierOptionId}`}>+ ตัวเลือกที่ปิดอยู่</option>
                )}
                {line.variantId && !product.variants.some((v) => v.id === line.variantId) && (
                  <option value={`v:${line.variantId}`}>เฉพาะตัวเลือกที่ปิดอยู่</option>
                )}
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
          {optionPreview.length > 0 && (
            <div className="mt-2 border-t border-[var(--border)] pt-2">
              <p className="text-xs font-semibold text-[var(--muted)]">บวกเพิ่มเมื่อลูกค้าเลือก</p>
              {optionPreview.map((o) => (
                <p key={o.optionId} className="flex justify-between gap-2 tabular-nums">
                  <span>
                    {o.label}
                    {o.priceAdjustment ? ` (+${baht(o.priceAdjustment)} ฿)` : ""}
                  </span>
                  <span>+ ต้นทุน {baht(o.extra)}</span>
                </p>
              ))}
            </div>
          )}
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
