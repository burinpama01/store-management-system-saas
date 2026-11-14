"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { PayPeriod } from "@/modules/hr/advanced/pay-cycle";
import type { PayrollPeriodRow } from "@/modules/hr/advanced/repository";
import { useConfirm } from "@/shared/components/ui";
import { closePayrollPeriodAction, reopenPayrollPeriodAction } from "./advanced-actions";

function fmt(n: number, currency: string) {
  return new Intl.NumberFormat("th-TH", { style: "currency", currency, maximumFractionDigits: 2 }).format(n);
}

/** รอบเงินเดือน (R14–R16, R22–R24): เลือกงวด + สถานะงวด + ปิดเอง/เปิดงวดแก้ */
export function PayrollPeriodsPanel({
  periods,
  closedRows,
  businessToday,
  dateFrom,
  dateTo,
  currency,
}: {
  periods: PayPeriod[];
  closedRows: PayrollPeriodRow[];
  businessToday: string;
  dateFrom: string;
  dateTo: string;
  currency: string;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const rowByStart = new Map(closedRows.map((r) => [r.periodStart, r]));
  const { confirm, confirmDialog } = useConfirm();

  function run(action: () => Promise<{ error: string | null }>) {
    setError(null);
    startTransition(async () => {
      const r = await action();
      if (r.error) setError(r.error);
      else router.refresh();
    });
  }

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4">
      {confirmDialog}
      <h2 className="text-sm font-bold text-gray-900">งวดเงินเดือน</h2>
      <p className="text-xs text-gray-500">ระบบปิดงวดเองหลังเวลาปิดร้านของวันสุดท้าย · พนักงานเห็นสลิปตั้งแต่วันจ่าย</p>
      {error && <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100 text-left text-xs text-gray-500">
              <th className="px-2 py-2 font-medium">งวด</th>
              <th className="px-2 py-2 font-medium">วันจ่าย</th>
              <th className="px-2 py-2 font-medium">สถานะ</th>
              <th className="px-2 py-2 font-medium text-right">ยอดรวม</th>
              <th className="px-2 py-2 font-medium text-right"></th>
            </tr>
          </thead>
          <tbody>
            {periods.map((p) => {
              const row = rowByStart.get(p.start);
              const selected = p.start === dateFrom && p.end === dateTo;
              const ended = businessToday > p.end;
              return (
                <tr key={p.start} className={`border-b border-gray-50 last:border-0 ${selected ? "bg-orange-50" : ""}`}>
                  <td className="px-2 py-2">
                    <a href={`/staff?dateFrom=${p.start}&dateTo=${p.end}`} className="text-orange-700 hover:underline">
                      {p.start} – {p.end}
                    </a>
                  </td>
                  <td className="px-2 py-2 text-gray-600">{p.payDate}</td>
                  <td className="px-2 py-2">
                    {row?.status === "closed" ? (
                      <span className="rounded-full bg-green-50 px-2 py-0.5 text-xs text-green-700">
                        ปิดแล้ว{row.revision > 1 ? ` (แก้ไขครั้งที่ ${row.revision})` : ""}{row.closedBy ? "" : " · อัตโนมัติ"}
                      </span>
                    ) : row?.status === "reopened" ? (
                      <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs text-amber-700">เปิดแก้ไขอยู่</span>
                    ) : ended ? (
                      <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-600">จบแล้ว รอปิด</span>
                    ) : (
                      <span className="rounded-full bg-blue-50 px-2 py-0.5 text-xs text-blue-700">กำลังเดิน (ประมาณการ)</span>
                    )}
                  </td>
                  <td className="px-2 py-2 text-right text-gray-700">{row ? fmt(row.totalNetPay, currency) : "—"}</td>
                  <td className="px-2 py-2 text-right whitespace-nowrap">
                    {row?.status === "closed" ? (
                      <>
                        <a href={`/payslip?periodId=${row.id}&mode=summary`} target="_blank" rel="noopener noreferrer" className="mr-3 text-xs text-orange-600 hover:underline">
                          สลิปที่ปิดแล้ว
                        </a>
                        <button
                          type="button"
                          disabled={isPending}
                          onClick={async () => {
                            const ok = await confirm({
                              title: "เปิดงวดนี้เพื่อแก้ไข?",
                              message: "เมื่อปิดใหม่ สลิปเดิมจะถูกแทน (เก็บประวัติไว้) และระบบแจ้งเจ้าของ",
                              confirmLabel: "เปิดงวดแก้ไข",
                            });
                            if (ok) run(() => reopenPayrollPeriodAction(row.id));
                          }}
                          className="text-xs text-amber-700 hover:underline"
                        >
                          เปิดงวดแก้ไข
                        </button>
                      </>
                    ) : ended ? (
                      <button
                        type="button"
                        disabled={isPending}
                        onClick={() => run(() => closePayrollPeriodAction(p.start))}
                        className="text-xs font-semibold text-orange-700 hover:underline"
                      >
                        {row?.status === "reopened" ? "ปิดงวดใหม่" : "ปิดงวดเลย"}
                      </button>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
