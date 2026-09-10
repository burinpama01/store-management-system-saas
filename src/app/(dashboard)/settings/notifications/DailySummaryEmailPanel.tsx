"use client";

import { useActionState, useRef, useState } from "react";
import { setDailySummaryEmailEnabledAction } from "./actions";
import { INITIAL_ACTION_FEEDBACK_STATE } from "./feedback";

interface Props {
  storeEnabled: boolean;
  canManage: boolean;
}

/**
 * สวิตช์อีเมลสรุปยอดรายวันของร้านนี้
 *
 * อีเมลออกวันละครั้งตอนเช้า ส่งถึง "เจ้าขององค์กร" เท่านั้น และส่งเฉพาะวันที่ร้านมีการขายจริง
 * — ร้านที่ปิดวันนั้นจะไม่มีอีเมล ไม่ใช่อีเมลยอดศูนย์
 */
export function DailySummaryEmailPanel({ storeEnabled, canManage }: Props) {
  const [state, formAction, pending] = useActionState(
    setDailySummaryEmailEnabledAction,
    INITIAL_ACTION_FEEDBACK_STATE,
  );
  const formRef = useRef<HTMLFormElement>(null);
  const [optimistic, setOptimistic] = useState<boolean | null>(null);
  const checked = state.status === "error" && !pending ? storeEnabled : optimistic ?? storeEnabled;

  return (
    <div className="rounded-md border border-[var(--color-border)] bg-white p-4">
      <h2 className="text-base font-bold text-[var(--color-text-primary)]">📧 อีเมลสรุปยอดรายวัน</h2>
      <p className="mt-1 text-sm text-[var(--color-text-muted)]">
        ส่งสรุปยอดขายของเมื่อวาน (ยอดรวม จำนวนบิล ช่องทาง การชำระ เมนูขายดี) ถึงอีเมลเจ้าขององค์กรทุกเช้า
        — ส่งเฉพาะวันที่ร้านมีออเดอร์ ถ้าวันไหนไม่มีการขายจะไม่มีอีเมล
      </p>

      <form ref={formRef} action={formAction} aria-busy={pending} className="mt-3">
        <label className="flex min-h-11 items-center gap-2">
          <input
            type="checkbox"
            name="enabled"
            checked={checked}
            onChange={(event) => {
              setOptimistic(event.currentTarget.checked);
              formRef.current?.requestSubmit();
            }}
            disabled={!canManage || pending}
            className="h-4 w-4 accent-teal-700 disabled:cursor-not-allowed"
          />
          <span className="text-sm font-semibold text-[var(--color-text-primary)]">
            รวมร้านนี้ในอีเมลสรุปยอดรายวัน
          </span>
        </label>
        <span
          aria-live="polite"
          className={`mt-1 block text-xs font-semibold ${
            state.status === "error" ? "text-red-700" : "text-[var(--color-text-muted)]"
          }`}
        >
          {pending
            ? "กำลังบันทึก..."
            : state.status === "error"
              ? state.message
              : state.status === "success"
                ? "บันทึกแล้ว"
                : "บันทึกอัตโนมัติ"}
        </span>
      </form>

      <p className="mt-3 border-t border-[var(--color-border)] pt-3 text-xs text-[var(--color-text-muted)]">
        อยากได้สรุปทาง LINE/Telegram ทันทีตอนปิดร้าน ให้เปิดหัวข้อ &quot;สรุปยอดประจำวัน (ตอนคนสุดท้ายออกงาน)&quot;
        ในตารางด้านล่าง — ระบบจะส่งสรุปของวันนั้นเมื่อ<b>คนสุดท้ายของสาขากดออกงาน</b> (คนอื่นที่ออกก่อนจะไม่ยิงซ้ำ)
      </p>
    </div>
  );
}
