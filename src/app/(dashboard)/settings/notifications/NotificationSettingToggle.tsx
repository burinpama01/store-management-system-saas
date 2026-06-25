"use client";

import { useActionState, useState } from "react";
import type { NotificationChannel, NotificationType } from "@/modules/notifications/types";
import { toggleNotificationSettingAction } from "./actions";
import {
  INITIAL_ACTION_FEEDBACK_STATE,
} from "./feedback";
import { NotificationFeedbackDialog } from "./NotificationFeedbackDialog";
import { Button } from "@/shared/components/ui";

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
  const [dismissedAt, setDismissedAt] = useState(0);
  const disabled = !canManage || settingsLoadFailed || pending;
  const dialogFeedback =
    state.status !== "idle" && state.submittedAt !== dismissedAt ? state : null;

  return (
    <>
      <form action={formAction} className="flex items-center gap-3">
        <input type="hidden" name="type" value={type} />
        <input type="hidden" name="channel" value={channel} />
        <label className="flex min-h-11 items-center gap-2">
          <input
            type="checkbox"
            name="enabled"
            defaultChecked={configured}
            disabled={disabled}
            className="h-4 w-4 accent-teal-700 disabled:cursor-not-allowed"
          />
          <span
            className={
              enabled
                ? "rounded-md bg-emerald-50 px-2 py-1 text-xs font-bold text-emerald-700"
                : configured
                  ? "rounded-md bg-slate-100 px-2 py-1 text-xs font-bold text-slate-500"
                  : "rounded-md bg-amber-50 px-2 py-1 text-xs font-bold text-amber-700"
            }
          >
            {enabled ? "พร้อมส่ง" : configured ? "ยังไม่พร้อม" : "ปิดไว้"}
          </span>
        </label>
        {canManage && !settingsLoadFailed && (
          <Button
            type="submit"
            loading={pending}
            loadingText="กำลังบันทึก..."
            className="min-h-11 rounded-md border border-[var(--color-border)] px-3 text-xs font-bold text-[var(--color-text-primary)] hover:bg-[var(--color-surface-muted)] disabled:opacity-40"
          >
            บันทึก
          </Button>
        )}
      </form>

      <NotificationFeedbackDialog
        feedback={dialogFeedback}
        onClose={() => setDismissedAt(state.submittedAt)}
      />
    </>
  );
}
