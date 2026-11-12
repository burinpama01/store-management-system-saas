"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, useConfirm } from "@/shared/components/ui";
import { ADVANCE_STATUS_LABEL, type AdvanceStatus } from "@/modules/hr/advanced/salary-advance";
import {
  approveSalaryAdvanceAction,
  recordSalaryAdvanceForEmployeeAction,
  rejectSalaryAdvanceAction,
} from "./advance-actions";

export interface AdvanceView {
  id: string;
  userId: string;
  name: string;
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
const INPUT = "mt-1 w-full min-h-11 rounded-lg border border-gray-300 px-3";

/** คำขอเบิกเงิน (B3): อนุมัติ+จ่าย / ไม่อนุมัติ / บันทึกเบิกแทน / ประวัติล่าสุด */
export function SalaryAdvancesPanel({
  advances,
  employees,
  cashOnHand,
}: {
  advances: AdvanceView[];
  employees: { userId: string; name: string }[];
  cashOnHand: number | null;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showRecord, setShowRecord] = useState(false);
  const { confirm, confirmDialog } = useConfirm();
  const pending = advances.filter((a) => a.status === "pending");
  const history = advances.filter((a) => a.status !== "pending").slice(0, 15);

  function run(action: () => Promise<{ error: string | null }>, ok: string) {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const r = await action();
      if (r.error) setError(r.error);
      else {
        setNotice(ok);
        router.refresh();
      }
    });
  }

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4">
      {confirmDialog}
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-bold text-gray-900">
          คำขอเบิกเงิน {pending.length > 0 && <span className="ml-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-800">รออนุมัติ {pending.length}</span>}
        </h2>
        <button type="button" onClick={() => setShowRecord((v) => !v)} className="min-h-11 text-sm text-orange-600">
          {showRecord ? "ปิด" : "+ บันทึกเบิกแทนพนักงาน"}
        </button>
      </div>
      {cashOnHand !== null && (
        <p className="mt-1 text-xs text-gray-500">เงินสดในลิ้นชักตอนนี้ {baht(cashOnHand)} · จ่ายเงินสดได้ไม่เกินยอดนี้ (ปัดลงหลักร้อย)</p>
      )}
      {error && <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}
      {notice && <p className="mt-2 rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700" aria-live="polite">{notice}</p>}

      {showRecord && (
        <form
          action={(fd) => run(() => recordSalaryAdvanceForEmployeeAction(fd), "บันทึกการเบิกแล้ว")}
          className="mt-3 grid gap-3 rounded-lg border border-gray-200 p-3 sm:grid-cols-2"
        >
          <label className="text-xs font-medium text-gray-600">
            พนักงาน
            <select name="userId" required className={INPUT} style={{ fontSize: 16 }} defaultValue="">
              <option value="">— เลือก —</option>
              {employees.map((e) => (
                <option key={e.userId} value={e.userId}>{e.name}</option>
              ))}
            </select>
          </label>
          <label className="text-xs font-medium text-gray-600">
            จำนวนเงิน
            <input name="amount" type="number" min={1} step="0.01" required className={INPUT} style={{ fontSize: 16 }} />
          </label>
          <label className="text-xs font-medium text-gray-600">
            จ่ายทาง
            <select name="payMethod" defaultValue="cash" className={INPUT} style={{ fontSize: 16 }}>
              <option value="cash">เงินสดจากลิ้นชัก</option>
              <option value="transfer">โอน</option>
            </select>
          </label>
          <label className="text-xs font-medium text-gray-600">
            หมายเหตุ
            <input name="reason" maxLength={200} className={INPUT} style={{ fontSize: 16 }} />
          </label>
          <p className="text-[11px] text-gray-400 sm:col-span-2">ระบบตรวจเพดานเดียวกับที่พนักงานขอเอง (ไม่เกินค่าแรงจากวันที่มาแล้ว) และบันทึกเป็นรายจ่าย “เบิกเงินพนักงาน”</p>
          <Button type="submit" variant="primary" loading={isPending} className="min-h-11 text-sm sm:col-span-2">บันทึกและจ่ายแล้ว</Button>
        </form>
      )}

      {pending.length === 0 ? (
        <p className="mt-3 text-sm text-gray-400">ไม่มีคำขอรออนุมัติ</p>
      ) : (
        <ul className="mt-3 space-y-3">
          {pending.map((a) => (
            <li key={a.id} className="rounded-lg border border-amber-200 bg-amber-50/40 p-3">
              <p className="text-sm font-semibold text-gray-900">
                {a.name} ขอเบิก {baht(a.requestedAmount)}
              </p>
              <p className="text-xs text-gray-500">
                {a.createdAt.slice(0, 16).replace("T", " ")}
                {a.payMethod ? ` · ขอรับเป็น${a.payMethod === "cash" ? "เงินสด" : "เงินโอน"}` : ""}
                {a.reason ? ` · ${a.reason}` : ""}
              </p>
              <form
                action={(fd) => run(() => approveSalaryAdvanceAction(fd), "อนุมัติและบันทึกการจ่ายแล้ว")}
                className="mt-2 grid gap-2 sm:grid-cols-3"
              >
                <input type="hidden" name="id" value={a.id} />
                <label className="text-xs font-medium text-gray-600">
                  ยอดที่อนุมัติ
                  <input name="amount" type="number" min={1} max={a.requestedAmount} step="0.01" defaultValue={a.requestedAmount} className={INPUT} style={{ fontSize: 16 }} />
                </label>
                <label className="text-xs font-medium text-gray-600">
                  จ่ายทาง
                  <select name="payMethod" defaultValue={a.payMethod ?? "cash"} className={INPUT} style={{ fontSize: 16 }}>
                    <option value="cash">เงินสดจากลิ้นชัก</option>
                    <option value="transfer">โอน</option>
                  </select>
                  <span className="mt-1 block text-[11px] font-normal text-gray-400">เงินสดอนุมัติได้ไม่เกินเงินสดในลิ้นชัก</span>
                </label>
                <label className="text-xs font-medium text-gray-600 sm:col-span-3">
                  หมายเหตุถึงพนักงาน (ไม่บังคับ · ใช้เป็นเหตุผลเมื่อไม่อนุมัติ)
                  <input name="note" maxLength={200} className={INPUT} style={{ fontSize: 16 }} />
                </label>
                <div className="flex items-end gap-2 sm:col-span-3">
                  <Button type="submit" variant="primary" loading={isPending} className="min-h-11 flex-1 text-sm">อนุมัติ + จ่ายแล้ว</Button>
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={isPending}
                    className="min-h-11 text-sm"
                    onClick={async (e) => {
                      const form = e.currentTarget.form;
                      const note = (form?.elements.namedItem("note") as HTMLInputElement | null)?.value ?? "";
                      if (!(await confirm({ title: `ไม่อนุมัติคำขอของ ${a.name}?`, message: `ยอด ${baht(a.requestedAmount)} — พนักงานจะได้รับแจ้งเตือน${note ? ` · เหตุผล: ${note}` : ""}`, confirmLabel: "ไม่อนุมัติ", danger: true }))) return;
                      const fd = new FormData();
                      fd.set("id", a.id);
                      fd.set("note", note);
                      run(() => rejectSalaryAdvanceAction(fd), "บันทึกว่าไม่อนุมัติแล้ว");
                    }}
                  >
                    ไม่อนุมัติ
                  </Button>
                </div>
              </form>
            </li>
          ))}
        </ul>
      )}

      {history.length > 0 && (
        <details className="mt-3">
          <summary className="min-h-11 cursor-pointer py-2 text-sm text-gray-600">ประวัติล่าสุด ({history.length})</summary>
          <ul className="divide-y divide-gray-100">
            {history.map((a) => (
              <li key={a.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                <span className="min-w-0 truncate text-gray-700">
                  {a.name} · {baht(a.approvedAmount ?? a.requestedAmount)}
                  <span className="text-xs text-gray-400">
                    {a.paidDate ? ` · จ่าย ${a.paidDate} (${a.payMethod === "transfer" ? "โอน" : "เงินสด"}) · หักแล้ว ${baht(a.deducted)}` : ` · ${a.createdAt.slice(0, 10)}`}
                  </span>
                </span>
                <span className="shrink-0 text-xs text-gray-500">{ADVANCE_STATUS_LABEL[a.status]}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
