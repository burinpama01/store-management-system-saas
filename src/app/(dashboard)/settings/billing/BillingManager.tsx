"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { BillingPlan } from "@/modules/billing/types";
import { PLAN_LABELS } from "@/modules/billing/types";
import {
  DURATION_LABELS,
  PAID_TIERS,
  type BillingDuration,
  type PaidTier,
} from "@/modules/billing/pricing";
import type { SubscriptionQr } from "@/modules/billing/promptpay-provider";
import { ModalDialog, ProgressBar, QrCode } from "@/shared/components/ui";
import { uploadWithProgress } from "@/shared/services/upload";
import { claimPremiumTrialAction, getPaymentQrAction } from "./actions";

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleDateString("th-TH", { year: "numeric", month: "short", day: "numeric" });
}

const TIER_DESC: Record<PaidTier, string> = {
  starter: "1 สาขา / 3 สมาชิก · Basic POS, catalog, receipt",
  standard: "3 สาขา / 10 สมาชิก · + buffet, stock, advanced printing, advanced reports",
  premium: "5 สาขา / 50 สมาชิก · + QR Ordering, LINE Notify, GPS attendance, advanced permissions",
};

interface PaymentQuoteView {
  plan: PaidTier;
  duration: BillingDuration;
  amount: number | null;
  basePrice: number | null;
  credit: number;
  promotionLabel: string | null;
  discount: number;
  discountLabel: string | null;
  freeTrialAvailable: boolean;
}

function daysLeft(iso: string): number {
  const d = new Date(iso).getTime();
  if (Number.isNaN(d)) return 0;
  return Math.max(0, Math.ceil((d - Date.now()) / 86_400_000));
}

