"use client";

import { useActionState, useState } from "react";
import { saveTelegramChatIdAction } from "./actions";
import {
  INITIAL_ACTION_FEEDBACK_STATE,
} from "./feedback";
import { NotificationFeedbackDialog } from "./NotificationFeedbackDialog";

interface Props {
  telegramChatId: string;
  canManageTelegramTarget: boolean;
  telegramTargetLoadFailed: boolean;
}

export function TelegramChatIdForm({
  telegramChatId,
  canManageTelegramTarget,
  telegramTargetLoadFailed,
}: Props) {
  const [state, formAction, pending] = useActionState(
    saveTelegramChatIdAction,
    INITIAL_ACTION_FEEDBACK_STATE,
  );
  const [dismissedAt, setDismissedAt] = useState(0);
  const disabled = !canManageTelegramTarget || telegramTargetLoadFailed || pending;
  const dialogFeedback =
    state.status !== "idle" && state.submittedAt !== dismissedAt ? state : null;

  return (
    <>
      <form action={formAction} className="space-y-3 rounded-md bg-[var(--color-surface-muted)] p-4">
        <label className="block text-sm font-bold text-[var(--color-text-primary)]" htmlFor="telegramChatId">
          Telegram chat ID
        </label>
        <input
          id="telegramChatId"
          name="telegramChatId"
          defaultValue={telegramChatId}
          placeholder="-1001234567890"
          disabled={disabled}
          className="min-h-11 w-full rounded-md border border-[var(--color-border)] bg-white px-3 text-sm text-[var(--color-text-primary)] disabled:cursor-not-allowed disabled:opacity-60"
        />
        {!canManageTelegramTarget && (
          <p className="text-xs text-amber-700">ต้องเป็น owner จึงจะแก้ Telegram chat ID ได้</p>
        )}
        {telegramTargetLoadFailed && (
          <p className="text-xs text-red-700">โหลด Telegram target ไม่สำเร็จ</p>
        )}
        <button
          type="submit"
          disabled={disabled}
          className="btn-primary min-h-11 w-full text-sm disabled:opacity-40"
        >
          {pending ? "กำลังบันทึก..." : "บันทึก Telegram chat ID"}
        </button>
      </form>

      <NotificationFeedbackDialog
        feedback={dialogFeedback}
        onClose={() => setDismissedAt(state.submittedAt)}
      />
    </>
  );
}
