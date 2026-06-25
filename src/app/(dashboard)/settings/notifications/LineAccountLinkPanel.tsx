"use client";

import { useState } from "react";
import type { LineAccountLink, LineNotificationTarget } from "@/modules/notifications/repository";
import {
  runLineNotificationTestAction,
  unlinkLineAccountAction,
  unlinkLineNotificationTargetAction,
} from "./actions";
import type { ActionFeedbackState } from "./feedback";
import { NotificationFeedbackDialog } from "./NotificationFeedbackDialog";
import { Button, SubmitButton } from "@/shared/components/ui";

interface LineAccountLinkPanelProps {
  lineAccountLink: LineAccountLink | null;
  lineNotificationTarget: LineNotificationTarget | null;
  providerReady: boolean;
  addFriendUrl: string | null;
  officialAccountId: string | null;
  canManage: boolean;
  canManageLineGroup: boolean;
  canTestLine: boolean;
}

export function LineAccountLinkPanel({
  lineAccountLink,
  lineNotificationTarget,
  providerReady,
  addFriendUrl,
  officialAccountId,
  canManage,
  canManageLineGroup,
  canTestLine,
}: LineAccountLinkPanelProps) {
  const [dialogFeedback, setDialogFeedback] = useState<ActionFeedbackState | null>(null);
  const [pending, setPending] = useState(false);
  const linked = lineAccountLink?.status === "active";
  const groupLinked = lineNotificationTarget?.status === "active";
  const canRenderLineTest = canManage;
  const groupLabel = lineNotificationTarget?.targetType === "room" ? "multi-person chat" : "group";

  function runLineTest() {
    if (pending) return;
    setPending(true);
    void (async () => {
      try {
        const result = await runLineNotificationTestAction();
        const message = `${result.message} · ${new Date().toLocaleTimeString("th-TH")}`;
        setDialogFeedback({
          status: result.ok && !result.skipped ? "success" : "error",
          message,
          submittedAt: Date.now(),
        });
      } catch (error) {
        setDialogFeedback({
          status: "error",
          message: error instanceof Error ? error.message : "ส่ง LINE test ไม่สำเร็จ",
          submittedAt: Date.now(),
        });
      } finally {
        setPending(false);
      }
    })();
  }

  return (
    <div className="rounded-md border border-[var(--color-border)] bg-white p-4">
      <div className="grid gap-4 lg:grid-cols-[1.1fr_0.9fr]">
        <div>
          <p className="text-xs font-bold uppercase tracking-wide text-[var(--color-text-muted)]">
            ผูกบัญชี LINE
          </p>
          <h2 className="mt-1 text-lg font-bold text-[var(--color-text-primary)]">
            ผูก LINE เพื่อรับ notification ของร้าน
          </h2>
          <p className="mt-2 text-sm text-[var(--color-text-secondary)]">
            {linked ? "ผูก LINE แล้ว" : "ยังไม่ได้ผูก LINE"}
          </p>
          <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm text-[var(--color-text-secondary)]">
            <li>กด Add LINE เพื่อเพิ่ม StoreOS เป็นเพื่อน</li>
            <li>ส่งข้อความ “ผูกบัญชี” ใน LINE</li>
            <li>กด secure link ที่ bot ตอบกลับเพื่อยืนยันบัญชีนี้</li>
            <li>เพิ่ม StoreOS เข้ากลุ่ม แล้วให้ owner ส่งข้อความ “ผูกกลุ่ม” เพื่อใช้ LINE group / multi-person chat</li>
          </ol>
          {!providerReady && (
            <p className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              LINE provider ยังไม่พร้อม ตั้งค่า LINE_ADD_FRIEND_URL หรือ LINE_OFFICIAL_ACCOUNT_ID และ server env ให้ครบก่อนใช้งานจริง
            </p>
          )}
        </div>

        <div className="flex flex-col justify-between gap-3 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-muted)] p-4">
          <div>
            <p className="text-sm font-bold text-[var(--color-text-primary)]">
              {linked ? "LINE พร้อมรับแจ้งเตือน" : "เริ่มผูก LINE"}
            </p>
            <p className="mt-1 text-xs text-[var(--color-text-muted)]">
              {officialAccountId ? `บัญชีทางการ: ${officialAccountId}` : "ยังไม่ได้ตั้งค่า LINE_OFFICIAL_ACCOUNT_ID"}
            </p>
            <p className="mt-3 text-sm font-bold text-[var(--color-text-primary)]">
              {groupLinked ? `ผูก LINE ${groupLabel} แล้ว` : "ยังไม่ได้ผูก LINE group / multi-person chat"}
            </p>
            <p className="mt-1 text-xs text-[var(--color-text-muted)]">
              {groupLinked ? "การแจ้งเตือนจะส่งเข้ากลุ่มก่อนบัญชีส่วนตัว" : "ใช้คำสั่ง “ผูกกลุ่ม” ใน LINE group เพื่อเปิดรับแจ้งเตือนร่วมกัน"}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {addFriendUrl && (
              <a className="btn-primary" href={addFriendUrl} target="_blank" rel="noreferrer">
                Add LINE
              </a>
            )}
            {linked && canManage && (
              <form action={unlinkLineAccountAction}>
                <SubmitButton variant="secondary">
                  ยกเลิกการผูก LINE
                </SubmitButton>
              </form>
            )}
            {canRenderLineTest && (
              <Button
                variant="secondary"
                onClick={runLineTest}
                loading={pending}
                loadingText="กำลังทดสอบ..."
                disabled={!canTestLine}
                title="ส่ง LINE test"
              >
                ทดสอบ LINE
              </Button>
            )}
            {groupLinked && canManageLineGroup && (
              <form action={unlinkLineNotificationTargetAction}>
                <SubmitButton variant="secondary">
                  ยกเลิกการผูก LINE กลุ่ม
                </SubmitButton>
              </form>
            )}
          </div>
        </div>
      </div>
      <NotificationFeedbackDialog
        feedback={dialogFeedback}
        onClose={() => setDialogFeedback(null)}
      />
    </div>
  );
}
