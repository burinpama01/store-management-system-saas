"use client";

import { useActionState, useState } from "react";
import type { PaymentProviderConfigPublic } from "@/modules/payments/types";
import { saveTrueMoneyManualConfigAction, disableTrueMoneyManualConfigAction } from "./actions";

export function PaymentIntegrationsManager({
  configs,
}: {
  configs: PaymentProviderConfigPublic[];
}) {
  const tm = configs.find((c) => c.providerKey === "truemoney" && c.mode === "manual");
  const [enabled, setEnabled] = useState(Boolean(tm?.isEnabled && !tm.disabledAt));
  const [state, formAction, pending] = useActionState(saveTrueMoneyManualConfigAction, {
    error: null as string | null,
    ok: false,
  });
  const [disableError, setDisableError] = useState<string | null>(null);
  const [disabling, setDisabling] = useState(false);

  async function onDisable() {
    setDisabling(true);
    setDisableError(null);
    const res = await disableTrueMoneyManualConfigAction();
    setDisabling(false);
    if (res.error) setDisableError(res.error);
    else setEnabled(false);
  }

  return (
    <div className="space-y-4">
      <div className="panel p-4 space-y-2">
        <h2 className="text-sm font-bold text-[var(--color-text-primary)]">
          ชำระเงินลูกค้า (Payment Gateway)
        </h2>
        <p className="text-xs text-[var(--color-text-muted)]">
          เชื่อมบัญชีรับเงินของร้านเอง — เงินเข้าบัญชีร้านโดยตรง StoreOS ไม่ถือเงินแทน
          ต่างจากหน้า &quot;แพ็กเกจ&quot; ที่เป็นค่าสมาชิก StoreOS
        </p>
      </div>

      <div className="panel p-4 space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-[var(--color-text-primary)]">
              TrueMoney Shop QR (ยืนยันด้วยพนักงาน)
            </p>
            <p className="mt-1 text-xs text-[var(--color-text-muted)]">
              โหมด Manual — ยังไม่ใช่ API เชื่อมต่ออัตโนมัติ POS จะล็อกยอดจากออร์เดอร์ลง QR
              แล้วให้พนักงานยืนยันหลังลูกค้าสแกนจ่าย
            </p>
            {tm?.hasStaticEmvPayload ? (
              <p className="mt-2 text-xs text-[var(--color-text-muted)]">
                Payload ที่บันทึก: <code className="rounded bg-[var(--surface-muted)] px-1">{tm.staticEmvPayloadMasked}</code>
              </p>
            ) : (
              <p className="mt-2 text-xs text-amber-700">ยังไม่ได้บันทึก Shop QR</p>
            )}
          </div>
          <span
            className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold ${
              enabled
                ? "bg-green-100 text-green-800"
                : "bg-gray-100 text-gray-600"
            }`}
          >
            {enabled ? "เปิดใช้" : "ปิดอยู่"}
          </span>
        </div>

        <form action={formAction} className="space-y-3">
          <input type="hidden" name="keepExistingPayload" value={tm?.hasStaticEmvPayload ? "1" : "0"} />
          <label className="block space-y-1">
            <span className="text-xs font-semibold text-[var(--color-text-primary)]">
              TrueMoney Shop QR (EMV payload)
            </span>
            <textarea
              name="staticEmvPayload"
              rows={3}
              placeholder={
                tm?.hasStaticEmvPayload
                  ? "วาง payload ใหม่เพื่อแทนที่ (เว้นว่างไว้ของเดิม)"
                  : "วางสตริง EMV ที่ถอดจาก QR ร้าน เช่น 00020101021129..."
              }
              className="w-full rounded-lg border border-[var(--border)] bg-white px-3 py-2 font-mono text-xs"
            />
          </label>

          <label className="flex min-h-11 items-center gap-2 text-xs font-semibold">
            <input
              type="checkbox"
              name="isEnabled"
              value="1"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            เปิดใช้ที่ POS (Classic)
          </label>

          {state.error ? (
            <p className="rounded border border-red-200 bg-red-50 px-2 py-1.5 text-xs text-red-700">
              {state.error}
            </p>
          ) : null}
          {state.ok ? (
            <p className="rounded border border-green-200 bg-green-50 px-2 py-1.5 text-xs text-green-700">
              บันทึกแล้ว
            </p>
          ) : null}

          <div className="flex flex-wrap gap-2">
            <button
              type="submit"
              disabled={pending}
              className="min-h-11 rounded-lg bg-[var(--tenant-primary)] px-4 text-sm font-semibold text-white disabled:opacity-50"
            >
              {pending ? "กำลังบันทึก..." : "บันทึก TrueMoney"}
            </button>
            {tm?.hasStaticEmvPayload ? (
              <button
                type="button"
                disabled={disabling}
                onClick={onDisable}
                className="min-h-11 rounded-lg border border-gray-300 px-4 text-sm font-semibold text-gray-700 disabled:opacity-50"
              >
                {disabling ? "กำลังปิด..." : "ปิดใช้งาน"}
              </button>
            ) : null}
          </div>
          {disableError ? (
            <p className="text-xs text-red-700">{disableError}</p>
          ) : null}
        </form>

        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          StoreOS ไม่สามารถยืนยันอัตโนมัติว่าเงินเข้าบัญชี TrueMoney แล้วในโหมดนี้
          — พนักงานต้องตรวจสอบในแอป TrueMoney ก่อนกดยืนยันที่ POS
        </div>
      </div>
    </div>
  );
}
