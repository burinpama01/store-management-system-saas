"use client";

import { useEffect, useId, useMemo, useRef, useState, useTransition } from "react";
import { ingredientUnitCost } from "@/modules/costing/math";
import type { Ingredient } from "@/modules/costing/types";
import { useConfirm } from "@/shared/components/ui/useConfirm";
import { deleteIngredientAction, saveIngredientAction } from "../actions";

interface Draft {
  id: string | null;
  name: string;
  category: string;
  purchaseUnit: string;
  usageUnit: string;
  usagePerPurchase: string;
  purchasePrice: string;
  yieldPct: string;
}

type StatusFilter = "all" | "no_price" | "unused" | "used";

/** ค่า filter หมวดพิเศษ */
const ALL = "__all__";
const NO_CATEGORY = "__none__";
const NO_CATEGORY_LABEL = "ไม่ระบุหมวด";

/** หมวดแนะนำในช่องกรอก — รวมกับหมวดที่ร้านใช้อยู่แล้ว */
const SUGGESTED_CATEGORIES = [
  "วัตถุดิบเครื่องดื่ม",
  "ไซรัป / ซอส",
  "นม / ครีม",
  "ผลไม้",
  "ผักสด",
  "เนื้อสัตว์ / ซีฟู้ด",
  "ของแห้ง / เครื่องปรุง",
  "ของแช่แข็ง",
  "เบเกอรี่ / ของหวาน",
  "บรรจุภัณฑ์",
];

const STATUS_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "ทุกสถานะ" },
  { value: "no_price", label: "ยังไม่ใส่ราคา" },
  { value: "unused", label: "ยังไม่อยู่ในสูตร" },
  { value: "used", label: "อยู่ในสูตรแล้ว" },
];

const EMPTY: Draft = {
  id: null,
  name: "",
  category: "",
  purchaseUnit: "กก.",
  usageUnit: "กรัม",
  usagePerPurchase: "1000",
  purchasePrice: "",
  yieldPct: "100",
};

function toDraft(i: Ingredient): Draft {
  return {
    id: i.id,
    name: i.name,
    category: i.category ?? "",
    purchaseUnit: i.purchaseUnit,
    usageUnit: i.usageUnit,
    usagePerPurchase: String(i.usagePerPurchase),
    purchasePrice: String(i.purchasePrice),
    yieldPct: String(i.yieldPct),
  };
}

function unitCostLabel(value: number) {
  if (value === 0) return "0";
  return value < 1 ? value.toFixed(4) : value.toFixed(2);
}

const byThai = (a: string, b: string) => a.localeCompare(b, "th");

const inputClass = "min-h-11 w-full rounded-lg border border-[var(--border)] bg-white px-3 text-[var(--ink)]";
// 16px กัน iOS ซูมตอนแตะช่องค้นหา
const fieldStyle = { fontSize: 16 } as const;

