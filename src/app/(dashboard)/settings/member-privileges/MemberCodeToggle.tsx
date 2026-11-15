"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useConfirm } from "@/shared/components/ui/useConfirm";
import { setMemberCodeEnabledAction } from "./actions";

export function MemberCodeToggle({ enabled, allowed }: { enabled: boolean; allowed: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const { confirm, confirmDialog } = useConfirm();
  return (
    <div className={`rounded-lg border p-4 ${enabled ? "border-emerald-300 bg-emerald-50" : "border-gray-200 bg-white"}`}>
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-gray-900">{enabled ? "เปิดใช้รหัสยืนยันสมาชิกอยู่" : "รหัสยืนยันสมาชิกปิดอยู่"}</p>
          <p className="text-xs text-gray-600">
            {enabled
              ? "ลูกค้าเห็นปุ่ม “แสดงรหัสใช้สิทธิ์” ในหน้าสมาชิก และแคชเชียร์ยืนยันรหัสได้ที่ POS (แผงลูกค้า)"
              : "ลูกค้ายังไม่เห็นปุ่มขอรหัส และ POS ยังไม่มีช่องยืนยันรหัส"}
          </p>
        </div>
        <button
          type="button"
          className={enabled ? "btn-secondary" : "btn-primary"}
          disabled={pending || (!enabled && !allowed)}
          onClick={async () => {
            if (
              enabled &&
              !(await confirm({
                title: "ปิดรหัสยืนยันสมาชิก?",
                message: "ลูกค้าจะขอรหัสไม่ได้ และแคชเชียร์จะยืนยันสมาชิกด้วยรหัสไม่ได้จนกว่าจะเปิดใหม่",
                confirmLabel: "ปิด",
                danger: true,
              }))
            ) {
              return;
            }
            setError(null);
            startTransition(async () => {
              const result = await setMemberCodeEnabledAction(!enabled);
              if (!result.ok) setError(result.error);
              else router.refresh();
            });
          }}
        >
          {pending ? "กำลังบันทึก…" : enabled ? "ปิด" : "เปิดใช้"}
        </button>
      </div>
      {error && <p className="mt-2 text-xs text-red-700" role="alert">{error}</p>}
      {confirmDialog}
    </div>
  );
}
