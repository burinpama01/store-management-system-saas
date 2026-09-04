"use client";

// P9 (v0.44.7) — ปุ่มยืนยันบันทึก "คำเรียกตัวเลือก" ที่เพิ่งเกิดขึ้นในรอบนี้
//
// แสดงเฉพาะเมื่อ:
//   - ผู้ใช้พูดคำที่ระบบจับคู่ไม่ได้ แล้ว "เลือกตัวเลือกเองบนจอ" (คนตัดสิน ไม่ใช่ระบบเดา)
//   - ผู้ใช้มีสิทธิ์ settings.manage_store
// ไม่มีการบันทึกอัตโนมัติ ไม่มีการนับความถี่ และปิดไปแล้วคือหายเลย (ไม่มีตาราง pending)

import { useActionState, useState } from "react";
import { Button } from "@/shared/components/ui";
import { saveOptionAliasAction } from "./actions";
import type { VoiceOptionAliasProposal } from "@/modules/voice-pos/alias-proposal";

const INITIAL = { error: null as string | null, success: null as string | null };

export function VoiceOptionAliasReview({
  proposal,
  onDismiss,
}: {
  readonly proposal: VoiceOptionAliasProposal;
  readonly onDismiss: () => void;
}) {
  const [state, action, pending] = useActionState(saveOptionAliasAction, INITIAL);
  const [saved, setSaved] = useState(false);

  if (saved || state.success) {
    return (
      <p role="status" className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
        {state.success ?? `บันทึกคำเรียก "${proposal.phrase}" แล้ว`}
      </p>
    );
  }

  return (
    <form
      action={action}
      onSubmit={() => setSaved(false)}
      data-testid="voice-option-alias-review"
      className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"
    >
      <input type="hidden" name="aliasText" value={proposal.phrase} />
      <input type="hidden" name="productId" value={proposal.productId} />
      <input type="hidden" name="modifierGroupId" value={proposal.modifierGroupId} />
      <input type="hidden" name="optionId" value={proposal.optionId} />

      <p className="mb-2">
        จำไว้ไหมว่า “{proposal.phrase}” ของ {proposal.productName} หมายถึง{" "}
        <strong>{proposal.optionName}</strong>? ครั้งหน้าจะได้พูดสั้น ๆ ได้เลย
      </p>
      {state.error ? (
        <p role="alert" className="mb-2 text-xs text-red-700">
          {state.error}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="primary" loading={pending} loadingText="กำลังบันทึก…" className="min-h-11">
          บันทึกคำเรียกนี้
        </Button>
        <Button type="button" variant="secondary" onClick={onDismiss} className="min-h-11">
          ไม่ต้อง
        </Button>
      </div>
    </form>
  );
}