export function IngredientsManager({
  ingredients,
  usageCount,
  canEdit,
}: {
  ingredients: Ingredient[];
  usageCount: Record<string, number>;
  canEdit: boolean;
}) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [query, setQuery] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<string>(ALL);
  const [status, setStatus] = useState<StatusFilter>("all");
  const [isPending, startTransition] = useTransition();
  const { confirm, confirmDialog } = useConfirm();
  const formRef = useRef<HTMLDivElement>(null);
  const categoryListId = useId();

  const draftKey = draft ? draft.id ?? "new" : null;
  useEffect(() => {
    // รายการยาว — กดแก้จากท้ายตารางแล้วต้องเห็นฟอร์มทันที
    if (draftKey) formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [draftKey]);

  const categories = useMemo(() => {
    const counts = new Map<string, number>();
    let uncategorized = 0;
    for (const i of ingredients) {
      if (i.category) counts.set(i.category, (counts.get(i.category) ?? 0) + 1);
      else uncategorized += 1;
    }
    return {
      list: [...counts.entries()].sort(([a], [b]) => byThai(a, b)).map(([name, count]) => ({ name, count })),
      uncategorized,
    };
  }, [ingredients]);

  const categorySuggestions = useMemo(
    () => [...new Set([...categories.list.map((c) => c.name), ...SUGGESTED_CATEGORIES])],
    [categories.list],
  );

  const noPriceCount = useMemo(() => ingredients.filter((i) => i.purchasePrice === 0).length, [ingredients]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return ingredients.filter((i) => {
      // ALL = ไม่กรองหมวด; NO_CATEGORY = เฉพาะที่ยังไม่มีหมวด; อื่น ๆ = ชื่อหมวดต้องตรงกัน
      if (categoryFilter === NO_CATEGORY && i.category) return false;
      if (categoryFilter !== ALL && categoryFilter !== NO_CATEGORY && i.category !== categoryFilter) return false;
      const used = (usageCount[i.id] ?? 0) > 0;
      if (status === "no_price" && i.purchasePrice !== 0) return false;
      if (status === "unused" && used) return false;
      if (status === "used" && !used) return false;
      if (q && !i.name.toLowerCase().includes(q) && !(i.category ?? "").toLowerCase().includes(q)) return false;
      return true;
    });
  }, [ingredients, usageCount, query, categoryFilter, status]);

  /** จัดกลุ่มตามหมวด — หมวดเรียงตามตัวอักษร, "ไม่ระบุหมวด" ไว้ท้าย */
  const groups = useMemo(() => {
    const map = new Map<string, Ingredient[]>();
    for (const i of filtered) {
      const key = i.category ?? NO_CATEGORY;
      const list = map.get(key);
      if (list) list.push(i);
      else map.set(key, [i]);
    }
    return [...map.entries()]
      .sort(([a], [b]) => (a === NO_CATEGORY ? 1 : b === NO_CATEGORY ? -1 : byThai(a, b)))
      .map(([key, items]) => ({
        key,
        label: key === NO_CATEGORY ? NO_CATEGORY_LABEL : key,
        items: items.sort((a, b) => byThai(a.name, b.name)),
      }));
  }, [filtered]);

  const hasFilter = query.trim() !== "" || categoryFilter !== ALL || status !== "all";
  const showGroupHeaders = categories.list.length > 0;

  function clearFilters() {
    setQuery("");
    setCategoryFilter(ALL);
    setStatus("all");
  }

  const preview = draft
    ? ingredientUnitCost({
        purchasePrice: Number(draft.purchasePrice) || 0,
        usagePerPurchase: Number(draft.usagePerPurchase) || 0,
        yieldPct: Number(draft.yieldPct) || 0,
      })
    : 0;

  function save() {
    if (!draft) return;
    startTransition(async () => {
      const result = await saveIngredientAction({
        id: draft.id,
        name: draft.name,
        category: draft.category,
        purchaseUnit: draft.purchaseUnit,
        usageUnit: draft.usageUnit,
        usagePerPurchase: Number(draft.usagePerPurchase),
        purchasePrice: Number(draft.purchasePrice),
        yieldPct: Number(draft.yieldPct),
      });
      if (result.error) {
        setMessage({ tone: "error", text: result.error });
        return;
      }
      setMessage({ tone: "ok", text: `บันทึก ${draft.name.trim()} แล้ว — ต้นทุนเมนูที่ใช้วัตถุดิบนี้อัปเดตทันที` });
      setDraft(null);
    });
  }

  async function remove(ingredient: Ingredient) {
    const ok = await confirm({
      title: `ลบ ${ingredient.name}?`,
      message: "ลบได้เฉพาะวัตถุดิบที่ไม่อยู่ในสูตรเมนูใด",
      confirmLabel: "ลบ",
      danger: true,
    });
    if (!ok) return;
    startTransition(async () => {
      const result = await deleteIngredientAction(ingredient.id);
      setMessage(result.error ? { tone: "error", text: result.error } : { tone: "ok", text: `ลบ ${ingredient.name} แล้ว` });
    });
  }

  function chipClass(active: boolean) {
    return `inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-full border px-3 text-sm font-medium transition-colors ${
      active
        ? "border-[var(--tenant-primary)] bg-[var(--tenant-primary)] text-white"
        : "border-[var(--border)] bg-white text-[var(--ink)] hover:bg-[var(--surface-muted)]"
    }`;
  }

  const colCount = canEdit ? 6 : 5;

  return (
    <div className="space-y-4">
      {confirmDialog}
      {message && (
        <p
          role="status"
          className={`rounded-lg px-3 py-2 text-sm ${message.tone === "ok" ? "bg-green-50 text-green-800" : "bg-red-50 text-red-700"}`}
        >
          {message.text}
        </p>
      )}

      {canEdit && !draft && (
        <button type="button" className="btn-primary min-h-11" onClick={() => {
          setMessage(null);
          // กรองหมวดไว้อยู่ → เติมหมวดนั้นให้เลย
          setDraft({ ...EMPTY, category: categoryFilter !== ALL && categoryFilter !== NO_CATEGORY ? categoryFilter : "" });
        }}>
          + เพิ่มวัตถุดิบ
        </button>
      )}

      {draft && (
        <div ref={formRef} className="scroll-mt-4 space-y-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <h2 className="text-base font-semibold text-[var(--ink)]">{draft.id ? "แก้วัตถุดิบ" : "เพิ่มวัตถุดิบ"}</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1 text-sm">
              <span className="text-[var(--muted)]">ชื่อวัตถุดิบ</span>
              <input className={inputClass} value={draft.name} maxLength={80} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="เช่น อกไก่" />
            </label>
            <label className="space-y-1 text-sm">
              <span className="text-[var(--muted)]">หมวด (ไม่บังคับ)</span>
              <input
                className={inputClass}
                style={fieldStyle}
                list={categoryListId}
                value={draft.category}
                maxLength={40}
                onChange={(e) => setDraft({ ...draft, category: e.target.value })}
                placeholder="เช่น ผักสด / บรรจุภัณฑ์"
              />
              <datalist id={categoryListId}>
                {categorySuggestions.map((c) => (
                  <option key={c} value={c} />
                ))}
              </datalist>
            </label>
            <label className="space-y-1 text-sm">
              <span className="text-[var(--muted)]">ราคาซื้อ (บาท)</span>
              <input className={inputClass} inputMode="decimal" value={draft.purchasePrice} onChange={(e) => setDraft({ ...draft, purchasePrice: e.target.value })} placeholder="95" />
            </label>
            <label className="space-y-1 text-sm">
              <span className="text-[var(--muted)]">ซื้อเป็นหน่วย</span>
              <input className={inputClass} value={draft.purchaseUnit} maxLength={20} onChange={(e) => setDraft({ ...draft, purchaseUnit: e.target.value })} placeholder="กก. / แพ็ค / ขวด" />
            </label>
            <label className="space-y-1 text-sm">
              <span className="text-[var(--muted)]">1 {draft.purchaseUnit || "หน่วยซื้อ"} ใช้ได้กี่ {draft.usageUnit || "หน่วยใช้"}</span>
              <input className={inputClass} inputMode="decimal" value={draft.usagePerPurchase} onChange={(e) => setDraft({ ...draft, usagePerPurchase: e.target.value })} placeholder="1000" />
            </label>
            <label className="space-y-1 text-sm">
              <span className="text-[var(--muted)]">หน่วยที่ใช้ในสูตร</span>
              <input className={inputClass} value={draft.usageUnit} maxLength={20} onChange={(e) => setDraft({ ...draft, usageUnit: e.target.value })} placeholder="กรัม / ชิ้น / มล." />
            </label>
            <label className="space-y-1 text-sm">
              <span className="text-[var(--muted)]">ใช้ได้จริง (%) — หักส่วนที่ตัดทิ้ง</span>
              <input className={inputClass} inputMode="decimal" value={draft.yieldPct} onChange={(e) => setDraft({ ...draft, yieldPct: e.target.value })} placeholder="80" />
            </label>
          </div>
          <p className="rounded-lg bg-[var(--surface-muted)] px-3 py-2 text-sm text-[var(--ink)]">
            ต้นทุนจริง <strong className="tabular-nums">{unitCostLabel(preview)}</strong> บาท / {draft.usageUnit || "หน่วย"}
          </p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn-primary min-h-11" disabled={isPending} onClick={save}>
              บันทึก
            </button>
            <button type="button" className="btn-secondary min-h-11" disabled={isPending} onClick={() => setDraft(null)}>
              ยกเลิก
            </button>
          </div>
        </div>
      )}

      {ingredients.length === 0 ? (
        <p className="rounded-xl border border-dashed border-[var(--border)] p-6 text-center text-sm text-[var(--muted)]">
          ยังไม่มีวัตถุดิบ — เพิ่มวัตถุดิบก่อน แล้วไปผูกสูตรที่หน้า &quot;ต้นทุนเมนู&quot;
        </p>
      ) : (
        <>
          <div className="space-y-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3">
            <div className="flex flex-col gap-2 sm:flex-row">
              <label className="relative flex-1">
                <span className="sr-only">ค้นหาวัตถุดิบ</span>
                <svg aria-hidden="true" viewBox="0 0 20 20" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--muted)]" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="9" cy="9" r="6" />
                  <path d="m14 14 4 4" strokeLinecap="round" />
                </svg>
                <input
                  type="search"
                  className={`${inputClass} pl-9`}
                  style={fieldStyle}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="ค้นหาชื่อวัตถุดิบหรือหมวด"
                />
              </label>
              <label className="sm:w-52">
                <span className="sr-only">กรองตามสถานะ</span>
                <select className={inputClass} style={fieldStyle} value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)}>
                  {STATUS_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                      {o.value === "no_price" && noPriceCount > 0 ? ` (${noPriceCount})` : ""}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            {showGroupHeaders && (
              <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1" role="group" aria-label="กรองตามหมวด">
                <button type="button" className={chipClass(categoryFilter === ALL)} aria-pressed={categoryFilter === ALL} onClick={() => setCategoryFilter(ALL)}>
                  ทั้งหมด <span className="tabular-nums opacity-75">{ingredients.length}</span>
                </button>
                {categories.list.map((c) => (
                  <button
                    key={c.name}
                    type="button"
                    className={chipClass(categoryFilter === c.name)}
                    aria-pressed={categoryFilter === c.name}
                    onClick={() => setCategoryFilter(categoryFilter === c.name ? ALL : c.name)}
                  >
                    {c.name} <span className="tabular-nums opacity-75">{c.count}</span>
                  </button>
                ))}
                {categories.uncategorized > 0 && (
                  <button
                    type="button"
                    className={chipClass(categoryFilter === NO_CATEGORY)}
                    aria-pressed={categoryFilter === NO_CATEGORY}
                    onClick={() => setCategoryFilter(categoryFilter === NO_CATEGORY ? ALL : NO_CATEGORY)}
                  >
                    {NO_CATEGORY_LABEL} <span className="tabular-nums opacity-75">{categories.uncategorized}</span>
                  </button>
                )}
              </div>
            )}

            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-[var(--muted)]">
              <span aria-live="polite">
                แสดง <strong className="tabular-nums text-[var(--ink)]">{filtered.length}</strong> จาก {ingredients.length} รายการ
              </span>
              {noPriceCount > 0 && status !== "no_price" && (
                <button type="button" className="min-h-9 font-semibold text-amber-700 underline-offset-2 hover:underline" onClick={() => setStatus("no_price")}>
                  ยังไม่ใส่ราคา {noPriceCount} รายการ (ทั้งร้าน)
                </button>
              )}
              {hasFilter && (
                <button type="button" className="min-h-9 font-semibold text-[var(--tenant-primary)] underline-offset-2 hover:underline" onClick={clearFilters}>
                  ล้างตัวกรอง
                </button>
              )}
            </div>
          </div>

          {filtered.length === 0 ? (
            <div className="rounded-xl border border-dashed border-[var(--border)] p-6 text-center text-sm text-[var(--muted)]">
              <p>ไม่พบวัตถุดิบตามเงื่อนไขนี้</p>
              <button type="button" className="btn-secondary mt-3 min-h-11" onClick={clearFilters}>
                ล้างตัวกรอง
              </button>
            </div>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-[var(--border)] bg-[var(--surface)]">
              <table className="w-full min-w-[640px] text-sm">
                <thead className="bg-[var(--surface-muted)] text-left text-[var(--muted)]">
                  <tr>
                    <th className="px-3 py-2">วัตถุดิบ</th>
                    <th className="px-3 py-2 text-right">ราคาซื้อ</th>
                    <th className="px-3 py-2 text-right">ใช้ได้จริง</th>
                    <th className="px-3 py-2 text-right">ต้นทุน/หน่วยใช้</th>
                    <th className="px-3 py-2 text-right">ในสูตร</th>
                    {canEdit && <th className="px-3 py-2" aria-label="จัดการ" />}
                  </tr>
                </thead>
                {groups.map((group) => (
                  <tbody key={group.key}>
                    {showGroupHeaders && (
                      <tr className="border-t border-[var(--border)] bg-[var(--surface-muted)]/60">
                        <th colSpan={colCount} scope="rowgroup" className="px-3 py-1.5 text-left text-xs font-semibold tracking-wide text-[var(--muted)]">
                          {group.label} <span className="tabular-nums font-normal">· {group.items.length}</span>
                        </th>
                      </tr>
                    )}
                    {group.items.map((ingredient) => {
                      const noPrice = ingredient.purchasePrice === 0;
                      return (
                        <tr key={ingredient.id} className="border-t border-[var(--border)]">
                          <td className="px-3 py-2 font-medium text-[var(--ink)]">{ingredient.name}</td>
                          <td className="px-3 py-2 text-right tabular-nums">
                            {noPrice ? (
                              <span className="inline-flex items-center rounded-full bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-800">
                                ยังไม่ใส่ราคา
                              </span>
                            ) : (
                              <>
                                {ingredient.purchasePrice.toFixed(2)} / {ingredient.purchaseUnit}
                              </>
                            )}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums">
                            {ingredient.usagePerPurchase} {ingredient.usageUnit} · {ingredient.yieldPct}%
                          </td>
                          <td className="px-3 py-2 text-right font-semibold tabular-nums">
                            {noPrice ? <span className="font-normal text-[var(--muted)]">—</span> : <>{unitCostLabel(ingredientUnitCost(ingredient))} / {ingredient.usageUnit}</>}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums">{usageCount[ingredient.id] ?? 0} เมนู</td>
                          {canEdit && (
                            <td className="px-3 py-2 text-right whitespace-nowrap">
                              <button type="button" className="min-h-9 px-2 text-sm font-semibold text-[var(--tenant-primary)]" onClick={() => {
                                  setMessage(null);
                                  setDraft(toDraft(ingredient));
                                }}>
                                แก้
                              </button>
                              <button type="button" className="min-h-9 px-2 text-sm font-semibold text-red-600" onClick={() => void remove(ingredient)}>
                                ลบ
                              </button>
                            </td>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                ))}
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
