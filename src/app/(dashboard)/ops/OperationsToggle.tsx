"use client";

// ใช้ร่วม: หน้า /ops/templates และ /settings/operations

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useConfirm } from "@/shared/components/ui/useConfirm";
import { setOperationsEnabledAction } from "./actions";

export function OperationsToggle({ enabled, hasActiveTemplate }: { enabled: boolean; hasActiveTemplate: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const { confirm, confirmDialog } = useConfirm();
  return (
    <div className={`rounded-lg border p-4 ${enabled ? "border-emerald-300 bg-emerald-50" : "border-gray-200 bg-white"}`}>
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-gray-900">{enabled ? "เปิดใช้ระบบงานหน้าร้านอยู่" : "ระบบงานหน้าร้านปิดอยู่"}</p>
          <p className="text-xs text-gray-600">
            {enabled
              ? "พนักงานเห็นเมนู งานหน้าร้าน, ผู้รับผิดชอบออกงานไม่ได้จนกว่าจะส่ง, เจ้าของได้รับแจ้งทุกช่องทาง"
              : "ตั้งค่าเช็กลิสต์ได้เต็มที่ระหว่างปิด — พนักงานยังไม่เห็น ไม่ถูกบล็อกออกงาน และไม่มีแจ้งเตือน จนกว่าจะกดเปิดใช้"}
          </p>
          {!enabled && !hasActiveTemplate && <p className="mt-1 text-xs text-amber-700">ยังไม่มีเช็กลิสต์ที่ “ใช้งาน”</p>}
        </div>
        <button
          type="button"
          className={enabled ? "btn-secondary" : "btn-primary"}
          disabled={pending}
          onClick={async () => {
            if (
              enabled &&
              !(await confirm({
                title: "ปิดระบบงานหน้าร้าน?",
                message: "พนักงานจะไม่เห็นเช็กลิสต์ ไม่ถูกบล็อกตอนออกงาน และเจ้าของจะไม่ได้รับแจ้งเลยกำหนด",
                confirmLabel: "ปิดระบบ",
                danger: true,
              }))
            ) {
              return;
            }
            setError(null);
            startTransition(async () => {
              const result = await setOperationsEnabledAction(!enabled);
              if (!result.ok) setError(result.error);
              else router.refresh();
            });
          }}
        >
          {pending ? "กำลังบันทึก…" : enabled ? "ปิดระบบ" : "เปิดใช้"}
        </button>
      </div>
      {error && <p className="mt-2 text-xs text-red-700" role="alert">{error}</p>}
      {confirmDialog}
    </div>
  );
}
