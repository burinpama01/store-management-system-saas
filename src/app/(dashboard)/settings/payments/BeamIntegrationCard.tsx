"use client";

import { useActionState, useRef, useState, useTransition } from "react";
import type { BeamPaymentHistoryItem } from "@/modules/payments/beam-service";
import type { BeamTestResult, PaymentProviderConfigPublic } from "@/modules/payments/types";
import { disableBeamConfigAction, saveBeamConfigAction, testBeamConnectionAction } from "./actions";

const STATUS_LABEL: Record<string, string> = {
  PENDING: "รอสแกน",
  PAID: "รับเงินแล้ว",
  FAILED: "ไม่สำเร็จ",
  EXPIRED: "หมดอายุ",
  CANCELLED: "ยกเลิก",
  LATE_PAID: "เงินเข้าหลังยกเลิก",
  REVIEW_REQUIRED: "ยอดไม่ตรง — ตรวจสอบ",
};

function statusClass(status: string): string {
  if (status === "PAID") return "bg-green-100 text-green-800";
  if (status === "LATE_PAID" || status === "REVIEW_REQUIRED") return "bg-red-100 text-red-800";
  if (status === "PENDING") return "bg-amber-100 text-amber-800";
  return "bg-gray-100 text-gray-600";
}

function formatThb(amount: number): string {
  return amount.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString("th-TH", { dateStyle: "short", timeStyle: "short" });
  } catch {
    return iso;
  }
}

