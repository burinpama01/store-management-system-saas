"use client";

import { useState, useTransition } from "react";
import { useConfirm } from "@/shared/components/ui/useConfirm";
import { setConsignmentEnabledAction } from "./actions";

export function ConsignmentToggle({ enabled, canToggle }: { enabled: boolean; canToggle: boolean }) {
  const { confirm, confirmDialog } = useConfirm();
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [isPending, startTransition] = useTransition();

  async function toggle(next: boolean) {
    if (!next) {
      const ok = await confirm({
        title: "ปิดสินค้าซื้อขาด/ฝากขาย?",
        message: "ข้อมูลเจ้าของสินค้ายังอยู่ครบ เปิดใหม่ได้ภายหลัง",
        confirmLabel: "ปิด",
        danger: true,
      });
      if (!ok) return;
    }
    startTransition(async () => {
      const result = await setConsignmentEnabledAction(next);
      setMessage(
        result.error
          ? { tone: "error", text: result.error }
          : { tone: "ok", text: next ? "เปิดแล้ว — เริ่มจากเพิ่มเจ้าของสินค้าด้านล่าง" : "ปิดแล้ว" },
      );
    });
  }

  return (
    <div className="space-y-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="font-semibold text-[var(--ink)]">สถานะสาขานี้: {enabled ? "เปิดใช้งาน" : "ปิดอยู่"}</p>
          <p className="mt-0.5 text-sm text-[var(--muted)]">
            {canToggle ? "เปิดเพื่อเริ่มตั้งเมนูซื้อมาขาย/รับฝากขาย" : "เจ้าของหรือแอดมินเป็นคนเปิด/ปิด"}
          </p>
        </div>
        {canToggle && (
          <button
            type="button"
            className={enabled ? "btn-secondary min-h-11" : "btn-primary min-h-11"}
            disabled={isPending}
            onClick={() => toggle(!enabled)}
          >
            {enabled ? "ปิดใช้งาน" : "เปิดใช้งาน"}
          </button>
        )}
      </div>
      <p className="text-sm text-[var(--muted)]">ตอนนี้เตรียมรายชื่อเจ้าของสินค้าได้ก่อน · ตั้งเมนู รับของ และเคลียร์เงินจะตามมาในรุ่นถัดไป</p>
      {message && (
        <p role="status" className={`rounded-lg px-3 py-2 text-sm ${message.tone === "ok" ? "bg-green-50 text-green-800" : "bg-red-50 text-red-700"}`}>
          {message.text}
        </p>
      )}
      {confirmDialog}
    </div>
  );
}
