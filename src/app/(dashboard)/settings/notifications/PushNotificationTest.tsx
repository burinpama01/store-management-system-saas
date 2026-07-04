"use client";

import { useState, useTransition } from "react";
import { runPushNotificationTestAction } from "./actions";
import type { ActionFeedbackState } from "./feedback";
import { NotificationFeedbackDialog } from "./NotificationFeedbackDialog";
import { Button } from "@/shared/components/ui";

export function PushNotificationTest({ canRun }: { canRun: boolean }) {
  const [dialogFeedback, setDialogFeedback] = useState<ActionFeedbackState | null>(null);
  const [pending, start] = useTransition();

  function run() {
    start(() => {
      void (async () => {
        const r = await runPushNotificationTestAction();
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
          <p className="font-bold text-[var(--color-text-primary)]">ทดสอบ Push แอปมือถือ</p>
          <p className="mt-1 text-sm text-[var(--color-text-secondary)]">
            ส่งข้อความ [TEST] ไปทุกอุปกรณ์ที่ติดตั้งแอป StoreOS และล็อกอินร้านนี้
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
        <p className="mt-2 text-xs text-amber-700">
          ต้องมีสิทธิ์ notifications.manage และระบบต้องตั้งค่า Firebase แล้วจึงจะทดสอบได้
        </p>
      )}
      <NotificationFeedbackDialog
        feedback={dialogFeedback}
        onClose={() => setDialogFeedback(null)}
      />
    </div>
  );
}
