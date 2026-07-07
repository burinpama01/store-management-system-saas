"use client";

import { useActionState, useState } from "react";
import type { NotificationType } from "@/modules/notifications/types";
import { saveNotificationTemplateAction } from "./actions";
import { INITIAL_ACTION_FEEDBACK_STATE } from "./feedback";
import { NotificationFeedbackDialog } from "./NotificationFeedbackDialog";
import { Button } from "@/shared/components/ui";

interface Props {
  type: NotificationType;
  defaultTitle: string;
  defaultMessage: string;
  vars: string[];
  currentTitle: string | null;
  currentMessage: string | null;
  canManage: boolean;
}

export function NotificationTemplateEditor({
  type,
  defaultTitle,
  defaultMessage,
  vars,
  currentTitle,
  currentMessage,
  canManage,
}: Props) {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState(
    saveNotificationTemplateAction,
    INITIAL_ACTION_FEEDBACK_STATE,
  );
  const [dismissedAt, setDismissedAt] = useState(0);
  const dialogFeedback =
    state.status !== "idle" && state.submittedAt !== dismissedAt ? state : null;
  const hasCustom = Boolean(currentTitle || currentMessage);

  if (!canManage) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="mt-1 inline-flex items-center gap-1 text-xs font-bold text-teal-700 hover:underline"
      >
        ✏️ แก้ข้อความ
        {hasCustom && (
          <span className="rounded bg-teal-50 px-1.5 py-0.5 text-[10px] text-teal-700">
            กำหนดเอง
          </span>
        )}
      </button>

      {open && (
        <form
          action={formAction}
          className="mt-2 space-y-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-muted)] p-3"
        >
          <input type="hidden" name="type" value={type} />
          <div>
            <label className="block text-[11px] font-bold text-[var(--color-text-muted)]">
              หัวข้อ
            </label>
            <input
              type="text"
              name="title"
              defaultValue={currentTitle ?? ""}
              placeholder={defaultTitle}
              maxLength={200}
              className="mt-1 w-full rounded-md border border-[var(--color-border)] px-2 py-1.5 text-sm"
            />
          </div>
          <div>
            <label className="block text-[11px] font-bold text-[var(--color-text-muted)]">
              ข้อความ
            </label>
            <textarea
              name="message"
              defaultValue={currentMessage ?? ""}
              placeholder={defaultMessage}
              maxLength={500}
              rows={2}
              className="mt-1 w-full rounded-md border border-[var(--color-border)] px-2 py-1.5 text-sm"
            />
          </div>
          <p className="text-[11px] text-[var(--color-text-muted)]">
            ตัวแปรที่ใช้ได้:{" "}
            {vars.map((v) => (
              <code
                key={v}
                className="mr-1 rounded bg-white px-1 py-0.5 text-[10px] text-teal-700"
              >{`{${v}}`}</code>
            ))}
            <span className="ml-1">— ชื่อร้านจะถูกเติมนำหน้าหัวข้อให้อัตโนมัติ</span>
          </p>
          <div className="flex items-center gap-2">
            <Button
              type="submit"
              loading={pending}
              loadingText="กำลังบันทึก..."
              className="min-h-9 rounded-md bg-teal-700 px-3 text-xs font-bold text-white hover:bg-teal-800"
            >
              บันทึกข้อความ
            </Button>
            <span className="text-[11px] text-[var(--color-text-muted)]">
              เว้นว่างทั้งสองช่อง = ใช้ข้อความเริ่มต้น
            </span>
          </div>
        </form>
      )}

      <NotificationFeedbackDialog
        feedback={dialogFeedback}
        onClose={() => setDismissedAt(state.submittedAt)}
      />
    </>
  );
}
