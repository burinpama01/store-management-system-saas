"use client";

import { useState, type FormEvent } from "react";
import { Button } from "@/shared/components/ui";
import type { StockPoolView } from "@/modules/stock/pool-repository";
import { adjustmentPreview } from "./AddStockDialog";

export function createInitialAdjustmentDraft() {
  return { mode: "receive" as const, quantity: "", reason: "" };
}

export function StockPoolAdjustmentForm({
  pool,
  pending,
  onSubmit,
}: {
  pool: StockPoolView;
  pending: boolean;
  onSubmit: (data: { mode: "receive" | "set_balance"; quantity: string; reason: string }) => Promise<void>;
}) {
  const initialDraft = createInitialAdjustmentDraft();
  const [mode, setMode] = useState<"receive" | "set_balance">(initialDraft.mode);
  const [quantity, setQuantity] = useState(initialDraft.quantity);
  const [reason, setReason] = useState(initialDraft.reason);
  const numericQuantity = /^\d+$/.test(quantity) ? Number(quantity) : 0;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await onSubmit({ mode, quantity, reason });
  }

  return (
    <form onSubmit={submit} className="space-y-4" aria-busy={pending}>
      <fieldset disabled={pending} className="space-y-4 disabled:opacity-60">
        <p className="rounded-md bg-slate-50 p-3 text-sm text-[var(--ink-2)]">
          Stock Pool <strong>{pool.name}</strong> คงเหลือ {pool.quantity} {pool.unitLabel}
        </p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className={`cursor-pointer rounded-lg border p-4 ${mode === "receive" ? "border-teal-700 bg-teal-50" : "border-[var(--border)]"}`}>
            <input className="sr-only" type="radio" name="mode" value="receive" checked={mode === "receive"} onChange={() => setMode("receive")} />
            <span className="font-semibold">รับเข้า</span>
            <span className="mt-1 block text-xs text-[var(--muted)]">เพิ่มจากยอดปัจจุบัน เช่น {adjustmentPreview(pool.quantity, "receive", 12)}</span>
          </label>
          <label className={`cursor-pointer rounded-lg border p-4 ${mode === "set_balance" ? "border-teal-700 bg-teal-50" : "border-[var(--border)]"}`}>
            <input className="sr-only" type="radio" name="mode" value="set_balance" checked={mode === "set_balance"} onChange={() => setMode("set_balance")} />
            <span className="font-semibold">กำหนดยอดใหม่</span>
            <span className="mt-1 block text-xs text-[var(--muted)]">แทนที่ยอดเดิมด้วยยอดที่นับได้จริง เช่น {adjustmentPreview(pool.quantity, "set_balance", 27)}</span>
          </label>
        </div>
        <label className="block text-sm font-medium text-[var(--ink)]">
          จำนวน ({pool.unitLabel})
          <input className="form-input mt-1 min-h-11 w-full" type="number" inputMode="numeric" min={mode === "receive" ? 1 : 0} step={1} value={quantity} onChange={(event) => setQuantity(event.target.value)} required />
          {quantity && <span className="mt-1 block text-xs text-[var(--muted)]">ตัวอย่างผลลัพธ์: {adjustmentPreview(pool.quantity, mode, numericQuantity)}</span>}
        </label>
        {mode === "set_balance" && (
          <label className="block text-sm font-medium text-[var(--ink)]">
            เหตุผลที่ตั้งยอดใหม่
            <input className="form-input mt-1 min-h-11 w-full" name="reason" value={reason} onChange={(event) => setReason(event.target.value)} required />
            <span className="mt-1 block text-xs text-[var(--muted)]">ต้องระบุเมื่อกำหนดยอดใหม่ เพื่อบันทึกเหตุผลของยอดตรวจนับ</span>
          </label>
        )}
      </fieldset>
      <Button type="submit" variant="primary" loading={pending} loadingText="กำลังบันทึก..." className="min-h-11 w-full sm:w-auto">บันทึกการปรับสต๊อก</Button>
    </form>
  );
}
