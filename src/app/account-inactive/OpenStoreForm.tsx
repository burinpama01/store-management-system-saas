"use client";

import { useActionState, useState } from "react";
import { SubmitButton } from "@/shared/components/ui";
import { openOwnStoreAction, type OpenStoreState } from "./actions";

const INPUT = "mt-1 w-full min-h-11 rounded-lg border border-[var(--line)] bg-white px-3";

export function OpenStoreForm() {
  const [open, setOpen] = useState(false);
  const [state, formAction] = useActionState<OpenStoreState, FormData>(openOwnStoreAction, { error: null });

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="btn-primary w-full min-h-11">
        เปิดร้านของตัวเอง
      </button>
    );
  }
  return (
    <form action={formAction} className="space-y-3 rounded-lg border border-[var(--line)] p-4 text-left">
      <p className="text-sm font-semibold text-[var(--ink)]">เปิดร้านของตัวเองด้วยบัญชีนี้</p>
      <label className="block text-xs font-medium text-[var(--ink-2)]">
        ชื่อกิจการ
        <input name="organizationName" required minLength={2} maxLength={100} className={INPUT} style={{ fontSize: 16 }} />
      </label>
      <label className="block text-xs font-medium text-[var(--ink-2)]">
        ชื่อร้าน (สาขาแรก)
        <input name="storeName" maxLength={100} placeholder="ว่าง = ใช้ชื่อกิจการ" className={INPUT} style={{ fontSize: 16 }} />
      </label>
      {state.error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{state.error}</p>}
      <SubmitButton variant="primary" className="w-full">สร้างร้านแล้วเลือกแพ็กเกจ</SubmitButton>
      <p className="text-[11px] text-[var(--ink-3)]">ร้านใหม่แยกจากร้านเดิมทั้งหมด ไม่เห็นข้อมูลของร้านเดิม</p>
    </form>
  );
}
