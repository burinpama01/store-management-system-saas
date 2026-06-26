"use client";

import { useActionState } from "react";
import { Button } from "@/shared/components/ui";
import { submitEnterpriseRequest, type EnterpriseRequestState } from "./actions";

const INITIAL: EnterpriseRequestState = { error: null, notice: null };

export function EnterpriseRequestForm() {
  const [state, formAction, isPending] = useActionState(submitEnterpriseRequest, INITIAL);

  if (state.notice) {
    return (
      <div
        className="rounded-[var(--radius-md)] border border-emerald-200 bg-emerald-50 px-4 py-6 text-center text-sm text-emerald-700"
        role="status"
      >
        <p className="text-base font-bold">ขอบคุณสำหรับความสนใจ 🎉</p>
        <p className="mt-2">{state.notice}</p>
      </div>
    );
  }

  return (
    <form action={formAction} className="space-y-4">
      {state.error && (
        <p className="alert-danger" role="alert">{state.error}</p>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1">
          <label htmlFor="companyName" className="field-label">ชื่อบริษัท/องค์กร *</label>
          <input
            id="companyName"
            name="companyName"
            type="text"
            required
            maxLength={150}
            disabled={isPending}
            placeholder="เช่น Caramel Group"
            className="form-input disabled:opacity-50"
          />
        </div>
        <div className="space-y-1">
          <label htmlFor="contactName" className="field-label">ชื่อผู้ติดต่อ *</label>
          <input
            id="contactName"
            name="contactName"
            type="text"
            required
            maxLength={120}
            disabled={isPending}
            placeholder="ชื่อ-นามสกุล"
            className="form-input disabled:opacity-50"
          />
        </div>
        <div className="space-y-1">
          <label htmlFor="email" className="field-label">อีเมล *</label>
          <input
            id="email"
            name="email"
            type="email"
            required
            autoComplete="email"
            disabled={isPending}
            placeholder="you@example.com"
            className="form-input disabled:opacity-50"
          />
        </div>
        <div className="space-y-1">
          <label htmlFor="phone" className="field-label">เบอร์โทร</label>
          <input
            id="phone"
            name="phone"
            type="tel"
            maxLength={40}
            disabled={isPending}
            placeholder="08x-xxx-xxxx"
            className="form-input disabled:opacity-50"
          />
        </div>
        <div className="space-y-1">
          <label htmlFor="branchCount" className="field-label">จำนวนสาขา (โดยประมาณ)</label>
          <input
            id="branchCount"
            name="branchCount"
            type="number"
            min={0}
            step={1}
            disabled={isPending}
            placeholder="เช่น 10"
            className="form-input disabled:opacity-50"
          />
        </div>
      </div>

      <div className="space-y-1">
        <label htmlFor="message" className="field-label">รายละเอียดความต้องการ</label>
        <textarea
          id="message"
          name="message"
          rows={4}
          maxLength={2000}
          disabled={isPending}
          placeholder="เล่าให้เราฟังเกี่ยวกับธุรกิจของคุณ จำนวนสาขา ระบบที่ต้องการเชื่อมต่อ หรือคำถามอื่น ๆ"
          className="form-input disabled:opacity-50"
        />
      </div>

      <Button
        type="submit"
        variant="primary"
        loading={isPending}
        loadingText="กำลังส่งคำขอ..."
        className="w-full disabled:cursor-not-allowed disabled:opacity-50"
      >
        ส่งคำขอใช้งาน Enterprise
      </Button>

      <p className="text-center text-xs text-[var(--muted)]">
        เราจะใช้ข้อมูลนี้เพื่อติดต่อกลับเรื่องแพ็กเกจ Enterprise เท่านั้น
      </p>
    </form>
  );
}
