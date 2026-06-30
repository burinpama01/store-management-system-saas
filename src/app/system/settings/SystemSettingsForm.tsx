"use client";

import { useActionState, useState } from "react";
import { useRouter } from "next/navigation";
import type { PlatformPromptPaySettings } from "@/modules/billing/platform-settings";
import { ProgressBar, Button } from "@/shared/components/ui";
import { uploadWithProgress } from "@/shared/services/upload";
import {
  updatePlatformSettingsAction,
  sendTestEnterpriseEmailAction,
  uploadPlatformLogoAction,
  resetPlatformLogoAction,
  type PlatformSettingsState,
  type TestEmailState,
} from "./actions";

const INITIAL: PlatformSettingsState = { error: null, ok: false };
const TEST_INITIAL: TestEmailState = { error: null, notice: null };

export function SystemSettingsForm({
  settings,
  slipReady,
}: {
  settings: PlatformPromptPaySettings;
  slipReady: boolean;
}) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState(updatePlatformSettingsAction, INITIAL);
  const [logoState, logoAction, logoPending] = useActionState(uploadPlatformLogoAction, INITIAL);
  const [logoResetState, logoResetAction, logoResetPending] = useActionState(
    resetPlatformLogoAction,
    INITIAL,
  );

  const [uploadPhase, setUploadPhase] = useState<"idle" | "uploading" | "processing">("idle");
  const [uploadPercent, setUploadPercent] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [decoded, setDecoded] = useState<string | null>(null);

  async function handleQrUpload(file: File) {
    setUploadError(null);
    setDecoded(null);
    setUploadPercent(0);
    setUploadPhase("uploading");
    const fd = new FormData();
    fd.set("qrImage", file);
    const res = await uploadWithProgress<{ ok?: boolean; payload?: string; error?: string }>(
      "/api/system/promptpay-qr",
      fd,
      (p) => {
        setUploadPercent(p);
        if (p >= 100) setUploadPhase("processing");
      },
    );
    setUploadPhase("idle");
    if (!res.ok || !res.data?.ok) {
      setUploadError(res.data?.error ?? "อัปโหลด/ถอดรหัส QR ไม่สำเร็จ");
      return;
    }
    setDecoded(res.data.payload ?? null);
    router.refresh();
  }

  return (
    <>
    <section className="panel max-w-2xl p-5 mb-4">
      <h2 className="panel-title mb-1">โลโก้ระบบ</h2>
      <p className="label-muted mb-4">โลโก้ที่แสดงเป็นแบรนด์ StoreOS ทุกหน้า (แนะนำรูปสี่เหลี่ยมจัตุรัส พื้นโปร่งใส/ขาว ≤ 2MB)</p>
      <div className="flex items-center gap-4">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={settings.logoUrl ?? "/logo.png"}
          alt="โลโก้ระบบ"
          className="h-16 w-16 rounded-xl border border-[var(--line)] bg-white object-contain"
        />
        <div className="flex flex-col gap-2">
          <form action={logoAction}>
            <label className="block">
              <span className="btn-secondary inline-flex min-h-9 cursor-pointer items-center px-3 text-sm">
                {logoPending ? "กำลังอัปโหลด..." : "เลือกรูปโลโก้"}
              </span>
              <input
                type="file"
                name="file"
                accept="image/*"
                className="hidden"
                disabled={logoPending}
                onChange={(e) => e.currentTarget.form?.requestSubmit()}
              />
            </label>
          </form>
          {settings.logoUrl && (
            <form action={logoResetAction}>
              <Button variant="secondary" loading={logoResetPending} className="min-h-8 px-2 text-xs text-[var(--muted)]">
                ใช้โลโก้เริ่มต้น
              </Button>
            </form>
          )}
        </div>
      </div>
      {(logoState.error || logoResetState.error) && (
        <p className="alert-danger mt-3">{logoState.error ?? logoResetState.error}</p>
      )}
      {(logoState.ok || logoResetState.ok) && (
        <p className="mt-3 text-sm text-green-600">บันทึกโลโก้แล้ว</p>
      )}
    </section>

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

        {settings.promptpayStaticPayload && (
          <div className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-muted)] p-2">
            <p className="label-muted">Payload (จาก QR ที่อัปโหลด) ที่ใช้รับเงินปัจจุบัน</p>
            <p className="break-all font-mono text-xs text-[var(--ink-2)]">{settings.promptpayStaticPayload}</p>
            <label className="mt-2 flex items-center gap-2 text-xs text-[var(--ink-2)]">
              <input type="checkbox" name="clearStaticPayload" value="1" />
              ล้าง payload นี้ (เปลี่ยนไปใช้ PromptPay ID)
            </label>
          </div>
        )}

        <div className="border-t border-[var(--border)] pt-4">
          <label className="field-label">อีเมลผู้ส่ง (สำหรับอีเมลคำขอ Enterprise)</label>
          <input
            type="text"
            name="enterpriseFromEmail"
            defaultValue={settings.enterpriseFromEmail ?? ""}
            placeholder="StoreOS <no-reply@yourdomain.com>"
            className="form-input"
          />
          <p className="mt-1 text-xs text-[var(--muted)]">
            ใช้เป็นผู้ส่งอีเมลยืนยัน/แจ้งสถานะคำขอ Enterprise · เว้นว่าง = ใช้ค่าจาก env (ENTERPRISE_FROM_EMAIL) ·
            โดเมนต้อง verify ใน Resend ก่อนจึงจะส่งหาอีเมลใดก็ได้
          </p>
        </div>

        <div className="border-t border-[var(--border)] pt-4">
          <label className="field-label">StoreOS Connect — URL ของ JDC Edge Functions</label>
          <input
            type="text"
            name="jdcFunctionsBaseUrl"
            defaultValue={settings.jdcFunctionsBaseUrl ?? ""}
            placeholder="https://xxxx.supabase.co/functions/v1"
            className="form-input"
          />
          <p className="mt-1 text-xs text-[var(--muted)]">
            ปลายทางกลางที่ StoreOS ใช้ส่งเมนู/สถานะ/เปิด-ปิดร้านไปยัง JDC (เดลิเวอรี) ·
            ใช้ร่วมกันทุกร้าน · เว้นว่าง = ปิดการส่งออกไป JDC
          </p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <div>
              <label className="field-label">JDC API key</label>
              <input
                type="text"
                name="jdcApiKey"
                defaultValue={settings.jdcApiKey ?? ""}
                placeholder="jdc_..."
                className="form-input font-mono text-xs"
              />
            </div>
            <div>
              <label className="field-label">JDC webhook secret (shared HMAC)</label>
              <input
                type="text"
                name="jdcWebhookSecret"
                defaultValue={settings.jdcWebhookSecret ?? ""}
                placeholder="whsec_..."
                className="form-input font-mono text-xs"
              />
            </div>
          </div>
          <p className="mt-1 text-xs text-[var(--muted)]">
            คัดลอกจากหน้า StoreOS Connect ในแอดมิน JDC (ออก key/secret ชุดเดียวทั้งระบบ) ·
            webhook secret ใช้ตรวจ/เซ็น HMAC ทั้งขาเข้า-ออก ต้องตรงกันสองฝั่ง
          </p>
        </div>

        <Button type="submit" variant="primary" loading={pending} loadingText="กำลังบันทึก..." className="disabled:opacity-40">
          บันทึกการตั้งค่า
        </Button>
      </form>

      <div className="mt-6 border-t border-[var(--border)] pt-5">
        <TestEmailPanel />
      </div>

      <div className="mt-6 border-t border-[var(--border)] pt-5">
        <label className="field-label">อัปโหลดรูป QR Code (สำหรับบัญชีที่ไม่มี PromptPay ID)</label>
        <p className="mb-2 text-xs text-[var(--muted)]">
          ระบบจะถอดรหัส (decode) รูปเพื่อดึง EMVCo Payload และฝังยอดเงินตามแพ็กเกจให้อัตโนมัติ
        </p>
        <input
          type="file"
          accept="image/*"
          disabled={uploadPhase !== "idle"}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void handleQrUpload(f);
          }}
          className="text-sm"
        />

        {uploadPhase === "uploading" && (
          <div className="mt-3 max-w-sm">
            <ProgressBar percent={uploadPercent} label="กำลังอัปโหลดรูป" />
          </div>
        )}
        {uploadPhase === "processing" && (
          <p className="mt-3 text-sm text-[var(--muted)]">กำลังถอดรหัส QR...</p>
        )}
        {uploadError && <p className="alert-danger mt-3">{uploadError}</p>}
        {decoded && (
          <div className="mt-3 rounded-[var(--radius-md)] border border-emerald-200 bg-emerald-50 p-2">
            <p className="text-xs font-bold text-emerald-700">ดึง EMVCo Payload จากรูปสำเร็จ</p>
            <p className="break-all font-mono text-xs text-emerald-800">{decoded}</p>
          </div>
        )}
      </div>
    </section>
    </>
  );
}

