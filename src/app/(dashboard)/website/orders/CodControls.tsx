"use client";

// R3: ปุ่มเก็บเงินปลายทาง — เลือกวิธีรับเงินตอนส่งสำเร็จ / ส่งไม่สำเร็จ / รับเงินสดคืนจากคนส่ง
// ใช้ทั้งตั๋วใน POS และหน้า สั่งออนไลน์

import { useState } from "react";
import type { CodCollectMethod } from "@/modules/online-orders/core";

const baht = (n: number) => `฿${n.toLocaleString("th-TH", { maximumFractionDigits: 2 })}`;

/** เลือกวิธีรับเงินตอนกด "สำเร็จ" ของออเดอร์เก็บปลายทาง */
export function CodCollectPicker({
  orderCode,
  total,
  busy,
  onPick,
  onClose,
}: {
  orderCode: string;
  total: number;
  busy: boolean;
  onPick: (method: CodCollectMethod) => void;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/40 sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-label={`รับเงินปลายทาง ${orderCode}`}>
      <div className="w-full max-w-sm rounded-t-2xl bg-white p-4 shadow-xl sm:rounded-2xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-base font-bold text-gray-900">รับเงินปลายทาง {baht(total)}</p>
            <p className="text-xs text-gray-500">{orderCode} · ลูกค้าจ่ายด้วยอะไร?</p>
          </div>
          <button type="button" onClick={onClose} className="min-h-11 min-w-11 rounded-lg text-xl text-gray-500" aria-label="ปิด">
            ×
          </button>
        </div>
        <div className="mt-3 grid gap-2">
          <button type="button" disabled={busy} onClick={() => onPick("cash")} className="min-h-12 rounded-lg border border-gray-200 px-3 text-left text-sm hover:border-[var(--tenant-primary)] disabled:opacity-50">
            💵 <b>เงินสด</b>
            <span className="block text-xs text-gray-500">คนส่งถือเงินไว้ — กลับร้านแล้วกด “รับเงินคืน” บิลจึงปิดเข้าลิ้นชัก</span>
          </button>
          <button type="button" disabled={busy} onClick={() => onPick("bank_transfer")} className="min-h-12 rounded-lg border border-gray-200 px-3 text-left text-sm hover:border-[var(--tenant-primary)] disabled:opacity-50">
            🏦 <b>เงินโอน</b>
            <span className="block text-xs text-gray-500">ปิดบิลวิธีโอนทันที (ตรวจยอดเข้าบัญชีร้านก่อนกด)</span>
          </button>
        </div>
      </div>
    </div>
  );
}

/** ยืนยัน "ส่งไม่สำเร็จ" พร้อมเหตุผล — ยกเลิกบิลเปิดค้าง ไม่มีเงินเข้า */
export function CodFailButton({ busy, onConfirm, label = "ส่งไม่สำเร็จ" }: { busy: boolean; onConfirm: (reason: string) => void; label?: string }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("ลูกค้าไม่รับของ/ติดต่อไม่ได้");
  if (!open) {
    return (
      <button type="button" disabled={busy} onClick={() => setOpen(true)} className="btn-secondary min-h-11 px-4 text-sm text-red-700">
        {label}
      </button>
    );
  }
  return (
    <div className="w-full space-y-2 rounded-lg border border-red-200 bg-red-50 p-2 text-sm">
      <label className="block text-xs text-red-800">
        เหตุผล (ยกเลิกบิล ไม่มีเงินเข้า · ส่งไม่สำเร็จ 2 ครั้ง เบอร์นี้จะใช้เก็บปลายทางไม่ได้)
        <input value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} className="mt-1 w-full rounded border px-2 py-2 text-sm" style={{ fontSize: 16 }} />
      </label>
      <div className="flex gap-2">
        <button type="button" disabled={busy} onClick={() => onConfirm(reason)} className="btn-primary min-h-11 flex-1 bg-red-600 px-3 text-sm">
          ยืนยัน{label}
        </button>
        <button type="button" onClick={() => setOpen(false)} className="btn-secondary min-h-11 px-3 text-sm">
          กลับ
        </button>
      </div>
    </div>
  );
}
