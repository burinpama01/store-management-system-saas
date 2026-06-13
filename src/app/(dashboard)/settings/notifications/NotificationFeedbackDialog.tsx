"use client";

import { ModalDialog } from "@/shared/components/ui";
import type { ActionFeedbackState } from "./feedback";

interface Props {
  feedback: ActionFeedbackState | null;
  onClose: () => void;
}

export function NotificationFeedbackDialog({ feedback, onClose }: Props) {
  if (!feedback || feedback.status === "idle") return null;

  const isSuccess = feedback.status === "success";

  return (
    <ModalDialog
      open
      title={isSuccess ? "ดำเนินการสำเร็จ" : "ดำเนินการไม่สำเร็จ"}
      onClose={onClose}
      size="sm"
    >
      <div
        role="alert"
        className={`rounded-md border px-3 py-2 text-sm ${
          isSuccess
            ? "border-emerald-200 bg-emerald-50 text-emerald-700"
            : "border-red-200 bg-red-50 text-red-700"
        }`}
      >
        {feedback.message}
      </div>
      <div className="flex justify-end">
        <button type="button" onClick={onClose} className="btn-secondary text-xs">
          ปิด
        </button>
      </div>
    </ModalDialog>
  );
}
