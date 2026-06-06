"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import type { BillingPlan } from "@/modules/billing/types";
import { PLAN_LABELS } from "@/modules/billing/types";
import {
  DURATION_LABELS,
  DURATION_PRICES,
  PAID_TIERS,
  type BillingDuration,
  type PaidTier,
} from "@/modules/billing/pricing";
import type { SubscriptionQr } from "@/modules/billing/promptpay-provider";
import { getPaymentQrAction, submitPaymentAction } from "./actions";

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleDateString("th-TH", { year: "numeric", month: "short", day: "numeric" });
}

const TIER_DESC: Record<PaidTier, string> = {
  starter: "POS, รายรับ-จ่าย, ใบเสร็จ browser",
  standard: "+ บุฟเฟต์, สต็อก, printer ขั้นสูง",
  premium: "+ QR ordering, LINE, GPS, commission",
};

async function fileToBase64(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  let binary = "";
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

export function BillingManager({
  orgName,
  plan,
  currentPeriodEnd,
  isActive,
  canManage,
  paymentConfigured,
  recipientName,
  slipVerificationReady,
}: {
  orgName: string;
  plan: BillingPlan;
  currentPeriodEnd: string;
  isActive: boolean;
  canManage: boolean;
  paymentConfigured: boolean;
  recipientName: string | null;
  slipVerificationReady: boolean;
}) {
  const searchParams = useSearchParams();
  const expired = searchParams.get("expired") === "1";

  const [selectedPlan, setSelectedPlan] = useState<PaidTier>("starter");
  const [duration, setDuration] = useState<BillingDuration>("30d");
  const [qr, setQr] = useState<SubscriptionQr | null>(null);
  const [amount, setAmount] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ status: string; reason: string | null; newExpiry: string | null } | null>(null);

  const price = DURATION_PRICES[selectedPlan][duration];

  async function generateQr() {
    setError(null);
    setResult(null);
    setBusy(true);
    const res = await getPaymentQrAction(selectedPlan, duration);
    setBusy(false);
    if (!res.ok) {
      setError(res.error ?? "สร้าง QR ไม่สำเร็จ");
      return;
    }
    setAmount(res.amount);
    setQr(res.qr);
  }

  async function handleSlip(file: File) {
    setError(null);
    setResult(null);
    setBusy(true);
    try {
      const base64 = await fileToBase64(file);
      const res = await submitPaymentAction({ plan: selectedPlan, duration, slipImageBase64: base64 });
      if (res.error) setError(res.error);
      else setResult({ status: res.status, reason: res.reason, newExpiry: res.newExpiry });
    } catch {
      setError("อ่านไฟล์สลิปไม่สำเร็จ");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page-shell">
      <div className="page-header">
        <div>
          <h1 className="page-title">การเรียกเก็บเงิน & แพ็กเกจ</h1>
          <p className="page-kicker">{orgName} · ชำระผ่าน PromptPay ยืนยันอัตโนมัติด้วย slip2go</p>
        </div>
        <span className={`badge ${isActive ? "badge-success" : "badge-warning"}`}>
          {isActive ? "ใช้งานอยู่" : "ยังไม่เปิดใช้งาน"}
        </span>
      </div>

      {expired && !isActive && (
        <p className="rounded-[var(--radius-md)] border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          แพ็กเกจหมดอายุหรือยังไม่ได้ชำระเงิน กรุณาชำระเพื่อใช้งานระบบต่อ
        </p>
      )}
      {error && <p className="alert-danger">{error}</p>}
      {!canManage && (
        <p className="rounded-[var(--radius-md)] border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          คุณดูข้อมูลได้ แต่ไม่มีสิทธิ์ชำระเงิน (ต้องมีสิทธิ์ billing.manage)
        </p>
      )}

      <section className="panel max-w-3xl p-5">
        <h2 className="panel-title mb-3">แพ็กเกจปัจจุบัน</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <InfoItem label="แพ็กเกจ" value={PLAN_LABELS[plan]} />
          <InfoItem label="สถานะ" value={isActive ? "ใช้งานอยู่" : "หมดอายุ/ยังไม่ชำระ"} />
          <InfoItem label="ใช้งานได้ถึง" value={formatDate(currentPeriodEnd)} />
        </div>
      </section>

      {result?.status === "verified" && (
        <p className="rounded-[var(--radius-md)] border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          ยืนยันการชำระเงินสำเร็จ! ใช้งานได้ถึง {formatDate(result.newExpiry)}
        </p>
      )}
      {result && result.status !== "verified" && (
        <p className="rounded-[var(--radius-md)] border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          {result.status === "duplicate" ? "สลิปนี้ถูกใช้ไปแล้ว" : `ตรวจสลิปไม่ผ่าน: ${result.reason ?? ""}`}
        </p>
      )}

      {canManage && !paymentConfigured && (
        <p className="rounded-[var(--radius-md)] border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          ผู้ดูแลแพลตฟอร์มยังไม่ได้ตั้งค่าช่องทางรับชำระเงิน (PromptPay) กรุณาติดต่อผู้ดูแล
        </p>
      )}

      {canManage && paymentConfigured && (
        <section className="panel p-5">
          <h2 className="panel-title mb-3">ต่ออายุ / เปลี่ยนแพ็กเกจ</h2>

          <div className="grid gap-3 md:grid-cols-3">
            {PAID_TIERS.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => { setSelectedPlan(t); setQr(null); }}
                className={`rounded-[var(--radius-lg)] border p-4 text-left ${
                  selectedPlan === t
                    ? "border-[var(--tenant-primary)] bg-[var(--tenant-primary-soft)]"
                    : "border-[var(--border)] bg-[var(--surface-muted)]"
                }`}
              >
                <p className="text-sm font-extrabold text-[var(--ink)]">{PLAN_LABELS[t]}</p>
                <p className="mt-1 text-xs text-[var(--muted)]">{TIER_DESC[t]}</p>
                <p className="mt-2 text-xs text-[var(--ink-2)]">
                  {DURATION_PRICES[t]["30d"].toLocaleString()} / เดือน
                </p>
              </button>
            ))}
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            {(["30d", "1y"] as BillingDuration[]).map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => { setDuration(d); setQr(null); }}
                className={`min-h-11 rounded-md px-4 text-sm font-bold ${
                  duration === d ? "btn-primary" : "btn-secondary"
                }`}
              >
                {DURATION_LABELS[d]}
              </button>
            ))}
            <span className="ml-auto text-lg font-extrabold text-[var(--tenant-primary-strong)]">
              {price.toLocaleString()} บาท
            </span>
          </div>

          <button
            type="button"
            onClick={generateQr}
            disabled={busy}
            className="btn-primary mt-4 disabled:opacity-40"
          >
            {busy ? "กำลังสร้าง..." : "สร้าง QR ชำระเงิน"}
          </button>

          {qr && (
            <div className="mt-4 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-muted)] p-4">
              <p className="mb-2 text-sm font-bold text-[var(--ink)]">
                โอน {amount?.toLocaleString()} บาท ไปยัง {recipientName ?? "บัญชีผู้รับ"}
              </p>
              {qr.type === "payload" && (
                <div>
                  <p className="label-muted mb-1">EMVCo Payload (สร้าง/สแกน QR จากสตริงนี้)</p>
                  <textarea
                    readOnly
                    value={qr.payload}
                    onFocus={(e) => e.currentTarget.select()}
                    rows={3}
                    className="form-input break-all font-mono text-xs"
                  />
                  {!qr.amountEmbedded && (
                    <p className="mt-1 text-xs text-amber-700">
                      QR นี้ไม่ได้ระบุยอด กรุณาโอนยอด {amount?.toLocaleString()} บาท ด้วยตนเอง
                    </p>
                  )}
                </div>
              )}
              {qr.type === "unconfigured" && (
                <p className="text-sm text-amber-700">ยังไม่ได้ตั้งค่าช่องทางชำระเงิน</p>
              )}

              <div className="mt-4">
                <p className="label-muted mb-1">อัปโหลดสลิปเพื่อยืนยันอัตโนมัติ</p>
                {!slipVerificationReady && (
                  <p className="mb-2 text-xs text-amber-700">
                    ระบบตรวจสลิป (slip2go) ยังไม่พร้อม — การยืนยันอาจไม่สำเร็จ
                  </p>
                )}
                <input
                  type="file"
                  accept="image/*"
                  disabled={busy}
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleSlip(f); }}
                  className="text-sm"
                />
              </div>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

function InfoItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-muted)] p-3">
      <p className="label-muted">{label}</p>
      <p className="mt-1 text-sm font-bold text-[var(--ink-2)]">{value}</p>
    </div>
  );
}
