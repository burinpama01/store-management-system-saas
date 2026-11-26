"use client";

import { useActionState } from "react";
import { approveDeviceLoginAction, denyDeviceLoginAction, type ApproveState } from "./actions";

const INITIAL: ApproveState = { error: null, done: null };

export function ApproveDeviceForm({ requestId, shortCode }: { requestId: string; shortCode: string }) {
  const [approveState, approve, approving] = useActionState(approveDeviceLoginAction, INITIAL);
  const [denyState, deny, denying] = useActionState(denyDeviceLoginAction, INITIAL);

  if (approveState.done === "approved") {
    return <p className="mt-4 rounded-lg bg-emerald-50 p-3 text-sm font-semibold text-emerald-700">อนุญาตแล้ว — เครื่องร้านจะเข้าสู่ระบบเองภายในไม่กี่วินาที</p>;
  }
  if (denyState.done === "denied") {
    return <p className="mt-4 rounded-lg bg-gray-100 p-3 text-sm text-gray-700">ปฏิเสธแล้ว — เครื่องร้านจะสร้าง QR ใหม่</p>;
  }

  return (
    <div className="mt-3 space-y-3">
      <form action={approve} className="space-y-3">
        <input type="hidden" name="requestId" value={requestId} />
        <input type="hidden" name="shortCode" value={shortCode} />
        <label className="block text-sm font-medium text-gray-700">
          รหัสพนักงานของคุณ
          <input
            name="employeeCode"
            required
            autoComplete="off"
            autoCapitalize="characters"
            inputMode="text"
            maxLength={30}
            className="mt-1 block min-h-11 w-full rounded-lg border border-gray-300 px-3 uppercase tracking-wider"
            style={{ fontSize: 16 }}
            placeholder="เช่น EMP-014"
          />
        </label>
        {approveState.error && <p role="alert" className="text-sm text-red-600">{approveState.error}</p>}
        <button type="submit" disabled={approving || denying} className="min-h-11 w-full rounded-lg bg-gray-900 font-bold text-white disabled:opacity-60">
          {approving ? "กำลังอนุญาต…" : "อนุญาต"}
        </button>
      </form>
      <form action={deny}>
        <input type="hidden" name="requestId" value={requestId} />
        <button type="submit" disabled={approving || denying} className="min-h-11 w-full rounded-lg border border-gray-300 font-semibold text-gray-700 disabled:opacity-60">
          ไม่ใช่ฉัน / ไม่อนุญาต
        </button>
      </form>
      <p className="text-xs text-gray-500">ไม่มีรหัสพนักงาน? ให้เจ้าของร้านตั้งให้ที่หน้า &quot;พนักงาน&quot;</p>
    </div>
  );
}
