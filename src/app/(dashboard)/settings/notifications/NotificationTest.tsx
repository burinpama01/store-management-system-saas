"use client";

import { useState, useTransition } from "react";
import { runTelegramNotificationTestAction } from "./actions";
import type { ActionFeedbackState } from "./feedback";
import { NotificationFeedbackDialog } from "./NotificationFeedbackDialog";
import { Button } from "@/shared/components/ui";

export function NotificationTest({ canRun }: { canRun: boolean }) {
  const [dialogFeedback, setDialogFeedback] = useState<ActionFeedbackState | null>(null);
  const [pending, start] = useTransition();

  function run() {
    start(() => {
      void (async () => {
        const r = await runTelegramNotificationTestAction();
        const message = `${r.message} · ${new Date().toLocaleTimeString("th-TH")}`;
        setDialogFeedback({
          status: r.ok && !r.skipped ? "success" : "error",
          message,
          submittedAt: Date.now(),
        });
      })();
    });
  }

  return (
    <div className="rounded-md border border-[var(--color-border)] bg-white p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-bold text-[var(--color-text-primary)]">ทดสอบส่งการแจ้งเตือน</p>
          <p className="mt-1 text-sm text-[var(--color-text-secondary)]">
            ส่งข้อความ [TEST] ผ่าน Telegram group ของ tenant ปัจจุบัน
          </p>
        </div>
        <Button
          variant="secondary"
          onClick={run}
          loading={pending}
          loadingText="กำลังทดสอบ..."
          disabled={!canRun}
          className="shrink-0 text-xs disabled:opacity-40"
        >
          ทดสอบ
        </Button>
      </div>
      {!canRun && (
        <p className="mt-2 text-xs text-amber-700">ต้องมีสิทธิ์ notifications.manage, ตั้งค่า Telegram group และบันทึก chat ID ก่อนจึงจะทดสอบได้</p>
      )}
      <NotificationFeedbackDialog
        feedback={dialogFeedback}
        onClose={() => setDialogFeedback(null)}
      />
    </div>
  );
}
