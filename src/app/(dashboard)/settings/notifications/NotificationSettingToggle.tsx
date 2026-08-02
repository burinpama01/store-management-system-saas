"use client";

import { useActionState, useRef, useState } from "react";
import type { NotificationChannel, NotificationType } from "@/modules/notifications/types";
import { toggleNotificationSettingAction } from "./actions";
import {
  INITIAL_ACTION_FEEDBACK_STATE,
} from "./feedback";
import { NotificationFeedbackDialog } from "./NotificationFeedbackDialog";

interface Props {
  type: NotificationType;
  channel: NotificationChannel;
  configured: boolean;
  enabled: boolean;
  canManage: boolean;
  settingsLoadFailed: boolean;
}

export function NotificationSettingToggle({
  type,
  channel,
  configured,
  enabled,
  canManage,
  settingsLoadFailed,
}: Props) {
  const [state, formAction, pending] = useActionState(
    toggleNotificationSettingAction,
    INITIAL_ACTION_FEEDBACK_STATE,
  );
  const formRef = useRef<HTMLFormElement>(null);
  const [optimisticEnabled, setOptimisticEnabled] = useState<boolean | null>(null);
  const [dismissedAt, setDismissedAt] = useState(0);
  const disabled = !canManage || settingsLoadFailed || pending;
  const checked =
    state.status === "error" && !pending ? configured : optimisticEnabled ?? configured;
  const dialogFeedback =
    state.status === "error" && state.submittedAt !== dismissedAt ? state : null;

  return (
    <>
      <form
        ref={formRef}
        action={formAction}
        aria-busy={pending}
        className="flex items-center gap-3"
      >
        <input type="hidden" name="type" value={type} />
        <input type="hidden" name="channel" value={channel} />
        <label className="flex min-h-11 items-center gap-2">
          <input
            type="checkbox"
            name="enabled"
            checked={checked}
            onChange={(event) => {
              setOptimisticEnabled(event.currentTarget.checked);
              formRef.current?.requestSubmit();
            }}
            disabled={disabled}
            className="h-4 w-4 accent-teal-700 disabled:cursor-not-allowed"
          />
          <span
            className={
              checked && enabled
                ? "rounded-md bg-emerald-50 px-2 py-1 text-xs font-bold text-emerald-700"
                : checked
                  ? "rounded-md bg-slate-100 px-2 py-1 text-xs font-bold text-slate-500"
                  : "rounded-md bg-amber-50 px-2 py-1 text-xs font-bold text-amber-700"
            }
          >
            {checked && enabled ? "พร้อมส่ง" : checked ? "ยังไม่พร้อม" : "ปิดไว้"}
          </span>
        </label>
        {canManage && !settingsLoadFailed && (
          <span
            aria-live="polite"
            className={`text-xs font-semibold ${
              state.status === "error" ? "text-red-700" : "text-[var(--color-text-muted)]"
            }`}
          >
            {pending
              ? "กำลังบันทึก..."
              : state.status === "success"
                ? "บันทึกแล้ว"
                : state.status === "error"
                  ? "บันทึกไม่สำเร็จ"
                  : "บันทึกอัตโนมัติ"}
          </span>
        )}
      </form>

      <NotificationFeedbackDialog
        feedback={dialogFeedback}
        onClose={() => setDismissedAt(state.submittedAt)}
      />
    </>
  );
}
