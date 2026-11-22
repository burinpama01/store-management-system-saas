"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { PayoutMethod, ResaleProduct, SettlementPreview } from "@/modules/consignment/types";
import { useConfirm } from "@/shared/components/ui/useConfirm";
import { settleAction } from "./operations-actions";
import { baht, itemLabel } from "./ConsignmentChrome";

/** ยอดค้างจ่ายเจ้าของฝากขาย + ปุ่ม "เคลียร์ตอนนี้" (ไม่ต้องรอเติมของ/ปิดรอบ) */
export function OutstandingPanel({ previews, products }: { previews: SettlementPreview[]; products: ResaleProduct[] }) {
  const router = useRouter();
  const { confirm, confirmDialog } = useConfirm();
  const [open, setOpen] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [isPending, startTransition] = useTransition();
  const rows = previews.filter((p) => p.total !== 0 || p.ownerDue !== 0 || p.clawback !== 0 || p.pendingRows > 0);

  async function settleNow(p: SettlementPreview, method: PayoutMethod) {
    const ok = await confirm({
      title: `เคลียร์เงิน ${p.name}?`,
      message:
        p.total > 0
          ? `จ่าย ${baht(p.total)} บาท ด้วย${method === "cash" ? "เงินสด (ตัดจากลิ้นชัก)" : "การโอน"}${p.payoutAccount ? ` · ${p.payoutAccount}` : ""}`
          : `ยอดสุทธิ ${baht(p.total)} บาท — ไม่ต้องจ่าย ยอดติดลบยกไปหักรอบหน้า`,
      confirmLabel: "เคลียร์",
    });
    if (!ok) return;
    setMessage(null);
    startTransition(async () => {
      const result = await settleAction({ supplierId: p.supplierId, method, trigger: "manual", expectedTotal: p.total, note: null });
      if (result.error) {
        setMessage({ tone: "error", text: result.error });
        router.refresh();
        return;
      }
      setMessage({ tone: "ok", text: `เคลียร์ ${p.name} แล้ว${(result.paid ?? 0) > 0 ? ` จ่าย ${baht(result.paid ?? 0)} บาท` : ""}` });
      setOpen(null);
      router.refresh();
    });
  }

  return (
    <div className="space-y-3">
      <h2 className="text-lg font-semibold text-[var(--ink)]">ยอดค้างจ่ายเจ้าของฝากขาย</h2>
      {message && (
        <p role="status" className={`rounded-lg px-3 py-2 text-sm ${message.tone === "ok" ? "bg-green-50 text-green-800" : "bg-red-50 text-red-700"}`}>
          {message.text}
        </p>
      )}
      {rows.length === 0 ? (
        <p className="rounded-xl border border-dashed border-[var(--border)] p-4 text-center text-sm text-[var(--muted)]">ไม่มียอดค้าง</p>
      ) : (
        <ul className="divide-y divide-[var(--border)] overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)]">
          {rows.map((p) => (
            <li key={p.supplierId} className="space-y-2 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-semibold text-[var(--ink)]">{p.name}</p>
                  <p className="text-xs text-[var(--muted)]">
                    {p.settleCycle === "daily" ? "เคลียร์ทุกวันตอนปิดรอบ" : "เคลียร์ตอนเติมของ"} · {p.payoutMethod === "cash" ? "รับเงินสด" : "รับโอน"}
                    {p.pendingRows > 0 ? ` · รอบิลจ่าย/เลือกรส ${p.pendingRows} รายการ` : ""}
                  </p>
                </div>
                <div className="text-right">
                  <p className={`text-lg font-bold ${p.total < 0 ? "text-red-700" : "text-[var(--ink)]"}`}>{baht(p.total)}</p>
                  <button type="button" className="text-xs text-[var(--tenant-primary)] underline" onClick={() => setOpen(open === p.supplierId ? null : p.supplierId)}>
                    {open === p.supplierId ? "ซ่อน" : "ดูรายละเอียด / เคลียร์"}
                  </button>
                </div>
              </div>
              {open === p.supplierId && (
                <div className="space-y-2 rounded-lg bg-[var(--surface-muted)] p-3 text-sm">
                  {p.lines.map((l) => (
                    <div key={`${l.productId}:${l.optionId ?? "-"}`} className="flex justify-between gap-2">
                      <span>{itemLabel(products, l.productId, l.optionId)} × {l.qty}</span>
                      <span>{baht(l.due)}</span>
                    </div>
                  ))}
                  {p.clawback > 0 && <div className="flex justify-between text-red-700"><span>หักยอดที่จ่ายไปแล้วแต่ถูกยกเลิก/คืนเงิน</span><span>−{baht(p.clawback)}</span></div>}
                  {p.carryIn > 0 && <div className="flex justify-between text-red-700"><span>ยกยอดติดลบจากรอบก่อน</span><span>−{baht(p.carryIn)}</span></div>}
                  <div className="flex justify-between border-t border-[var(--border)] pt-2 font-semibold"><span>สุทธิ</span><span>{baht(p.total)}</span></div>
                  {p.payoutAccount && <p className="text-xs text-[var(--muted)]">บัญชีรับเงิน: {p.payoutAccount}</p>}
                  <div className="flex flex-wrap gap-2 pt-1">
                    <button type="button" className="btn-primary min-h-11" disabled={isPending} onClick={() => settleNow(p, p.payoutMethod)}>
                      {p.total > 0 ? `จ่าย${p.payoutMethod === "cash" ? "เงินสด" : "โอน"}แล้ว` : "ปิดยอด (ยกไปรอบหน้า)"}
                    </button>
                    {p.total > 0 && (
                      <button type="button" className="btn-secondary min-h-11" disabled={isPending} onClick={() => settleNow(p, p.payoutMethod === "cash" ? "transfer" : "cash")}>
                        จ่ายด้วย{p.payoutMethod === "cash" ? "การโอน" : "เงินสด"}แทน
                      </button>
                    )}
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {confirmDialog}
    </div>
  );
}
