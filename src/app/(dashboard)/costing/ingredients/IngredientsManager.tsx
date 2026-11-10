"use client";

import { useState, useTransition } from "react";
import { ingredientUnitCost } from "@/modules/costing/math";
import type { Ingredient } from "@/modules/costing/types";
import { useConfirm } from "@/shared/components/ui/useConfirm";
import { deleteIngredientAction, saveIngredientAction } from "../actions";

interface Draft {
  id: string | null;
  name: string;
  purchaseUnit: string;
  usageUnit: string;
  usagePerPurchase: string;
  purchasePrice: string;
  yieldPct: string;
}

const EMPTY: Draft = { id: null, name: "", purchaseUnit: "กก.", usageUnit: "กรัม", usagePerPurchase: "1000", purchasePrice: "", yieldPct: "100" };

function toDraft(i: Ingredient): Draft {
  return {
    id: i.id,
    name: i.name,
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

const inputClass = "min-h-11 w-full rounded-lg border border-[var(--border)] bg-white px-3 text-[var(--ink)]";

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
  const [isPending, startTransition] = useTransition();
  const { confirm, confirmDialog } = useConfirm();

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
          setDraft(EMPTY);
        }}>
          + เพิ่มวัตถุดิบ
        </button>
      )}

      {draft && (
        <div className="space-y-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <h2 className="text-base font-semibold text-[var(--ink)]">{draft.id ? "แก้วัตถุดิบ" : "เพิ่มวัตถุดิบ"}</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1 text-sm sm:col-span-2">
              <span className="text-[var(--muted)]">ชื่อวัตถุดิบ</span>
              <input className={inputClass} value={draft.name} maxLength={80} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="เช่น อกไก่" />
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
        <div className="overflow-x-auto rounded-xl border border-[var(--border)] bg-[var(--surface)]">
          <table className="w-full text-sm">
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
            <tbody>
              {ingredients.map((ingredient) => (
                <tr key={ingredient.id} className="border-t border-[var(--border)]">
                  <td className="px-3 py-2 font-medium text-[var(--ink)]">{ingredient.name}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {ingredient.purchasePrice.toFixed(2)} / {ingredient.purchaseUnit}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {ingredient.usagePerPurchase} {ingredient.usageUnit} · {ingredient.yieldPct}%
                  </td>
                  <td className="px-3 py-2 text-right font-semibold tabular-nums">
                    {unitCostLabel(ingredientUnitCost(ingredient))} / {ingredient.usageUnit}
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
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
