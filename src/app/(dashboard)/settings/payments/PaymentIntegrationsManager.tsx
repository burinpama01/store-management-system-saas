"use client";

import { useActionState, useState, useTransition } from "react";
import type { PaymentProviderConfigPublic } from "@/modules/payments/types";
import type { TrueMoneyManualTestResult } from "@/modules/payments/types";
import {
  saveTrueMoneyManualConfigAction,
  disableTrueMoneyManualConfigAction,
  testTrueMoneyManualConnectionAction,
} from "./actions";

type InputMode = "emv" | "ewallet";

export function PaymentIntegrationsManager({
  configs,
}: {
  configs: PaymentProviderConfigPublic[];
}) {
  const tm = configs.find((c) => c.providerKey === "truemoney" && c.mode === "manual");
  const [enabled, setEnabled] = useState(Boolean(tm?.isEnabled && !tm.disabledAt));
  const [inputMode, setInputMode] = useState<InputMode>("ewallet");
  const [displayName, setDisplayName] = useState(tm?.displayName || "TrueMoney Shop QR");
  const [eWalletId, setEWalletId] = useState("");
  const [staticEmvPayload, setStaticEmvPayload] = useState("");
  const [state, formAction, pending] = useActionState(saveTrueMoneyManualConfigAction, {
    error: null as string | null,
    ok: false,
  });
  const [disableError, setDisableError] = useState<string | null>(null);
  const [disabling, setDisabling] = useState(false);
  const [testResult, setTestResult] = useState<TrueMoneyManualTestResult | null>(null);
  const [testing, startTest] = useTransition();

  async function onDisable() {
    setDisabling(true);
    setDisableError(null);
    const res = await disableTrueMoneyManualConfigAction();
    setDisabling(false);
    if (res.error) setDisableError(res.error);
    else setEnabled(false);
  }

  function onTest() {
    setTestResult(null);
    const fd = new FormData();
    fd.set("inputMode", inputMode);
    fd.set("eWalletId", eWalletId);
    fd.set("staticEmvPayload", staticEmvPayload);
    fd.set("keepExistingPayload", tm?.hasStaticEmvPayload ? "1" : "0");
    startTest(async () => {
      const res = await testTrueMoneyManualConnectionAction(fd);
      setTestResult(res);
    });
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
                Payload ที่บันทึก:{" "}
                <code className="rounded bg-[var(--surface-muted)] px-1">
                  {tm.staticEmvPayloadMasked}
                </code>
              </p>
            ) : (
              <p className="mt-2 text-xs text-amber-700">ยังไม่ได้บันทึก Shop QR</p>
            )}
          </div>
          <span
            className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold ${
              enabled ? "bg-green-100 text-green-800" : "bg-gray-100 text-gray-600"
            }`}
          >
            {enabled ? "เปิดใช้" : "ปิดอยู่"}
          </span>
        </div>

        <form action={formAction} className="space-y-3">
          <input type="hidden" name="inputMode" value={inputMode} />
          <input
            type="hidden"
            name="keepExistingPayload"
            value={tm?.hasStaticEmvPayload ? "1" : "0"}
          />

          <label className="block space-y-1">
            <span className="text-xs font-semibold text-[var(--color-text-primary)]">
              ชื่อที่แสดง (ไม่บังคับ)
            </span>
            <input
              type="text"
              name="displayName"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="TrueMoney Shop QR"
              className="w-full rounded-lg border border-[var(--border)] bg-white px-3 py-2 text-sm"
            />
          </label>

          <div className="space-y-2">
            <p className="text-xs font-semibold text-[var(--color-text-primary)]">วิธีตั้งค่า</p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => setInputMode("emv")}
                className={`min-h-11 rounded-lg border px-3 text-xs font-semibold ${
                  inputMode === "emv"
                    ? "border-[var(--tenant-primary)] bg-[var(--tenant-primary)] text-white"
                    : "border-gray-300 bg-white text-gray-700"
                }`}
              >
                วาง EMV จาก QR
              </button>
              <button
                type="button"
                onClick={() => setInputMode("ewallet")}
                className={`min-h-11 rounded-lg border px-3 text-xs font-semibold ${
                  inputMode === "ewallet"
                    ? "border-[var(--tenant-primary)] bg-[var(--tenant-primary)] text-white"
                    : "border-gray-300 bg-white text-gray-700"
                }`}
              >
                ระบุ E-Wallet ID เอง
              </button>
            </div>
          </div>

          {inputMode === "ewallet" ? (
            <label className="block space-y-1">
              <span className="text-xs font-semibold text-[var(--color-text-primary)]">
                E-Wallet ID (TrueMoney Shop)
              </span>
              <input
                type="text"
                name="eWalletId"
                value={eWalletId}
                onChange={(e) => setEWalletId(e.target.value)}
                inputMode="numeric"
                autoComplete="off"
                placeholder="140000956879045"
                className="w-full rounded-lg border border-[var(--border)] bg-white px-3 py-2 font-mono text-sm"
              />
              <span className="block text-[11px] text-[var(--color-text-muted)]">
                ใส่เลข E-Wallet / รหัสร้านใน TrueMoney Shop (ตัวเลข 10–20 หลัก)
                ระบบจะสร้าง Shop QR ให้เอง — ไม่ต้องถอดรหัสจากรูป QR
              </span>
            </label>
          ) : (
            <label className="block space-y-1">
              <span className="text-xs font-semibold text-[var(--color-text-primary)]">
                TrueMoney Shop QR (EMV payload)
              </span>
              <textarea
                name="staticEmvPayload"
                rows={3}
                value={staticEmvPayload}
                onChange={(e) => setStaticEmvPayload(e.target.value)}
                placeholder={
                  tm?.hasStaticEmvPayload
                    ? "วาง payload ใหม่เพื่อแทนที่ (เว้นว่างไว้ของเดิม)"
                    : "วางสตริง EMV ที่ถอดจาก QR ร้าน เช่น 00020101021129..."
                }
                className="w-full rounded-lg border border-[var(--border)] bg-white px-3 py-2 font-mono text-xs"
              />
            </label>
          )}

          {/* Keep unused field names present for the other mode so server always sees keys */}
          {inputMode === "ewallet" ? (
            <input type="hidden" name="staticEmvPayload" value="" />
          ) : (
            <input type="hidden" name="eWalletId" value="" />
          )}

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

          {testResult ? (
            testResult.ok ? (
              <div className="rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-xs text-green-800 space-y-1">
                <p className="font-semibold">ทดสอบเชื่อมต่อสำเร็จ</p>
                <p>{testResult.message}</p>
                <p>
                  โหมด: {testResult.mode} · ผู้ให้บริการ: {testResult.providerKey}
                  {testResult.eWalletIdMasked
                    ? ` · E-Wallet: ${testResult.eWalletIdMasked}`
                    : ""}
                </p>
                <p>
                  ความสามารถ: สร้าง QR ได้ · webhook ไม่มี · lookup ไม่มี · refund ไม่มี ·
                  ยืนยันด้วยพนักงานได้
                </p>
              </div>
            ) : (
              <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                <p className="font-semibold">ทดสอบเชื่อมต่อไม่สำเร็จ</p>
                <p>{testResult.error}</p>
              </div>
            )
          ) : null}

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={testing}
              onClick={onTest}
              className="min-h-11 rounded-lg border border-[var(--tenant-primary)] px-4 text-sm font-semibold text-[var(--tenant-primary)] disabled:opacity-50"
            >
              {testing ? "กำลังทดสอบ..." : "ทดสอบเชื่อมต่อ"}
            </button>
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
          {disableError ? <p className="text-xs text-red-700">{disableError}</p> : null}
        </form>

        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          StoreOS ไม่สามารถยืนยันอัตโนมัติว่าเงินเข้าบัญชีแล้วในโหมดนี้ — พนักงานต้องตรวจสอบ
          สลิปโอนเงินจากลูกค้าก่อนกดยืนยันที่ POS (ไม่ใช่การเชื่อม API TrueMoney)
        </div>
      </div>
    </div>
  );
}
