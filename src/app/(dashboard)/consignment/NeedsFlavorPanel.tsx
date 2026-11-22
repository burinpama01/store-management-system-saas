"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { NeedsFlavorRow, ResaleProduct } from "@/modules/consignment/types";
import { assignFlavorAction } from "./operations-actions";
import { inputClass } from "./ConsignmentChrome";

/** ออเดอร์ที่ไม่มีรส (เช่น เดลิเวอรีผ่าน Connect) — ร้านเลือกรสเพื่อให้ตัดสต็อกรายรสถูก */
export function NeedsFlavorPanel({ rows, products }: { rows: NeedsFlavorRow[]; products: ResaleProduct[] }) {
  const router = useRouter();
  const [choice, setChoice] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [isPending, startTransition] = useTransition();

  function assign(row: NeedsFlavorRow) {
    const optionId = choice[row.movementId];
    if (!optionId) {
      setMessage({ tone: "error", text: "เลือกรสก่อน" });
      return;
    }
    startTransition(async () => {
      const result = await assignFlavorAction(row.movementId, optionId);
      setMessage(result.error ? { tone: "error", text: result.error } : { tone: "ok", text: "ตัดสต็อกตามรสที่เลือกแล้ว" });
      router.refresh();
    });
  }

  return (
    <div className="space-y-3">
      <h2 className="text-lg font-semibold text-[var(--ink)]">รอเลือกรส ({rows.length})</h2>
      <p className="text-sm text-[var(--muted)]">ออเดอร์จากช่องทางที่ไม่ส่งรสมา (เช่น เดลิเวอรี) — ยังไม่ตัดสต็อกและยังไม่นับยอดจ่ายเจ้าของจนกว่าจะเลือกรส</p>
      {message && (
        <p role="status" className={`rounded-lg px-3 py-2 text-sm ${message.tone === "ok" ? "bg-green-50 text-green-800" : "bg-red-50 text-red-700"}`}>
          {message.text}
        </p>
      )}
      <ul className="divide-y divide-[var(--border)] overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)]">
        {rows.map((row) => {
          const product = products.find((p) => p.id === row.productId);
          const group = product?.groups.find((g) => g.id === product.resaleOptionGroupId);
          return (
            <li key={row.movementId} className="flex flex-wrap items-center gap-2 p-3">
              <span className="min-w-0 flex-1 text-sm text-[var(--ink)]">
                {product?.name ?? "เมนูที่ถูกลบ"} × {row.qty}
                <span className="ml-2 text-xs text-[var(--muted)]">{new Date(row.createdAt).toLocaleString("th-TH")}</span>
              </span>
              <select
                aria-label="รส"
                className={`${inputClass} w-auto min-w-40`}
                value={choice[row.movementId] ?? ""}
                onChange={(e) => setChoice((c) => ({ ...c, [row.movementId]: e.target.value }))}
              >
                <option value="">เลือกรส</option>
                {(group?.options ?? []).map((o) => (
                  <option key={o.id} value={o.id}>{o.name}</option>
                ))}
              </select>
              <button type="button" className="btn-primary min-h-11" disabled={isPending} onClick={() => assign(row)}>
                บันทึก
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