export function BillingManager({
  orgName,
  plan,
  status,
  currentPeriodEnd,
  isActive,
  prices,
  canManage,
  paymentConfigured,
  recipientName,
  slipVerificationReady,
  premiumTrialAvailable,
}: {
  orgName: string;
  plan: BillingPlan;
  status: string;
  currentPeriodEnd: string;
  isActive: boolean;
  prices: Record<PaidTier, Record<BillingDuration, number>>;
  canManage: boolean;
  paymentConfigured: boolean;
  recipientName: string | null;
  slipVerificationReady: boolean;
  premiumTrialAvailable: boolean;
}) {
  const isEnterprise = plan === "enterprise";
  const enterpriseActive = isEnterprise && isActive;
  const isTrial = status === "trialing" && isActive;
  const router = useRouter();
  const searchParams = useSearchParams();
  const expired = searchParams.get("expired") === "1";

  const [selectedPlan, setSelectedPlan] = useState<PaidTier>(premiumTrialAvailable ? "premium" : "starter");
  const [duration, setDuration] = useState<BillingDuration>("30d");
  const [discountCode, setDiscountCode] = useState("");
  const [trialAvailable, setTrialAvailable] = useState(premiumTrialAvailable);
  const [qr, setQr] = useState<SubscriptionQr | null>(null);
  const [amount, setAmount] = useState<number | null>(null);
  const [paymentQuote, setPaymentQuote] = useState<PaymentQuoteView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [feedbackDialog, setFeedbackDialog] = useState<{ title: string; message: string; tone: "success" | "error" } | null>(null);
  const [result, setResult] = useState<{ status: string; reason: string | null; newExpiry: string | null } | null>(null);
  const [uploadPhase, setUploadPhase] = useState<"idle" | "uploading" | "processing">("idle");
  const [uploadPercent, setUploadPercent] = useState(0);

  const price = prices[selectedPlan][duration];
  const selectedPremiumTrial = selectedPlan === "premium" && duration === "30d" && trialAvailable;
  const displayAmount = selectedPremiumTrial && !paymentQuote ? 0 : paymentQuote?.amount ?? price;

  function resetGeneratedPayment() {
    setQr(null);
    setAmount(null);
    setPaymentQuote(null);
  }

  function showError(message: string) {
    setError(message);
    setFeedbackDialog({ title: "ดำเนินการไม่สำเร็จ", message, tone: "error" });
  }

  async function generateQr() {
    const requestPlan = selectedPlan;
    const requestDuration = duration;
    setError(null);
    setResult(null);
    setBusy(true);
    const requestCode = discountCode.trim();
    try {
      const res = await getPaymentQrAction(requestPlan, requestDuration, requestCode || undefined);
      if (!res.ok) {
        showError(res.error ?? "สร้าง QR ไม่สำเร็จ");
        return;
      }
      setAmount(res.amount);
      setPaymentQuote({
        plan: requestPlan,
        duration: requestDuration,
        amount: res.amount,
        basePrice: res.basePrice,
        credit: res.credit,
        promotionLabel: res.promotionLabel,
        discount: res.discount,
        discountLabel: res.discountLabel,
        freeTrialAvailable: res.freeTrialAvailable,
      });
      setQr(res.qr);
    } catch {
      showError("สร้าง QR ไม่สำเร็จ");
    } finally {
      setBusy(false);
    }
  }

  async function handleSlip(file: File) {
    setError(null);
    setResult(null);
    setUploadPercent(0);
    setUploadPhase("uploading");
    const fd = new FormData();
    fd.set("plan", paymentQuote?.plan ?? selectedPlan);
    fd.set("duration", paymentQuote?.duration ?? duration);
    if (discountCode.trim()) fd.set("discountCode", discountCode.trim());
    fd.set("slip", file);
    try {
      const res = await uploadWithProgress<{
        ok?: boolean;
        status?: string;
        reason?: string | null;
        newExpiry?: string | null;
        error?: string;
      }>("/api/billing/verify-slip", fd, (p) => {
        setUploadPercent(p);
        if (p >= 100) setUploadPhase("processing");
      });
      if (!res.ok || !res.data) {
        showError(res.data?.error ?? "ตรวจสลิปไม่สำเร็จ");
        return;
      }
      if (res.data.error) {
        showError(res.data.error);
        return;
      }
      const status = res.data.status ?? "rejected";
      setResult({
        status,
        reason: res.data.reason ?? null,
        newExpiry: res.data.newExpiry ?? null,
      });
      setFeedbackDialog({
        title: status === "verified" ? "ยืนยันการชำระเงินสำเร็จ" : "ตรวจสลิปไม่ผ่าน",
        message: status === "verified"
          ? `ยืนยันการชำระเงินสำเร็จ ใช้งานได้ถึง ${formatDate(res.data.newExpiry ?? null)}`
          : status === "duplicate"
            ? "สลิปนี้ถูกใช้ไปแล้ว"
            : `ตรวจสลิปไม่ผ่าน: ${res.data.reason ?? ""}`,
        tone: status === "verified" ? "success" : "error",
      });
      // Refresh server data so the current-plan panel reflects the new subscription.
      if (status === "verified") {
        resetGeneratedPayment();
        router.refresh();
      }
    } catch {
      showError("ตรวจสลิปไม่สำเร็จ");
    } finally {
      setUploadPhase("idle");
    }
  }

  async function handlePremiumTrial() {
    setError(null);
    setResult(null);
    setBusy(true);
    try {
      const res = await claimPremiumTrialAction();
      if (!res.ok) {
        showError(res.error ?? res.reason ?? "ใช้สิทธิ์ Premium ฟรีไม่สำเร็จ");
        return;
      }
      setResult({ status: "claimed", reason: null, newExpiry: res.newExpiry });
      setTrialAvailable(false);
      resetGeneratedPayment();
      setFeedbackDialog({
        title: "เปิดใช้งาน Premium ฟรีสำเร็จ",
        message: `ใช้งาน Premium ฟรี 30 วัน ได้ถึง ${formatDate(res.newExpiry)}`,
        tone: "success",
      });
      router.refresh();
    } catch {
      showError("ใช้สิทธิ์ Premium ฟรีไม่สำเร็จ");
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
        <span className={`badge ${enterpriseActive ? "badge-brand" : isTrial ? "badge-brand" : isActive ? "badge-success" : "badge-warning"}`}>
          {enterpriseActive
            ? "Enterprise contract"
            : isEnterprise
              ? "ติดต่อผู้ดูแลแพลตฟอร์ม"
              : isTrial
                ? `ทดลองใช้ · เหลือ ${daysLeft(currentPeriodEnd)} วัน`
                : isActive
                  ? "ใช้งานอยู่"
                  : "ยังไม่เปิดใช้งาน"}
        </span>
      </div>

      {enterpriseActive && (
        <p className="rounded-[var(--radius-md)] border border-[var(--tenant-primary)] bg-[var(--tenant-primary-soft)] px-3 py-2 text-sm text-[var(--tenant-primary-strong)]">
          องค์กรนี้ถูกตั้งค่าเป็น Enterprise โดยผู้ดูแลแพลตฟอร์ม: ไม่มีกำหนดหมดอายุ ไม่ต้องต่ออายุแพ็กเกจ และเปิดใช้หลายสาขาได้ตามสัญญา
        </p>
      )}
      {isEnterprise && !isActive && (
        <p className="rounded-[var(--radius-md)] border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          บัญชี Enterprise นี้ยังไม่เปิดใช้งาน กรุณาติดต่อผู้ดูแลแพลตฟอร์มเพื่อเปิดสิทธิ์ใช้งาน
        </p>
      )}
      {!isEnterprise && isTrial && (
        <p className="rounded-[var(--radius-md)] border border-[var(--tenant-primary)] bg-[var(--tenant-primary-soft)] px-3 py-2 text-sm text-[var(--tenant-primary-strong)]">
          คุณกำลังทดลองใช้ฟรี (สิทธิ์ระดับ Premium) เหลืออีก {daysLeft(currentPeriodEnd)} วัน · เลือกแพ็กเกจด้านล่างเพื่อใช้งานต่อหลังหมดทดลอง
        </p>
      )}
      {!isEnterprise && expired && !isActive && (
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
          <InfoItem label={isEnterprise ? "สัญญา" : "แพ็กเกจ"} value={isEnterprise ? "Enterprise contract" : isTrial ? `${PLAN_LABELS[plan]} (ทดลองใช้)` : PLAN_LABELS[plan]} />
          <InfoItem label="สถานะ" value={enterpriseActive ? "ใช้งานอยู่ · ไม่มีกำหนดหมดอายุ" : isEnterprise ? "ต้องติดต่อผู้ดูแลแพลตฟอร์ม" : isTrial ? `ทดลองใช้ · เหลือ ${daysLeft(currentPeriodEnd)} วัน` : isActive ? "ใช้งานอยู่" : "หมดอายุ/ยังไม่ชำระ"} />
          {!isEnterprise && <InfoItem label="ใช้งานได้ถึง" value={formatDate(currentPeriodEnd)} />}
        </div>
      </section>

      {(result?.status === "verified" || result?.status === "claimed") && (
        <p className="rounded-[var(--radius-md)] border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          {result.status === "claimed" ? "เปิดใช้งาน Premium ฟรีสำเร็จ" : "ยืนยันการชำระเงินสำเร็จ"}! ใช้งานได้ถึง {formatDate(result.newExpiry)}
        </p>
      )}
      {result && result.status !== "verified" && result.status !== "claimed" && (
        <p className="rounded-[var(--radius-md)] border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          {result.status === "duplicate" ? "สลิปนี้ถูกใช้ไปแล้ว" : `ตรวจสลิปไม่ผ่าน: ${result.reason ?? ""}`}
        </p>
      )}

      {!isEnterprise && canManage && !paymentConfigured && !trialAvailable && (
        <p className="rounded-[var(--radius-md)] border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          ผู้ดูแลแพลตฟอร์มยังไม่ได้ตั้งค่าช่องทางรับชำระเงิน (PromptPay) กรุณาติดต่อผู้ดูแล
        </p>
      )}

      {!isEnterprise && canManage && (paymentConfigured || trialAvailable) && (
        <section className="panel p-5">
          <h2 className="panel-title mb-3">ต่ออายุ / เปลี่ยนแพ็กเกจ</h2>

          <div className="grid gap-3 md:grid-cols-3">
            {PAID_TIERS.map((t) => (
              <button
                key={t}
                type="button"
                disabled={busy}
                onClick={() => { setSelectedPlan(t); resetGeneratedPayment(); }}
                className={`rounded-[var(--radius-lg)] border p-4 text-left ${
                  selectedPlan === t
                    ? "border-[var(--tenant-primary)] bg-[var(--tenant-primary-soft)]"
                    : "border-[var(--border)] bg-[var(--surface-muted)]"
                } disabled:cursor-not-allowed disabled:opacity-50`}
              >
                <p className="text-sm font-extrabold text-[var(--ink)]">{PLAN_LABELS[t]}</p>
                <p className="mt-1 text-xs text-[var(--muted)]">{TIER_DESC[t]}</p>
              <p className="mt-2 text-xs text-[var(--ink-2)]">
                {prices[t]["30d"].toLocaleString()} / เดือน
              </p>
              {t === "premium" && trialAvailable && (
                <p className="mt-2 text-xs font-bold text-[var(--tenant-primary-strong)]">
                  ลูกค้าใหม่ใช้ฟรี 30 วัน ราคา 0 บาท
                </p>
              )}
              </button>
            ))}
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            {(["30d", "1y"] as BillingDuration[]).map((d) => (
              <button
                key={d}
                type="button"
                disabled={busy}
                onClick={() => { setDuration(d); resetGeneratedPayment(); }}
                className={`min-h-11 rounded-md px-4 text-sm font-bold ${
                  duration === d ? "btn-primary" : "btn-secondary"
                } disabled:cursor-not-allowed disabled:opacity-50`}
              >
                {DURATION_LABELS[d]}
              </button>
            ))}
            <div className="ml-auto text-right">
              <p className="text-xs font-bold uppercase tracking-wide text-[var(--muted)]">
                {paymentQuote ? "ยอดที่ต้องโอน" : "ราคาแพ็กเกจ"}
              </p>
              <p className="text-lg font-extrabold text-[var(--tenant-primary-strong)]">
                {displayAmount.toLocaleString()} บาท
              </p>
            </div>
          </div>

          {!selectedPremiumTrial && (
            <div className="mt-4">
              <label htmlFor="billing-discount-code" className="field-label">
                โค้ดส่วนลด (ถ้ามี)
              </label>
              <input
                id="billing-discount-code"
                type="text"
                value={discountCode}
                onChange={(e) => { setDiscountCode(e.target.value.toUpperCase()); resetGeneratedPayment(); }}
                disabled={busy}
                placeholder="กรอกโค้ดส่วนลด แล้วกดสร้าง QR เพื่อตรวจสอบ"
                maxLength={40}
                className="form-input uppercase tracking-wide disabled:opacity-50"
              />
              <p className="mt-1 text-[11px] text-[var(--muted)]">
                ส่วนลดจะถูกตรวจสอบและหักออกจากยอดเมื่อกดสร้าง QR
              </p>
            </div>
          )}

          {paymentQuote && (
            <div className="mt-3 rounded-md border border-[var(--border)] bg-white p-3 text-sm">
              <p className="font-bold text-[var(--ink)]">ยอดที่ต้องโอนตรงกับ QR ด้านล่าง</p>
              <dl className="mt-2 grid gap-2 text-xs text-[var(--muted)] sm:grid-cols-2">
                <div className="flex justify-between gap-3">
                  <dt>ราคาแพ็กเกจ</dt>
                  <dd className="font-bold text-[var(--ink)]">{(paymentQuote.basePrice ?? price).toLocaleString()} บาท</dd>
                </div>
                {paymentQuote.promotionLabel && (
                  <div className="flex justify-between gap-3">
                    <dt>โปรโมชัน</dt>
                    <dd className="font-bold text-[var(--tenant-primary-strong)]">{paymentQuote.promotionLabel}</dd>
                  </div>
                )}
                {paymentQuote.discount > 0 && (
                  <div className="flex justify-between gap-3">
                    <dt>โค้ดส่วนลด{paymentQuote.discountLabel ? ` · ${paymentQuote.discountLabel}` : ""}</dt>
                    <dd className="font-bold text-emerald-700">-{paymentQuote.discount.toLocaleString()} บาท</dd>
                  </div>
                )}
                {paymentQuote.credit > 0 && (
                  <div className="flex justify-between gap-3">
                    <dt>เครดิตจากแพ็กเกจเดิม</dt>
                    <dd className="font-bold text-emerald-700">-{paymentQuote.credit.toLocaleString()} บาท</dd>
                  </div>
                )}
                <div className="flex justify-between gap-3">
                  <dt>ยอดที่ต้องโอน</dt>
                  <dd className="font-bold text-[var(--tenant-primary-strong)]">{displayAmount.toLocaleString()} บาท</dd>
                </div>
              </dl>
            </div>
          )}

          {selectedPremiumTrial && (
            <div className="mt-3 rounded-md border border-[var(--tenant-primary)] bg-[var(--tenant-primary-soft)] p-3 text-sm">
              <p className="font-bold text-[var(--tenant-primary-strong)]">ใช้ Premium ฟรี 30 วัน</p>
              <p className="mt-1 text-[var(--ink-2)]">
                โปรลูกค้าใหม่ ราคา 0 บาท ใช้ได้ 1 ครั้งต่อบัญชีและ tenant นี้ ไม่ต้องอัปโหลดสลิป
              </p>
              <dl className="mt-2 grid gap-2 text-xs text-[var(--muted)] sm:grid-cols-2">
                <div className="flex justify-between gap-3">
                  <dt>ราคาแพ็กเกจ</dt>
                  <dd className="font-bold text-[var(--ink)]">{price.toLocaleString()} บาท</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt>โปรลูกค้าใหม่</dt>
                  <dd className="font-bold text-[var(--tenant-primary-strong)]">-{price.toLocaleString()} บาท</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt>ยอดที่ต้องชำระ</dt>
                  <dd className="font-bold text-[var(--tenant-primary-strong)]">0 บาท</dd>
                </div>
              </dl>
            </div>
          )}

          {!paymentConfigured && !selectedPremiumTrial && (
            <p className="mt-3 rounded-[var(--radius-md)] border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
              ผู้ดูแลแพลตฟอร์มยังไม่ได้ตั้งค่าช่องทางรับชำระเงิน (PromptPay) กรุณาติดต่อผู้ดูแล
            </p>
          )}

          {selectedPremiumTrial ? (
            <button
              type="button"
              onClick={handlePremiumTrial}
              disabled={busy}
              className="btn-primary mt-4 disabled:opacity-40"
            >
              {busy ? "กำลังเปิดใช้งาน..." : "ใช้ Premium ฟรี 30 วัน"}
            </button>
          ) : (
            <button
              type="button"
              onClick={generateQr}
              disabled={busy || !paymentConfigured}
              className="btn-primary mt-4 disabled:opacity-40"
            >
              {busy ? "กำลังสร้าง..." : "สร้าง QR ชำระเงิน"}
            </button>
          )}

          {qr && (
            <div className="mt-4 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-muted)] p-4">
              <p className="mb-2 text-sm font-bold text-[var(--ink)]">
                โอน {amount?.toLocaleString()} บาท ไปยัง {recipientName ?? "บัญชีผู้รับ"}
              </p>
              {qr.type === "payload" && (
                <div className="flex flex-col items-center">
                  <p className="label-muted mb-2 self-start">สแกน QR นี้ด้วยแอปธนาคารเพื่อชำระเงิน</p>
                  <QrCode value={qr.payload} />
                  {!qr.amountEmbedded && (
                    <p className="mt-2 text-xs text-amber-700">
                      QR นี้ไม่ได้ระบุยอด กรุณาโอนยอด {amount?.toLocaleString()} บาท ด้วยตนเอง
                    </p>
                  )}
                  <details className="mt-3 w-full">
                    <summary className="cursor-pointer text-xs font-bold text-[var(--muted)]">
                      ดู EMVCo Payload (ข้อความ)
                    </summary>
                    <textarea
                      readOnly
                      value={qr.payload}
                      onFocus={(e) => e.currentTarget.select()}
                      rows={3}
                      className="form-input mt-2 break-all font-mono text-xs"
                    />
                  </details>
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
                  disabled={uploadPhase !== "idle"}
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleSlip(f); }}
                  className="text-sm"
                />
                {uploadPhase === "uploading" && (
                  <div className="mt-3">
                    <ProgressBar percent={uploadPercent} label="กำลังอัปโหลดสลิป" />
                  </div>
                )}
                {uploadPhase === "processing" && (
                  <p className="mt-3 text-sm text-[var(--muted)]">กำลังตรวจสอบสลิปกับ slip2go...</p>
                )}
              </div>
            </div>
          )}
        </section>
      )}

      {feedbackDialog && (
        <ModalDialog
          open
          title={feedbackDialog.title}
          onClose={() => setFeedbackDialog(null)}
          size="sm"
        >
          <div
            role="alert"
            className={`rounded-md border px-3 py-2 text-sm ${
              feedbackDialog.tone === "success"
                ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                : "border-red-200 bg-red-50 text-red-700"
            }`}
          >
            {feedbackDialog.message}
          </div>
          <div className="flex justify-end">
            <button type="button" onClick={() => setFeedbackDialog(null)} className="btn-secondary text-xs">
              ปิด
            </button>
          </div>
        </ModalDialog>
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
