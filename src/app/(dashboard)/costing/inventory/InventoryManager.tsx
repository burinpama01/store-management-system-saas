"use client";

import { useMemo, useState, useTransition } from "react";
import { stockStatus, stockValue, toPurchaseUnits, toUsageUnits, unitCostFromPurchasePrice } from "@/modules/inventory/math";
import { MOVEMENT_LABELS, type InventoryItem, type InventoryMovement, type StockStatus, type Supplier } from "@/modules/inventory/types";
import { useConfirm } from "@/shared/components/ui/useConfirm";
import { money } from "../CostingChrome";
import {
  saveIngredientInventorySettingsAction,
  setIngredientBalanceAction,
  setInventoryEnabledAction,
} from "../inventory-actions";

const inputClass = "min-h-11 w-full rounded-lg border border-[var(--border)] bg-white px-3 text-[16px] text-[var(--ink)]";

const STATUS_LABEL: Record<StockStatus, { text: string; className: string }> = {
  unset: { text: "ยังไม่ตั้งยอด", className: "bg-slate-100 text-slate-700" },
  negative: { text: "ติดลบ", className: "bg-red-100 text-red-800" },
  out: { text: "หมด", className: "bg-red-50 text-red-700" },
  low: { text: "ใกล้หมด", className: "bg-amber-100 text-amber-900" },
  ok: { text: "ปกติ", className: "bg-green-50 text-green-800" },
};

function qtyLabel(value: number) {
  return new Intl.NumberFormat("th-TH", { maximumFractionDigits: 2 }).format(value);
}

type Editor =
  | { mode: "balance"; item: InventoryItem; unit: "purchase" | "usage"; qty: string; unitCost: string; reason: string }
  | { mode: "settings"; item: InventoryItem; reorderPoint: string; safetyDays: string; supplierId: string };