export function BeamIntegrationCard({
  config,
  webhookUrl,
  history,
}: {
  config: PaymentProviderConfigPublic | null;
  webhookUrl: string;
  history: BeamPaymentHistoryItem[];
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const [state, formAction, saving] = useActionState(saveBeamConfigAction, { error: null });
  const [environment, setEnvironment] = useState<"test" | "live">(config?.environment ?? "test");
  const [enabled, setEnabled] = useState(config?.isEnabled ?? false);
  const [hidePromptPay, setHidePromptPay] = useState(config?.hidePromptPayQr ?? false);
  const [testResult, setTestResult] = useState<BeamTestResult | null>(null);
  const [testing, startTest] = useTransition();
  const [disabling, startDisable] = useTransition();
  const [disableError, setDisableError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const hasKeys = Boolean(config?.hasApiKey);
  const active = Boolean(config?.isEnabled && hasKeys);
  const needsAttention = history.filter(
    (p) => p.status === "LATE_PAID" || p.status === "REVIEW_REQUIRED" || (p.status === "PAID" && !p.attached),
  );

  function onTest() {
    if (!formRef.current) return;
    const fd = new FormData(formRef.current);
    setTestResult(null);
    startTest(async () => setTestResult(await testBeamConnectionAction(fd)));
  }

  function onDisable() {
    setDisableError(null);
    startDisable(async () => {
      const res = await disableBeamConfigAction();
      if (res.error) setDisableError(res.error);
      else setEnabled(false);
    });
  }

  async function copyWebhookUrl() {
    try {
      await navigator.clipboard.writeText(webhookUrl);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="panel p-4 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-[var(--color-text-primary)]">Beam — QR พร้อมเพย์ ยืนยันยอดอัตโนมัติ</p>
          <p className="mt-1 text-xs text-[var(--color-text-muted)]">
            ใช้บัญชี Beam ของร้านเอง เงินเข้าบัญชี Beam ของร้านโดยตรง · POS สร้าง QR ล็อกยอดผ่าน Beam
            แล้วปิดบิลเองเมื่อ Beam ยืนยันว่าเงินเข้า — พนักงานไม่ต้องตรวจสลิป
          </p>
          {config?.merchantIdMasked ? (
            <p className="mt-2 text-xs text-[var(--color-text-muted)]">
              Merchant ID: <code className="rounded bg-[var(--surface-muted)] px-1">{config.merchantIdMasked}</code>
              {" · "}
              {config.environment === "test" ? "Playground (ทดสอบ)" : "Production (เงินจริง)"}
              {" · "}
              {config.hasWebhookSecret ? "มี HMAC key แล้ว" : <span className="text-amber-700">ยังไม่มี HMAC key</span>}
            </p>
          ) : null}
        </div>
        <span
          className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold ${
            active ? "bg-green-100 text-green-800" : "bg-gray-100 text-gray-600"
          }`}
        >
          {active ? "เปิดใช้ที่ POS" : "ปิดอยู่"}
        </span>
      </div>

      <details className="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2 text-xs">
        <summary className="cursor-pointer font-semibold text-[var(--color-text-primary)]">วิธีตั้งค่า (5 นาที)</summary>
        <ol className="mt-2 list-decimal space-y-1 pl-5 text-[var(--color-text-muted)]">
          <li>
            เข้า Lighthouse ของ Beam (ทดสอบ: playground.beamcheckout.com · ใช้จริง: lighthouse.beamcheckout.com)
            → เมนู <strong>Developers</strong>
          </li>
          <li>คัดลอก <strong>Merchant ID</strong> และสร้าง <strong>API key</strong> → วางในช่องด้านล่าง</li>
          <li>
            ที่หน้า Webhooks เพิ่ม URL ด้านล่าง เลือก event <code>charge.succeeded</code> และ{" "}
            <code>charge.failed</code> → คัดลอก <strong>HMAC key</strong> มาวาง
          </li>
          <li>กด &quot;ทดสอบเชื่อมต่อ&quot; → ติ๊กเปิดใช้ → บันทึก → ที่ POS จะมีปุ่ม &quot;Beam QR&quot;</li>
          <li>
            ก่อนใช้จริง: เลือก Production ใช้ key ของ Production (key ของ Playground ใช้แทนกันไม่ได้)
            แล้วลองจ่ายจริง 1 บาท และคืนเงินใน Lighthouse
          </li>
        </ol>
      </details>

      <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2 text-xs space-y-1">
        <p className="font-semibold text-[var(--color-text-primary)]">Webhook URL สำหรับ Beam</p>
        <code className="block break-all text-[11px]">{webhookUrl}</code>
        <button
          type="button"
          onClick={copyWebhookUrl}
          className="min-h-9 rounded border border-gray-300 bg-white px-2 text-[11px] font-semibold"
        >
          {copied ? "คัดลอกแล้ว" : "คัดลอก URL"}
        </button>
      </div>

      <form ref={formRef} action={formAction} className="space-y-3">
        <fieldset className="space-y-1">
          <legend className="text-xs font-semibold">สภาพแวดล้อม</legend>
          <div className="grid grid-cols-2 gap-2">
            {(["test", "live"] as const).map((env) => (
              <label
                key={env}
                className={`flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border px-3 text-xs font-semibold ${
                  environment === env ? "border-[var(--tenant-primary)] bg-[var(--tenant-primary-soft)]" : "border-[var(--border)]"
                }`}
              >
                <input
                  type="radio"
                  name="environment"
                  value={env}
                  checked={environment === env}
                  onChange={() => setEnvironment(env)}
                />
                {env === "test" ? "Playground (ทดสอบ)" : "Production (เงินจริง)"}
              </label>
            ))}
          </div>
        </fieldset>
        <label className="block space-y-1">
          <span className="text-xs font-semibold">Merchant ID</span>
          <input
            type="text"
            name="merchantId"
            autoComplete="off"
            placeholder={config?.merchantIdMasked ? `บันทึกแล้ว (${config.merchantIdMasked}) — วางใหม่เพื่อเปลี่ยน` : "เช่น eachother-xxxxxx"}
            required={!config?.merchantIdMasked}
            className="w-full rounded-lg border border-[var(--border)] bg-white px-3 py-2 font-mono text-sm"
          />
        </label>
        <label className="block space-y-1">
          <span className="text-xs font-semibold">API key</span>
          <input
            type="password"
            name="apiKey"
            autoComplete="off"
            placeholder={hasKeys ? "เว้นว่างเพื่อใช้ key เดิม" : "วาง API key จาก Lighthouse → Developers"}
            className="w-full rounded-lg border border-[var(--border)] bg-white px-3 py-2 font-mono text-sm"
          />
        </label>
        <label className="block space-y-1">
          <span className="text-xs font-semibold">Webhook HMAC key</span>
          <input
            type="password"
            name="webhookHmacKey"
            autoComplete="off"
            placeholder={config?.hasWebhookSecret ? "เว้นว่างเพื่อใช้ key เดิม" : "วาง HMAC key (base64) จากหน้า Webhooks"}
            className="w-full rounded-lg border border-[var(--border)] bg-white px-3 py-2 font-mono text-sm"
          />
          <span className="block text-[11px] text-[var(--color-text-muted)]">
            ไม่ใส่ก็ใช้ได้ (ระบบจะถาม Beam เองทุกไม่กี่วินาที) แต่ใส่ไว้จะปิดบิลได้เร็วกว่า
          </span>
        </label>
        <label className="flex min-h-11 items-center gap-2 text-xs font-semibold">
          <input
            type="checkbox"
            name="isEnabled"
            value="1"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          เปิดใช้ &quot;Beam QR&quot; ที่หน้า POS
        </label>
        <label className="flex min-h-11 items-start gap-2 text-xs">
          <input
            type="checkbox"
            name="hidePromptPayQr"
            value="1"
            checked={hidePromptPay}
            onChange={(e) => setHidePromptPay(e.target.checked)}
            className="mt-0.5"
          />
          <span>
            <span className="font-semibold">ซ่อน &quot;QR พร้อมเพย์&quot; (แบบตรวจสลิป) ที่ POS — แสดงแค่ Beam QR</span>
            <span className="block text-[11px] text-[var(--color-text-muted)]">
              กันพนักงานเลือก QR ที่ต้องตรวจสลิปเอง · ถ้าปิดใช้ Beam ปุ่ม QR พร้อมเพย์จะกลับมาเอง
            </span>
          </span>
        </label>

        {state.error ? (
          <p className="rounded border border-red-200 bg-red-50 px-2 py-1.5 text-xs text-red-700">{state.error}</p>
        ) : null}
        {state.ok ? (
          <p className="rounded border border-green-200 bg-green-50 px-2 py-1.5 text-xs text-green-700">บันทึกการตั้งค่า Beam แล้ว</p>
        ) : null}
        {testResult ? (
          testResult.ok ? (
            <div className="rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-xs text-green-800 space-y-1">
              <p className="font-semibold">ทดสอบสำเร็จ</p>
              <p>{testResult.message}</p>
              {!testResult.hasWebhookKey ? (
                <p className="text-amber-700">ยังไม่มี HMAC key ที่บันทึกไว้ — webhook จะถูกปฏิเสธจนกว่าจะใส่</p>
              ) : null}
            </div>
          ) : (
            <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
              <p className="font-semibold">ทดสอบไม่สำเร็จ</p>
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
            disabled={saving}
            className="min-h-11 rounded-lg bg-[var(--tenant-primary)] px-4 text-sm font-semibold text-white disabled:opacity-50"
          >
            {saving ? "กำลังบันทึก..." : "บันทึก Beam"}
          </button>
          {config?.isEnabled ? (
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

      <div className="space-y-2">
        <p className="text-xs font-semibold text-[var(--color-text-primary)]">รายการ Beam ล่าสุด</p>
        {needsAttention.length > 0 ? (
          <p className="rounded border border-red-200 bg-red-50 px-2 py-1.5 text-xs text-red-700">
            มี {needsAttention.length} รายการที่ต้องตรวจ — เงินเข้า Beam แต่ไม่ได้ผูกกับบิล (คืนเงินใน Lighthouse หรือเปิดบิลแล้วรับชำระด้วยวิธีอื่น)
          </p>
        ) : null}
        {history.length === 0 ? (
          <p className="text-xs text-[var(--color-text-muted)]">ยังไม่มีรายการ</p>
        ) : (
          <ul className="divide-y divide-[var(--border)] text-xs">
            {history.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className="tabular-nums">
                  {formatTime(p.createdAt)} · ฿{formatThb(p.amount)}
                  {p.musicRequestId ? " · ขอเพลง" : ""}
                  {p.environment === "test" ? " · ทดสอบ" : ""}
                </span>
                <span className="flex items-center gap-2">
                  {p.status === "PAID" && !p.attached ? (
                    <span className="text-red-700">ยังไม่ผูกบิล</span>
                  ) : null}
                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${statusClass(p.status)}`}>
                    {STATUS_LABEL[p.status] ?? p.status}
                  </span>
                </span>
                {p.failureMessage && p.status !== "CANCELLED" ? (
                  <span className="w-full text-[11px] text-[var(--color-text-muted)]">{p.failureMessage}</span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
