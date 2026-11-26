"use client";

// R2: เลือกคนส่งตอนกด "ออกไปส่ง" (ออเดอร์ออนไลน์ส่งถึงบ้าน) — ใช้ทั้งตั๋วใน POS และหน้า สั่งออนไลน์

import { useEffect, useState } from "react";
import { computeRiderPay } from "@/modules/online-orders/core";
import { listRiderCandidatesAction } from "./actions";

const baht = (n: number) => `฿${n.toLocaleString("th-TH", { maximumFractionDigits: 2 })}`;

export function RiderPicker({
  orderCode,
  subtotal,
  deliveryFee,
  busy,
  onPick,
  onClose,
}: {
  orderCode: string;
  subtotal: number;
  deliveryFee: number;
  busy: boolean;
  onPick: (riderUserId: string) => void;
  onClose: () => void;
}) {
  const [state, setState] = useState<Awaited<ReturnType<typeof listRiderCandidatesAction>> | null>(null);

  useEffect(() => {
    let cancelled = false;
    void listRiderCandidatesAction()
      .catch(() => ({ riders: [], payEnabled: false, payRate: 0, payIncludeFee: false, error: "โหลดรายชื่อพนักงานไม่สำเร็จ" }))
      .then((res) => {
        if (!cancelled) setState(res);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const pay = state?.payEnabled
    ? computeRiderPay({ subtotal, deliveryFee, rate: state.payRate, includeFee: state.payIncludeFee })
    : null;

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/40 sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-label={`เลือกคนส่ง ${orderCode}`}>
      <div className="max-h-[85dvh] w-full max-w-sm overflow-y-auto rounded-t-2xl bg-white p-4 shadow-xl sm:rounded-2xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-base font-bold text-gray-900">ใครไปส่ง {orderCode}?</p>
            {pay !== null && (
              <p className="text-xs text-emerald-700">
                คนส่งได้รายได้พิเศษ {baht(pay)} ({state?.payRate}% ของอาหาร{state?.payIncludeFee ? " + ค่าส่ง" : ""}) เข้าเงินเดือนเมื่อกดสำเร็จ
              </p>
            )}
          </div>
          <button type="button" onClick={onClose} className="min-h-11 min-w-11 rounded-lg text-xl text-gray-500" aria-label="ปิด">
            ×
          </button>
        </div>
        {!state && <p className="py-6 text-center text-sm text-gray-500">กำลังโหลดรายชื่อ…</p>}
        {state?.error && <p className="mt-3 rounded-lg bg-red-50 p-2 text-sm text-red-700">{state.error}</p>}
        {state && !state.error && state.riders.length === 0 && (
          <p className="mt-3 rounded-lg bg-amber-50 p-2 text-sm text-amber-900">ยังไม่มีพนักงานที่ตั้งโปรไฟล์เงินเดือนในสาขานี้ (หน้าพนักงาน)</p>
        )}
        <ul className="mt-3 space-y-2">
          {state?.riders.map((r) => (
            <li key={r.userId}>
              <button
                type="button"
                disabled={busy}
                onClick={() => onPick(r.userId)}
                className="flex min-h-12 w-full items-center justify-between rounded-lg border border-gray-200 px-3 text-left text-sm hover:border-[var(--tenant-primary)] disabled:opacity-50"
              >
                <span className="font-semibold text-gray-800">{r.name}</span>
                {r.onShift ? (
                  <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] text-emerald-800">ลงเวลาอยู่</span>
                ) : (
                  <span className="text-[11px] text-gray-400">ไม่ได้ลงเวลา</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
