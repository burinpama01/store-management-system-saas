"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/shared/components/ui";
import { SERVICE_BUTTON_EMOJI, type ServiceButtonConfig } from "@/modules/qr-ordering/types";
import { updateServiceButtonsAction } from "./actions";

interface Props {
  serviceButtons: ServiceButtonConfig[];
  canEdit: boolean;
}

export function ServiceButtonsEditor({ serviceButtons, canEdit }: Props) {
  const router = useRouter();
  const [buttons, setButtons] = useState<ServiceButtonConfig[]>(serviceButtons);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function patch(key: string, next: Partial<ServiceButtonConfig>) {
    setButtons((prev) => prev.map((b) => (b.key === key ? { ...b, ...next } : b)));
  }

  function save() {
    setError(null);
    setMessage(null);
    startTransition(async () => {
      const res = await updateServiceButtonsAction(
        buttons.map((b) => ({ key: b.key, label: b.label, enabled: b.enabled })),
      );
      if (res.error) {
        setError(res.error);
        return;
      }
      setMessage("บันทึกปุ่มเรียกบริการแล้ว");
      router.refresh();
    });
  }

  return (
    <section className="rounded-md border border-[var(--color-border)] bg-white p-4">
      <div className="mb-3">
        <p className="text-xs font-bold uppercase tracking-wide text-[var(--color-text-muted)]">
          ปุ่มเรียกบริการ (หน้าลูกค้า)
        </p>
        <h2 className="mt-1 text-lg font-bold text-[var(--color-text-primary)]">
          ปุ่มเรียกพนักงาน / ขอน้ำ / ขอน้ำจิ้ม / เช็คบิล
        </h2>
        <p className="mt-1 text-sm text-[var(--color-text-secondary)]">
          แก้ข้อความปุ่มและเปิด/ปิดปุ่มที่ลูกค้าเห็นในหน้าสั่งอาหาร (แท็บ “ออร์เดอร์ของฉัน”)
        </p>
      </div>

      <div className="space-y-2">
        {buttons.map((btn) => (
          <div
            key={btn.key}
            className="flex flex-col gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-muted)] p-3 sm:flex-row sm:items-center"
          >
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-white text-lg">
              {SERVICE_BUTTON_EMOJI[btn.key]}
            </span>
            <input
              type="text"
              value={btn.label}
              maxLength={40}
              disabled={!canEdit}
              onChange={(e) => patch(btn.key, { label: e.target.value })}
              className="min-h-10 flex-1 rounded-md border border-[var(--color-border)] bg-white px-3 text-sm disabled:opacity-60"
            />
            <label className="inline-flex min-h-10 items-center gap-2 rounded-md bg-white px-3 text-sm font-medium text-[var(--color-text-secondary)]">
              <input
                type="checkbox"
                checked={btn.enabled}
                disabled={!canEdit}
                onChange={(e) => patch(btn.key, { enabled: e.target.checked })}
                className="h-4 w-4 rounded border-gray-300"
              />
              {btn.enabled ? "เปิดใช้งาน" : "ปิดอยู่"}
            </label>
          </div>
        ))}
      </div>

      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
      {message && <p className="mt-3 text-sm text-emerald-600" aria-live="polite">{message}</p>}

      {canEdit && (
        <div className="mt-4">
          <Button variant="primary" onClick={save} loading={isPending} className="min-h-10 px-4 text-sm">
            บันทึกปุ่มบริการ
          </Button>
        </div>
      )}
    </section>
  );
}
