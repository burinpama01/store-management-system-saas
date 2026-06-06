"use client";

import { useActionState } from "react";
import type { PlatformPromptPaySettings } from "@/modules/billing/platform-settings";
import { updatePlatformSettingsAction, type PlatformSettingsState } from "./actions";

const INITIAL: PlatformSettingsState = { error: null, ok: false };

export function SystemSettingsForm({
  settings,
  slipReady,
}: {
  settings: PlatformPromptPaySettings;
  slipReady: boolean;
}) {
  const [state, formAction, pending] = useActionState(updatePlatformSettingsAction, INITIAL);

  return (
    <section className="panel max-w-2xl p-5">
      <h2 className="panel-title mb-1">ช่องทางรับชำระเงิน SaaS</h2>
      <p className="label-muted mb-4">
        ตั้งค่าบัญชี PromptPay ที่ใช้รับเงินค่าสมาชิกจากทุก tenant ·{" "}
        slip2go: {slipReady ? "พร้อมใช้งาน" : "ยังไม่ได้ตั้งค่า SLIP2GO_API_KEY"}
      </p>

      <form action={formAction} className="space-y-4">
        {state.error && <p className="alert-danger">{state.error}</p>}
        {state.ok && (
          <p className="rounded-[var(--radius-md)] border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
            บันทึกการตั้งค่าแล้ว
          </p>
        )}

        <div>
          <label className="field-label">ผู้ให้บริการชำระเงิน</label>
          <select name="billingProvider" defaultValue={settings.billingProvider} className="form-input">
            <option value="promptpay">PromptPay (slip2go)</option>
            <option value="stripe">Stripe (ปิดใช้งานชั่วคราว)</option>
          </select>
        </div>

        <div>
          <label className="field-label">PromptPay ID (เบอร์โทร / เลขบัตรประชาชน-ภาษี)</label>
          <input
            type="text"
            name="promptpayId"
            defaultValue={settings.promptpayId ?? ""}
            placeholder="0812345678 หรือ 1234567890123"
            className="form-input"
          />
          <p className="mt-1 text-xs text-[var(--muted)]">
            ถ้ากรอก ระบบจะสร้าง EMVCo Payload พร้อมยอดเงินให้ลูกค้าอัตโนมัติ
          </p>
        </div>

        <div>
          <label className="field-label">ชื่อบัญชีผู้รับ (แสดงให้ลูกค้า)</label>
          <input
            type="text"
            name="promptpayName"
            defaultValue={settings.promptpayName ?? ""}
            placeholder="เช่น บริษัท สโตร์โอเอส จำกัด"
            className="form-input"
          />
        </div>

        <div>
          <label className="field-label">URL รูป QR Code (สำหรับบัญชีที่ไม่มี PromptPay)</label>
          <input
            type="url"
            name="promptpayQrImagePath"
            defaultValue={settings.promptpayQrImagePath ?? ""}
            placeholder="https://.../qr.png"
            className="form-input"
          />
          <p className="mt-1 text-xs text-[var(--muted)]">
            ใช้เมื่อไม่ได้กรอก PromptPay ID — แสดงรูป QR นี้แทน
          </p>
        </div>

        <button type="submit" disabled={pending} className="btn-primary disabled:opacity-40">
          {pending ? "กำลังบันทึก..." : "บันทึกการตั้งค่า"}
        </button>
      </form>
    </section>
  );
}
