"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/shared/components/ui";
import type { PayWeek } from "@/modules/hr/advanced/weekly";
import { recordWeeklyPayoutsAction } from "./advanced-actions";

export interface WeeklyPayoutView {
  userId: string;
  weekStart: string;
  mode: "weekly" | "weekly_advance";
  amount: number;
  workedDays: number;
  name: string;
}

function fmt(amount: number, currency: string): string {
  return new Intl.NumberFormat("th-TH", { style: "currency", currency, maximumFractionDigits: 2 }).format(amount);
}

/** ค่าแรงรายสัปดาห์ (W8): ยอดที่บันทึกแล้วต่อสัปดาห์ + ปุ่มบันทึกเอง (สัปดาห์ก่อนเปิดสวิตช์/คนตกหล่น) */
export function WeeklyPayoutsPanel({
  weeks,
  rows,
  businessToday,
  currency,
  weeklyStaffCount,
}: {
  weeks: PayWeek[];
  rows: WeeklyPayoutView[];
  businessToday: string;
  currency: string;
  weeklyStaffCount: number;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [busyWeek, setBusyWeek] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  function record(weekStart: string) {
    setError(null);
    setNotice(null);
    setBusyWeek(weekStart);
    startTransition(async () => {
      const r = await recordWeeklyPayoutsAction(weekStart);
      setBusyWeek(null);
      if (r.error) setError(r.error);
      else {
        setNotice(r.message ?? "บันทึกแล้ว");
        router.refresh();
      }
    });
  }

  const byWeek = new Map<string, WeeklyPayoutView[]>();
  for (const r of rows) byWeek.set(r.weekStart, [...(byWeek.get(r.weekStart) ?? []), r]);

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-bold text-gray-900">ค่าแรงรายสัปดาห์</h2>
        <span className="text-xs text-gray-500">พนักงานรายสัปดาห์ {weeklyStaffCount} คน</span>
      </div>
      {weeklyStaffCount === 0 && (
        <p className="mt-2 text-xs text-amber-700">ยังไม่มีพนักงานที่ตั้งรอบจ่ายรายสัปดาห์ — ตั้งได้ที่ข้อมูลพนักงานแต่ละคน ช่อง &quot;รอบจ่าย&quot;</p>
      )}
      {error && <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}
      {notice && <p className="mt-2 rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700" aria-live="polite">{notice}</p>}

      <ul className="mt-3 divide-y divide-gray-100">
        {weeks.map((w) => {
          const list = byWeek.get(w.start) ?? [];
          const total = Math.round(list.reduce((s, r) => s + r.amount, 0) * 100) / 100;
          const ended = businessToday > w.end;
          return (
            <li key={w.start} className="py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-gray-900">
                    {w.start} ถึง {w.end}
                  </p>
                  <p className="text-xs text-gray-500">
                    {!ended
                      ? "สัปดาห์ปัจจุบัน — ระบบบันทึกและแจ้งเจ้าของหลังเวลาปิดร้านของวันสุดท้าย"
                      : list.length
                        ? `บันทึกแล้ว ${list.length} คน · รวม ${fmt(total, currency)}`
                        : "ยังไม่ได้บันทึก"}
                  </p>
                </div>
                {ended && weeklyStaffCount > 0 && (
                  <Button
                    type="button"
                    variant={list.length ? "secondary" : "primary"}
                    loading={isPending && busyWeek === w.start}
                    disabled={isPending}
                    onClick={() => record(w.start)}
                    className="min-h-11 px-4 text-sm"
                  >
                    {list.length ? "เพิ่มคนที่ตกหล่น" : "บันทึก + แจ้งเจ้าของ"}
                  </Button>
                )}
              </div>
              {list.length > 0 && (
                <ul className="mt-2 space-y-1 text-sm">
                  {list.map((r) => (
                    <li key={r.userId} className="flex justify-between gap-3 text-gray-700">
                      <span className="min-w-0 truncate">
                        {r.name || "พนักงาน"}{" "}
                        <span className="text-xs text-gray-400">
                          · {r.workedDays} วัน · {r.mode === "weekly_advance" ? "ล่วงหน้า (หักสิ้นงวด)" : "แยกรอบ"}
                        </span>
                      </span>
                      <span className="shrink-0 font-semibold">{fmt(r.amount, currency)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
      <p className="mt-2 text-[11px] text-gray-400">
        ยอดที่บันทึกแล้วไม่ถูกคำนวณใหม่ (ใช้หักในงวดรายเดือนสำหรับแบบล่วงหน้า) · แก้ลงเวลาย้อนหลังหลังบันทึกแล้ว ให้เพิ่มรายการปรับแทน (แบบแยกรอบ: ลงวันที่ในสัปดาห์ถัดไป)
      </p>
    </div>
  );
}