function TestEmailPanel() {
  const [state, action, pending] = useActionState(sendTestEnterpriseEmailAction, TEST_INITIAL);
  return (
    <div>
      <h3 className="text-sm font-bold text-[var(--ink)]">ทดสอบส่งอีเมล Enterprise</h3>
      <p className="mb-2 text-xs text-[var(--muted)]">
        ยิงอีเมลทดสอบไปยังอีเมลที่กรอก โดยใช้ผู้ส่งที่บันทึกไว้ (บันทึกการตั้งค่าก่อนทดสอบ)
      </p>
      <form action={action} className="flex flex-wrap items-end gap-2">
        <div className="min-w-0 flex-1">
          <label className="field-label" htmlFor="testEmail">อีเมลปลายทาง</label>
          <input
            id="testEmail"
            type="email"
            name="testEmail"
            required
            placeholder="you@example.com"
            className="form-input"
          />
        </div>
        <Button type="submit" variant="secondary" loading={pending} loadingText="กำลังส่ง..." className="disabled:opacity-40">
          ยิงทดสอบ
        </Button>
      </form>
      {state.error && <p className="alert-danger mt-2">{state.error}</p>}
      {state.notice && (
        <p className="mt-2 rounded-[var(--radius-md)] border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          {state.notice}
        </p>
      )}
    </div>
  );
}
