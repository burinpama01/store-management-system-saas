"use client";

import { useEffect, useState, useTransition } from "react";
import { getDailyCloseConsignmentAction, settleAtDailyCloseAction } from "../(dashboard)/consignment/operations-actions";

type Row = {
  supplierId: string;
  name: string;
  payoutMethod: "cash" | "transfer";
  payoutAccount: string | null;
  total: number;
  pendingRows: number;
};

const baht = (v: number) => new Intl.NumberFormat("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v);

/**
 * ปิดรอบเงินสด: แยกเงินสดให้เจ้าของฝากขายที่เลือก "เคลียร์ทุกวัน" (Enterprise + เปิดสวิตช์)
 * จ่ายแล้ว → ระบบลงรายจ่ายเงินสด → "เงินที่ควรมี" ลดลงหลัง refresh ยอดนับจริงจึงไม่เพี้ยน
 * ร้านที่ไม่ได้ใช้ฝากขาย: แอ็กชันคืน null → ไม่แสดงอะไร
 */
export function ConsignmentCloseStep({ onSettled }: { onSettled: () => void }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [isPending, startTransition] = useTransition();

  function load() {
    startTransition(async () => {
      const res = await getDailyCloseConsignmentAction().catch(() => ({ data: null, error: null }));
      if (res.error) setMessage({ tone: "error", text: res.error });
      setRows(res.data);
    });
  }

  useEffect(load, []);

  if (!rows || rows.length === 0) return message ? <p className="mt-3 text-xs text-red-500">{message.text}</p> : null;

  function pay(row: Row) {
    setMessage(null);
    startTransition(async () => {
      const res = await settleAtDailyCloseAction(row.supplierId, row.total);
      if (res.error) {
        setMessage({ tone: "error", text: res.error });
      } else {
        setMessage({ tone: "ok", text: `แยกเงิน ${row.name} ${baht(res.paid ?? 0)} บาทแล้ว` });
        onSettled();
      }
      const fresh = await getDailyCloseConsignmentAction().catch(() => ({ data: null, error: null }));
      // โหลดใหม่ไม่สำเร็จ = คงรายการเดิมไว้ (ไม่ให้เจ้าของที่ยังไม่แยกเงินหายไปจากจอ)
      if (fresh.data !== null) setRows(fresh.data);
    });
  }

  return (
    <div className="mt-4 space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-3">
      <p className="text-sm font-semibold text-amber-900">ฝากขาย: แยกเงินให้เจ้าของก่อนนับ</p>
      {rows.map((row) => (
        <div key={row.supplierId} className="flex items-center justify-between gap-2 text-sm">
          <span className="min-w-0">
            {row.name}
            <span className="block text-xs text-amber-800">
              {row.payoutMethod === "cash" ? "รับเงินสด" : `รับโอน — กดโอนแล้วที่หน้าฝากขาย${row.payoutAccount ? ` (${row.payoutAccount})` : ""}`}
              {row.pendingRows > 0 ? ` · ${row.pendingRows} รายการรอบิลจ่าย` : ""}
            </span>
          </span>
          {row.payoutMethod === "cash" && row.total > 0 ? (
            <button type="button" disabled={isPending} onClick={() => pay(row)} className="btn-primary min-h-10 shrink-0 px-3 text-xs">
              แยกเงินแล้ว {baht(row.total)}
            </button>
          ) : (
            <span className="shrink-0 font-semibold">{baht(row.total)}</span>
          )}
        </div>
      ))}
      {message && <p className={`text-xs ${message.tone === "ok" ? "text-green-700" : "text-red-600"}`}>{message.text}</p>}
    </div>
  );
}
