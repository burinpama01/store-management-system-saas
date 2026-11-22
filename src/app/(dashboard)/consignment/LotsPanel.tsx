"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { LotAdjustKind, ResaleLot, ResaleProduct } from "@/modules/consignment/types";
import type { Supplier } from "@/modules/inventory/types";
import { adjustLotAction } from "./operations-actions";
import { baht, inputClass, itemLabel } from "./ConsignmentChrome";

const KIND_LABEL: Record<LotAdjustKind, string> = {
  return_owner: "คืนเจ้าของ",
  damage: "ของเสีย/หมดอายุ",
  count_adjust: "ปรับจากการนับ",
  store_buyout: "ร้านซื้อไว้เอง",
};

function daysUntil(date: string): number {
  const today = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Bangkok" }));
  today.setHours(0, 0, 0, 0);
  return Math.round((Date.parse(`${date}T00:00:00`) - today.getTime()) / 86_400_000);
}

/** ของคงเหลือรายล็อต + ใกล้หมดอายุ + คืนของ/ของเสีย/นับ (C4) */
export function LotsPanel({ lots, products, suppliers }: { lots: ResaleLot[]; products: ResaleProduct[]; suppliers: Supplier[] }) {
  const router = useRouter();
  const [editing, setEditing] = useState<{ lot: ResaleLot; kind: LotAdjustKind; qty: string; note: string } | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [isPending, startTransition] = useTransition();
  const supplierName = useMemo(() => new Map(suppliers.map((s) => [s.id, s.name])), [suppliers]);
  const nearExpiry = lots.filter((l) => l.expiresOn && daysUntil(l.expiresOn) <= 1);

  function save() {
    if (!editing) return;
    const qty = Number(editing.qty);
    if (!Number.isInteger(qty) || qty === 0) {
      setMessage({ tone: "error", text: editing.kind === "count_adjust" ? "ใส่จำนวนที่ต่าง (ขาด = ติดลบ เช่น -1)" : "ใส่จำนวนเป็นจำนวนเต็มมากกว่า 0" });
      return;
    }
    startTransition(async () => {
      const result = await adjustLotAction({ lotId: editing.lot.id, kind: editing.kind, qty, note: editing.note || null });
      if (result.error) {
        setMessage({ tone: "error", text: result.error });
        return;
      }
      setMessage({ tone: "ok", text: `บันทึก${KIND_LABEL[editing.kind]}แล้ว` });
      setEditing(null);
      router.refresh();
    });
  }

  return (
    <div className="space-y-3">
      <h2 className="text-lg font-semibold text-[var(--ink)]">ของคงเหลือ ({lots.reduce((s, l) => s + l.qtyRemaining, 0)} ชิ้น)</h2>
      {nearExpiry.length > 0 && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          ใกล้หมดอายุ/หมดอายุแล้ว: {nearExpiry.map((l) => `${itemLabel(products, l.productId, l.optionId)} ${l.qtyRemaining} ชิ้น (${l.expiresOn})`).join(" · ")}
        </p>
      )}
      {message && (
        <p role="status" className={`rounded-lg px-3 py-2 text-sm ${message.tone === "ok" ? "bg-green-50 text-green-800" : "bg-red-50 text-red-700"}`}>
          {message.text}
        </p>
      )}
      {lots.length === 0 ? (
        <p className="rounded-xl border border-dashed border-[var(--border)] p-4 text-center text-sm text-[var(--muted)]">ยังไม่มีของในคลัง — รับของที่แท็บ รับของ / เติมของ</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-[var(--border)] bg-[var(--surface)]">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="bg-[var(--surface-muted)] text-left text-xs text-[var(--muted)]">
              <tr>
                <th className="p-2">เมนู/รส</th>
                <th className="p-2">เจ้าของ</th>
                <th className="p-2">แบบ</th>
                <th className="p-2 text-right">เหลือ/รับ</th>
                <th className="p-2 text-right">ต่อชิ้น</th>
                <th className="p-2">หมดอายุ</th>
                <th className="p-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {lots.map((l) => (
                <tr key={l.id}>
                  <td className="p-2">{itemLabel(products, l.productId, l.optionId)}</td>
                  <td className="p-2">{supplierName.get(l.supplierId) ?? "-"}</td>
                  <td className="p-2">{l.mode === "resale" ? "ซื้อขาด" : "ฝากขาย"}</td>
                  <td className="p-2 text-right">{l.qtyRemaining}/{l.qtyReceived}</td>
                  <td className="p-2 text-right">{baht(l.unitCost)}</td>
                  <td className={`p-2 ${l.expiresOn && daysUntil(l.expiresOn) <= 1 ? "font-semibold text-red-700" : ""}`}>{l.expiresOn ?? "-"}</td>
                  <td className="p-2 text-right">
                    <button type="button" className="btn-secondary min-h-9 text-xs" onClick={() => { setMessage(null); setEditing({ lot: l, kind: l.mode === "consignment" ? "return_owner" : "damage", qty: "", note: "" }); }}>
                      ปรับ
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <div className="space-y-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <p className="font-semibold text-[var(--ink)]">ปรับ {itemLabel(products, editing.lot.productId, editing.lot.optionId)} (เหลือ {editing.lot.qtyRemaining})</p>
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="block text-sm">
              <span className="text-[var(--muted)]">ประเภท</span>
              <select className={inputClass} value={editing.kind} onChange={(e) => setEditing({ ...editing, kind: e.target.value as LotAdjustKind })}>
                {(Object.keys(KIND_LABEL) as LotAdjustKind[])
                  .filter((k) => editing.lot.mode === "consignment" || (k !== "return_owner" && k !== "store_buyout"))
                  .map((k) => (
                    <option key={k} value={k}>{KIND_LABEL[k]}</option>
                  ))}
              </select>
            </label>
            <label className="block text-sm">
              <span className="text-[var(--muted)]">{editing.kind === "count_adjust" ? "ต่างจากในระบบ (ขาด = −)" : "จำนวน"}</span>
              <input className={inputClass} inputMode="numeric" value={editing.qty} onChange={(e) => setEditing({ ...editing, qty: e.target.value })} />
            </label>
            <label className="block text-sm">
              <span className="text-[var(--muted)]">หมายเหตุ</span>
              <input className={inputClass} maxLength={300} value={editing.note} onChange={(e) => setEditing({ ...editing, note: e.target.value })} />
            </label>
          </div>
          <p className="text-xs text-[var(--muted)]">
            {editing.lot.mode === "resale"
              ? "ซื้อขาด: ของเสีย/หาย ร้านรับผิดชอบ (นับเป็นค่าเสียหาย)"
              : editing.kind === "store_buyout"
                ? "ร้านซื้อไว้เอง: นับเป็นยอดต้องจ่ายเจ้าของในรอบเคลียร์ถัดไป"
                : "ฝากขาย: ของเสีย/หาย เจ้าของรับผิดชอบ (ไม่จ่าย)"}
          </p>
          <div className="flex gap-2">
            <button type="button" className="btn-primary min-h-11" disabled={isPending} onClick={save}>บันทึก</button>
            <button type="button" className="btn-secondary min-h-11" disabled={isPending} onClick={() => setEditing(null)}>ยกเลิก</button>
          </div>
        </div>
      )}
    </div>
  );
}
