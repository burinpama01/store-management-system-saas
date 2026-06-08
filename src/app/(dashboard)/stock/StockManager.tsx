"use client";

import { useActionState } from "react";
import type { Product } from "@/modules/catalog/types";
import { setStockAction, type StockState } from "./actions";

const INITIAL: StockState = { error: null, ok: false };
const LOW = 5;

export function StockManager({ products, canManage }: { products: Product[]; canManage: boolean }) {
  const rows = products.flatMap((p) =>
    p.variants
      .filter((v) => v.isActive)
      .map((v) => ({ productName: p.name, variant: v })),
  );

  return (
    <div className="page-shell">
      <div className="page-header">
        <div>
          <h1 className="page-title">สต็อกสินค้า</h1>
          <p className="page-kicker">ตั้ง/ปรับจำนวนคงเหลือของแต่ละตัวเลือกสินค้า · สีแดง = หมด, เหลือง = ใกล้หมด</p>
        </div>
      </div>

      <section className="panel overflow-x-auto p-0">
        {rows.length === 0 ? (
          <p className="p-6 text-sm text-[var(--muted)]">ยังไม่มีตัวเลือกสินค้า — เพิ่มที่เมนูสินค้าก่อน</p>
        ) : (
          <table className="min-w-[720px] w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--border)] text-left text-xs text-[var(--muted)]">
                <th className="px-4 py-3 font-bold">สินค้า</th>
                <th className="px-4 py-3 font-bold">ตัวเลือก</th>
                <th className="px-4 py-3 font-bold">ติดตามสต็อก</th>
                <th className="px-4 py-3 text-right font-bold">คงเหลือ</th>
                {canManage && <th className="px-4 py-3 font-bold">ปรับจำนวน</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map(({ productName, variant }) => {
                const qty = typeof variant.stockQuantity === "number" ? variant.stockQuantity : null;
                const tone =
                  variant.trackStock && qty != null
                    ? qty <= 0
                      ? "text-red-600"
                      : qty <= LOW
                        ? "text-amber-600"
                        : "text-[var(--ink)]"
                    : "text-[var(--muted)]";
                return (
                  <tr key={variant.id} className="border-b border-[var(--border)] last:border-0">
                    <td className="px-4 py-2 font-bold text-[var(--ink)]">{productName}</td>
                    <td className="px-4 py-2 text-[var(--ink-2)]">{variant.name}</td>
                    <td className="px-4 py-2">
                      <span className={`badge ${variant.trackStock ? "badge-success" : "badge-warning"}`}>
                        {variant.trackStock ? "เปิด" : "ปิด"}
                      </span>
                    </td>
                    <td className={`px-4 py-2 text-right font-mono ${tone}`}>
                      {variant.trackStock && qty != null ? qty : "—"}
                    </td>
                    {canManage && (
                      <td className="px-4 py-2">
                        <StockRow variantId={variant.id} current={qty ?? 0} />
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

function StockRow({ variantId, current }: { variantId: string; current: number }) {
  const [state, action, pending] = useActionState(setStockAction, INITIAL);
  return (
    <form action={action} className="flex items-center gap-2">
      <input type="hidden" name="variantId" value={variantId} />
      <input
        type="number"
        name="quantity"
        defaultValue={current}
        min={0}
        step={1}
        className="form-input w-24 tabular-nums"
      />
      <button type="submit" disabled={pending} className="btn-secondary text-xs disabled:opacity-40">
        {pending ? "..." : "บันทึก"}
      </button>
      {state.error && <span className="text-xs text-red-600">{state.error}</span>}
      {state.ok && <span className="text-xs text-emerald-700">✓</span>}
    </form>
  );
}
