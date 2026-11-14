"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, useConfirm } from "@/shared/components/ui";
import { ADVANCE_STATUS_LABEL, type AdvanceStatus } from "@/modules/hr/advanced/salary-advance";
import { cancelSalaryAdvanceAction, requestSalaryAdvanceAction } from "./actions";

export interface MyAdvanceRow {
  id: string;
  status: AdvanceStatus;
  requestedAmount: number;
  approvedAmount: number | null;
  reason: string | null;
  decisionNote: string | null;
  payMethod: "cash" | "transfer" | null;
  paidDate: string | null;
  createdAt: string;
  deducted: number;
}

const baht = (n: number) => `฿${n.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const STATUS_CLASS: Record<AdvanceStatus, string> = {
  pending: "bg-amber-50 text-amber-700",
  paid: "bg-green-50 text-green-700",
  rejected: "bg-red-50 text-red-600",
  cancelled: "bg-gray-100 text-gray-500",
};

export function MyAdvanceView(props: {
  cycle: { kind: "monthly" | "weekly"; start: string; end: string };
  today: string;
  hasProfile: boolean;
  workedDays: number;
  earned: number;
  weeklyPaidInCycle: number;
  available: number;
  /** เบิกเงินสดได้สูงสุด (ไม่เกินเงินสดในลิ้นชัก) */
  cashMax: number;
  cashSessionOpen: boolean;
  blockedReason: string | null;
  advances: MyAdvanceRow[];
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const { confirm, confirmDialog } = useConfirm();
  const canRequest = props.hasProfile && !props.blockedReason && props.available > 0;
  // ค่าเริ่มต้น: เงินสดถ้ามีเงินสดพอ ไม่งั้นโอน
  const [payMethod, setPayMethod] = useState<"cash" | "transfer">(props.cashMax > 0 ? "cash" : "transfer");
  const max = payMethod === "cash" ? props.cashMax : props.available;

  function run(action: () => Promise<{ error: string | null }>, ok: string) {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const r = await action();
      if (r.error) setError(r.error);
      else {
        setNotice(ok);
        setAmount("");
        router.refresh();
      }
    });
  }

  return (
    <div className="page-shell space-y-4">
      {confirmDialog}
      <h1 className="text-xl font-bold text-[var(--ink)]">เบิกเงิน</h1>

      <div className="rounded-lg border border-gray-200 bg-white p-4">
        <p className="text-xs text-gray-500">
          {props.cycle.kind === "weekly" ? "สัปดาห์นี้" : "งวดนี้"} {props.cycle.start} ถึง {props.cycle.end} · ถึงวันนี้มาทำงาน {props.workedDays} วัน
        </p>
        <div className="mt-2 grid grid-cols-2 gap-3">
          <div>
            <p className="text-xs text-gray-500">ค่าแรงจากวันที่มาแล้ว</p>
            <p className="text-lg font-bold text-gray-900">{baht(props.earned)}</p>
          </div>
          <div>
            <p className="text-xs text-gray-500">เบิกได้อีก</p>
            <p className="text-lg font-bold text-[var(--tenant-primary)]">{baht(props.available)}</p>
          </div>
        </div>
        {props.weeklyPaidInCycle > 0 && (
          <p className="mt-1 text-[11px] text-gray-400">หักยอดรายสัปดาห์ที่รับไปแล้ว {baht(props.weeklyPaidInCycle)}</p>
        )}
        <p className="mt-2 text-[11px] text-gray-400">เบิกได้ไม่เกินค่าแรงจากวันที่มาทำงานแล้ว · ยอดที่เบิกจะหักจากเงินเดือนรอบนี้อัตโนมัติ</p>
      </div>

      {error && <p className="rounded-lg bg-red-50 px-4 py-2 text-sm text-red-600">{error}</p>}
      {notice && <p className="rounded-lg bg-green-50 px-4 py-2 text-sm text-green-700" aria-live="polite">{notice}</p>}

      {!props.hasProfile ? (
        <p className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">ยังไม่ได้ตั้งค่าจ้างของคุณ — ติดต่อผู้จัดการ</p>
      ) : !canRequest ? (
        <p className="rounded-lg border border-gray-200 bg-white p-4 text-sm text-gray-600">{props.blockedReason ?? "ตอนนี้ยังเบิกไม่ได้"}</p>
      ) : (
        <form
          action={(fd) => run(() => requestSalaryAdvanceAction(fd), "ส่งคำขอเบิกแล้ว รอผู้จัดการอนุมัติ")}
          className="space-y-3 rounded-lg border border-gray-200 bg-white p-4"
        >
          <label className="block text-xs font-medium text-gray-600">
            จำนวนเงินที่ต้องการเบิก (สูงสุด {baht(max)})
            <input
              name="amount"
              type="number"
              inputMode="decimal"
              min={1}
              max={max}
              step="0.01"
              required
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="mt-1 w-full min-h-11 rounded-lg border border-gray-300 px-3"
              style={{ fontSize: 16 }}
            />
          </label>
          <div className="flex flex-wrap gap-2">
            {[0.25, 0.5, 1].map((f) => {
              const v = Math.floor(max * f);
              if (v <= 0) return null;
              return (
                <button
                  key={f}
                  type="button"
                  onClick={() => setAmount(String(f === 1 ? max : v))}
                  className="min-h-11 rounded-lg border border-gray-300 px-3 text-sm text-gray-700"
                >
                  {f === 1 ? `เต็มเพดาน ${baht(max)}` : baht(v)}
                </button>
              );
            })}
          </div>
          <fieldset className="text-xs font-medium text-gray-600">
            <legend>รับเงินเป็น</legend>
            <div className="mt-1 grid grid-cols-2 gap-2">
              {(["cash", "transfer"] as const).map((m) => {
                const disabled = m === "cash" && props.cashMax <= 0;
                return (
                  <label
                    key={m}
                    className={`flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border px-3 ${payMethod === m ? "border-[var(--tenant-primary)] bg-orange-50/40" : "border-gray-300"} ${disabled ? "cursor-not-allowed opacity-50" : ""}`}
                  >
                    <input
                      type="radio"
                      name="payMethod"
                      value={m}
                      checked={payMethod === m}
                      disabled={disabled}
                      onChange={() => {
                        setPayMethod(m);
                        const nextMax = m === "cash" ? props.cashMax : props.available;
                        if (amount && Number(amount) > nextMax) setAmount(String(nextMax));
                      }}
                      className="accent-orange-500"
                    />
                    <span className="text-sm text-gray-800">{m === "cash" ? "เงินสด" : "โอนเข้าบัญชี"}</span>
                  </label>
                );
              })}
            </div>
            <span className="mt-1 block text-[11px] font-normal text-gray-400">
              {props.cashMax <= 0
                ? "ตอนนี้เงินสดในร้านไม่พอให้เบิก — เลือกรับเป็นเงินโอน"
                : props.cashMax < props.available
                  ? `เงินสดเบิกได้สูงสุด ${baht(props.cashMax)} ตามเงินสดที่มีในร้านตอนนี้ · โอนเบิกได้ถึง ${baht(props.available)}`
                  : "เงินสดไม่เกินเงินสดที่มีในร้านตอนอนุมัติ"}
              {!props.cashSessionOpen && props.cashMax > 0 ? " · ร้านยังไม่เปิดรอบเงินสด ยอดเงินสดอาจไม่เป็นปัจจุบัน" : ""}
            </span>
          </fieldset>
          <label className="block text-xs font-medium text-gray-600">
            เหตุผล (ไม่บังคับ)
            <input name="reason" maxLength={200} className="mt-1 w-full min-h-11 rounded-lg border border-gray-300 px-3" style={{ fontSize: 16 }} />
          </label>
          <Button type="submit" variant="primary" loading={isPending} className="min-h-11 w-full text-sm">
            ส่งคำขอเบิก
          </Button>
        </form>
      )}

      <div className="rounded-lg border border-gray-200 bg-white p-4">
        <h2 className="text-sm font-bold text-gray-900">ประวัติการเบิก</h2>
        {props.advances.length === 0 ? (
          <p className="mt-2 text-sm text-gray-400">ยังไม่เคยเบิก</p>
        ) : (
          <ul className="mt-2 divide-y divide-gray-100">
            {props.advances.map((a) => (
              <li key={a.id} className="flex items-start justify-between gap-3 py-2 text-sm">
                <div className="min-w-0">
                  <p className="font-semibold text-gray-900">
                    {baht(a.approvedAmount ?? a.requestedAmount)}
                    {a.approvedAmount !== null && a.approvedAmount !== a.requestedAmount && (
                      <span className="ml-1 text-xs font-normal text-gray-400">(ขอ {baht(a.requestedAmount)})</span>
                    )}
                  </p>
                  <p className="text-xs text-gray-500">
                    {a.createdAt.slice(0, 10)}
                    {a.paidDate ? ` · จ่าย ${a.paidDate} (${a.payMethod === "transfer" ? "โอน" : "เงินสด"})` : ""}
                    {a.status === "paid" ? ` · หักแล้ว ${baht(a.deducted)}` : ""}
                  </p>
                  {(a.reason || a.decisionNote) && (
                    <p className="text-xs text-gray-400">{[a.reason, a.decisionNote && `ผู้จัดการ: ${a.decisionNote}`].filter(Boolean).join(" · ")}</p>
                  )}
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_CLASS[a.status]}`}>{ADVANCE_STATUS_LABEL[a.status]}</span>
                  {a.status === "pending" && (
                    <button
                      type="button"
                      disabled={isPending}
                      onClick={async () => {
                        if (await confirm({ title: "ยกเลิกคำขอเบิก?", message: `ยอด ${baht(a.requestedAmount)}`, confirmLabel: "ยกเลิกคำขอ", danger: true })) {
                          run(() => cancelSalaryAdvanceAction(a.id), "ยกเลิกคำขอแล้ว");
                        }
                      }}
                      className="min-h-11 text-xs text-red-600 underline"
                    >
                      ยกเลิก
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