export function InventoryManager({
  items,
  suppliers,
  movements,
  enabled,
  canEdit,
  canConfigure,
  canToggle,
}: {
  items: InventoryItem[];
  suppliers: Supplier[];
  movements: InventoryMovement[];
  enabled: boolean;
  canEdit: boolean;
  canConfigure: boolean;
  canToggle: boolean;
}) {
  const [editor, setEditor] = useState<Editor | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [filter, setFilter] = useState<"all" | "attention">("all");
  const [isPending, startTransition] = useTransition();
  const { confirm, confirmDialog } = useConfirm();

  const activeItems = useMemo(() => items.filter((i) => i.isActive), [items]);
  const nameById = useMemo(() => new Map(items.map((i) => [i.ingredientId, i.name])), [items]);
  const totalValue = activeItems.reduce((sum, i) => sum + stockValue(i.onHand, i.avgUnitCost), 0);
  const attention = activeItems.filter((i) => ["negative", "out", "low"].includes(stockStatus(i.onHand, i.reorderPoint)));
  const unset = activeItems.filter((i) => i.onHand === null).length;
  const shown = filter === "attention" ? attention : activeItems;

  async function toggle(next: boolean) {
    if (!next) {
      const ok = await confirm({
        title: "ปิดคลังวัตถุดิบ?",
        message: "ยอดและประวัติยังอยู่ครบ แต่จะปรับยอดไม่ได้จนกว่าจะเปิดอีกครั้ง",
        confirmLabel: "ปิดคลัง",
        danger: true,
      });
      if (!ok) return;
    }
    startTransition(async () => {
      const result = await setInventoryEnabledAction(next);
      setMessage(result.error ? { tone: "error", text: result.error } : { tone: "ok", text: next ? "เปิดคลังวัตถุดิบแล้ว — เริ่มจากตั้งยอดยกมาของแต่ละวัตถุดิบ" : "ปิดคลังวัตถุดิบแล้ว" });
    });
  }

  function openBalance(item: InventoryItem) {
    setMessage(null);
    setEditor({
      mode: "balance",
      item,
      unit: "purchase",
      qty: item.onHand === null ? "" : String(toPurchaseUnits(Math.max(item.onHand, 0), item.usagePerPurchase)),
      unitCost: "",
      reason: "",
    });
  }

  function openSettings(item: InventoryItem) {
    setMessage(null);
    setEditor({
      mode: "settings",
      item,
      reorderPoint: item.reorderPoint === null ? "" : String(toPurchaseUnits(item.reorderPoint, item.usagePerPurchase)),
      safetyDays: String(item.safetyDays),
      supplierId: item.defaultSupplierId ?? "",
    });
  }

  function saveBalance() {
    if (!editor || editor.mode !== "balance") return;
    const { item } = editor;
    const qty = Number(editor.qty);
    if (editor.qty.trim() === "" || !Number.isFinite(qty) || qty < 0) {
      setMessage({ tone: "error", text: "กรอกยอดคงเหลือเป็นตัวเลขตั้งแต่ 0 ขึ้นไป" });
      return;
    }
    const newOnHand = editor.unit === "purchase" ? toUsageUnits(qty, item.usagePerPurchase) : qty;
    const isOpening = item.onHand === null;
    const costPerPurchase = editor.unitCost.trim() === "" ? null : Number(editor.unitCost);
    if (costPerPurchase !== null && (!Number.isFinite(costPerPurchase) || costPerPurchase < 0)) {
      setMessage({ tone: "error", text: "ราคาต่อหน่วยซื้อไม่ถูกต้อง" });
      return;
    }
    startTransition(async () => {
      const result = await setIngredientBalanceAction({
        ingredientId: item.ingredientId,
        kind: isOpening ? "opening" : "manual_adjust",
        newOnHand,
        reason: isOpening ? null : editor.reason,
        unitCost: isOpening && costPerPurchase !== null ? unitCostFromPurchasePrice(costPerPurchase, item.usagePerPurchase) : null,
      });
      if (result.error) {
        setMessage({ tone: "error", text: result.error });
        return;
      }
      setMessage({ tone: "ok", text: `บันทึกยอด ${item.name} แล้ว` });
      setEditor(null);
    });
  }

  function saveSettings() {
    if (!editor || editor.mode !== "settings") return;
    const { item } = editor;
    const reorder = editor.reorderPoint.trim() === "" ? null : Number(editor.reorderPoint);
    const safetyDays = Number(editor.safetyDays);
    if (reorder !== null && (!Number.isFinite(reorder) || reorder < 0)) {
      setMessage({ tone: "error", text: "จุดสั่งซื้อไม่ถูกต้อง" });
      return;
    }
    startTransition(async () => {
      const result = await saveIngredientInventorySettingsAction({
        ingredientId: item.ingredientId,
        reorderPoint: reorder === null ? null : toUsageUnits(reorder, item.usagePerPurchase),
        safetyDays: Number.isInteger(safetyDays) ? safetyDays : -1,
        defaultSupplierId: editor.supplierId || null,
      });
      if (result.error) {
        setMessage({ tone: "error", text: result.error });
        return;
      }
      setMessage({ tone: "ok", text: `บันทึกการตั้งค่า ${item.name} แล้ว` });
      setEditor(null);
    });
  }

  return (
    <div className="space-y-4">
      {confirmDialog}

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
        <div>
          <p className="text-sm font-semibold text-[var(--ink)]">
            คลังวัตถุดิบของสาขานี้: {enabled ? <span className="text-green-700">เปิดอยู่</span> : <span className="text-[var(--muted)]">ปิดอยู่</span>}
          </p>
          <p className="mt-1 text-xs text-[var(--muted)]">
            {enabled
              ? "ตอนนี้ปรับยอดด้วยมือได้ · รับของจากบิลซื้อ ตัดตามสูตรเมื่อขาย และนับสต็อก จะตามมาในรอบถัดไป"
              : "เปิดเมื่อพร้อมตั้งยอดยกมา — ยังไม่กระทบการขายหรือต้นทุนเมนู"}
          </p>
        </div>
        {canToggle && (
          <button type="button" disabled={isPending} className={enabled ? "btn-secondary min-h-11" : "btn-primary min-h-11"} onClick={() => void toggle(!enabled)}>
            {enabled ? "ปิดคลัง" : "เปิดคลังวัตถุดิบ"}
          </button>
        )}
      </div>

      {message && (
        <p role="status" className={`rounded-lg px-3 py-2 text-sm ${message.tone === "ok" ? "bg-green-50 text-green-800" : "bg-red-50 text-red-700"}`}>
          {message.text}
        </p>
      )}

      {enabled && (
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
            <p className="text-xs text-[var(--muted)]">มูลค่าคงคลัง (ต้นทุนเฉลี่ย)</p>
            <p className="mt-1 text-xl font-bold text-[var(--ink)]">฿{money(totalValue)}</p>
          </div>
          <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
            <p className="text-xs text-[var(--muted)]">ต้องดู (หมด/ใกล้หมด/ติดลบ)</p>
            <p className="mt-1 text-xl font-bold text-[var(--ink)]">{attention.length} รายการ</p>
          </div>
          <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
            <p className="text-xs text-[var(--muted)]">ยังไม่ตั้งยอดยกมา</p>
            <p className="mt-1 text-xl font-bold text-[var(--ink)]">{unset} รายการ</p>
          </div>
        </div>
      )}

      {editor && (
        <div className="space-y-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
          {editor.mode === "balance" ? (
            <>
              <h2 className="text-base font-semibold text-[var(--ink)]">
                {editor.item.onHand === null ? "ตั้งยอดยกมา" : "ปรับยอด"} · {editor.item.name}
              </h2>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block text-sm">
                  <span className="text-[var(--muted)]">ยอดคงเหลือตอนนี้</span>
                  <input className={inputClass} inputMode="decimal" value={editor.qty} onChange={(e) => setEditor({ ...editor, qty: e.target.value })} />
                </label>
                <label className="block text-sm">
                  <span className="text-[var(--muted)]">หน่วย</span>
                  <select className={inputClass} value={editor.unit} onChange={(e) => setEditor({ ...editor, unit: e.target.value as "purchase" | "usage" })}>
                    <option value="purchase">{editor.item.purchaseUnit} (หน่วยซื้อ)</option>
                    <option value="usage">{editor.item.usageUnit} (หน่วยในสูตร)</option>
                  </select>
                </label>
                {editor.item.onHand === null ? (
                  <label className="block text-sm sm:col-span-2">
                    <span className="text-[var(--muted)]">
                      ราคาต่อ {editor.item.purchaseUnit} (เว้นว่าง = ใช้ราคาซื้อปัจจุบัน ฿{money(editor.item.purchasePrice)})
                    </span>
                    <input className={inputClass} inputMode="decimal" value={editor.unitCost} onChange={(e) => setEditor({ ...editor, unitCost: e.target.value })} />
                  </label>
                ) : (
                  <label className="block text-sm sm:col-span-2">
                    <span className="text-[var(--muted)]">เหตุผลที่ปรับ (บังคับ)</span>
                    <input className={inputClass} maxLength={300} value={editor.reason} onChange={(e) => setEditor({ ...editor, reason: e.target.value })} placeholder="เช่น นับจริงไม่ตรง, ของเสียที่ไม่ได้บันทึก" />
                  </label>
                )}
              </div>
              <div className="flex gap-2">
                <button type="button" className="btn-primary min-h-11" disabled={isPending} onClick={saveBalance}>บันทึก</button>
                <button type="button" className="btn-secondary min-h-11" disabled={isPending} onClick={() => setEditor(null)}>ยกเลิก</button>
              </div>
            </>
          ) : (
            <>
              <h2 className="text-base font-semibold text-[var(--ink)]">ตั้งค่าคลัง · {editor.item.name}</h2>
              <div className="grid gap-3 sm:grid-cols-3">
                <label className="block text-sm">
                  <span className="text-[var(--muted)]">จุดสั่งซื้อ ({editor.item.purchaseUnit})</span>
                  <input className={inputClass} inputMode="decimal" value={editor.reorderPoint} onChange={(e) => setEditor({ ...editor, reorderPoint: e.target.value })} placeholder="เว้นว่าง = ไม่เตือน" />
                </label>
                <label className="block text-sm">
                  <span className="text-[var(--muted)]">วันสำรอง</span>
                  <input className={inputClass} inputMode="numeric" value={editor.safetyDays} onChange={(e) => setEditor({ ...editor, safetyDays: e.target.value })} />
                </label>
                <label className="block text-sm">
                  <span className="text-[var(--muted)]">ผู้ขายประจำ</span>
                  <select className={inputClass} value={editor.supplierId} onChange={(e) => setEditor({ ...editor, supplierId: e.target.value })}>
                    <option value="">— ไม่ระบุ —</option>
                    {suppliers.map((s) => (
                      <option key={s.id} value={s.id}>{s.name}</option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="flex gap-2">
                <button type="button" className="btn-primary min-h-11" disabled={isPending} onClick={saveSettings}>บันทึก</button>
                <button type="button" className="btn-secondary min-h-11" disabled={isPending} onClick={() => setEditor(null)}>ยกเลิก</button>
              </div>
            </>
          )}
        </div>
      )}

      {activeItems.length === 0 ? (
        <p className="rounded-xl border border-dashed border-[var(--border)] p-6 text-center text-sm text-[var(--muted)]">
          ยังไม่มีวัตถุดิบ — เพิ่มได้ที่แท็บ “วัตถุดิบ”
        </p>
      ) : (
        <>
          {enabled && (
            <div className="flex gap-2">
              {(["all", "attention"] as const).map((key) => (
                <button
                  key={key}
                  type="button"
                  aria-pressed={filter === key}
                  onClick={() => setFilter(key)}
                  className={`min-h-10 rounded-full border px-4 text-sm font-semibold ${filter === key ? "border-[var(--tenant-primary)] bg-[var(--tenant-primary)] text-white" : "border-[var(--border)] bg-[var(--surface)] text-[var(--ink)]"}`}
                >
                  {key === "all" ? `ทั้งหมด (${activeItems.length})` : `ต้องดู (${attention.length})`}
                </button>
              ))}
            </div>
          )}
          <ul className="divide-y divide-[var(--border)] overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)]">
            {shown.map((item) => {
              const status = stockStatus(item.onHand, item.reorderPoint);
              const badge = STATUS_LABEL[status];
              return (
                <li key={item.ingredientId} className="flex flex-wrap items-center justify-between gap-3 p-3">
                  <div className="min-w-0">
                    <p className="font-semibold text-[var(--ink)]">
                      {item.name} <span className={`ml-1 rounded-full px-2 py-0.5 text-xs font-semibold ${badge.className}`}>{badge.text}</span>
                    </p>
                    <p className="mt-0.5 text-xs text-[var(--muted)]">
                      {item.onHand === null
                        ? `หน่วยซื้อ ${item.purchaseUnit} = ${qtyLabel(item.usagePerPurchase)} ${item.usageUnit}`
                        : `คงเหลือ ${qtyLabel(toPurchaseUnits(item.onHand, item.usagePerPurchase))} ${item.purchaseUnit} (${qtyLabel(item.onHand)} ${item.usageUnit}) · มูลค่า ฿${money(stockValue(item.onHand, item.avgUnitCost))}`}
                      {item.reorderPoint !== null && ` · สั่งเมื่อเหลือ ${qtyLabel(toPurchaseUnits(item.reorderPoint, item.usagePerPurchase))} ${item.purchaseUnit}`}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    {canEdit && (
                      <button type="button" className="btn-secondary min-h-10 text-sm" disabled={isPending} onClick={() => openBalance(item)}>
                        {item.onHand === null ? "ตั้งยอดยกมา" : "ปรับยอด"}
                      </button>
                    )}
                    {canConfigure && (
                      <button type="button" className="btn-secondary min-h-10 text-sm" disabled={isPending} onClick={() => openSettings(item)}>
                        ตั้งค่า
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}

      {enabled && movements.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-base font-semibold text-[var(--ink)]">ความเคลื่อนไหวล่าสุด</h2>
          <ul className="divide-y divide-[var(--border)] rounded-xl border border-[var(--border)] bg-[var(--surface)] text-sm">
            {movements.map((m) => (
              <li key={m.id} className="flex flex-wrap justify-between gap-2 p-3">
                <span>
                  <span className="font-semibold text-[var(--ink)]">{nameById.get(m.ingredientId) ?? "วัตถุดิบ"}</span> · {MOVEMENT_LABELS[m.movementType]}
                  {m.reason ? <span className="text-[var(--muted)]"> · {m.reason}</span> : null}
                </span>
                <span className="text-[var(--muted)]">
                  {m.qtyDelta >= 0 ? "+" : ""}{qtyLabel(m.qtyDelta)} → {qtyLabel(m.afterQty)} · {new Date(m.createdAt).toLocaleString("th-TH", { dateStyle: "short", timeStyle: "short" })}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
