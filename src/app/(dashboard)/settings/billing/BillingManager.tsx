"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import type { BillingPlan, BillingState, BillingStatus, PlanFeatures } from "@/modules/billing/types";
import { PLAN_LABELS } from "@/modules/billing/types";

type CheckoutPlan = Exclude<BillingPlan, "free">;

const STATUS_LABELS: Record<BillingStatus, string> = {
  active: "ใช้งานอยู่",
  trialing: "ช่วงทดลองใช้",
  past_due: "ค้างชำระ",
  incomplete: "รอชำระเงินครั้งแรก",
  incomplete_expired: "การสมัครหมดอายุ",
  unpaid: "ยังไม่ชำระเงิน",
  canceled: "ยกเลิกแล้ว",
  paused: "พักการใช้งาน",
};

const STATUS_BADGE: Record<BillingStatus, string> = {
  active: "badge-success",
  trialing: "badge-brand",
  past_due: "badge-warning",
  incomplete: "badge-warning",
  incomplete_expired: "badge-warning",
  unpaid: "badge-warning",
  canceled: "badge-warning",
  paused: "badge-warning",
};

const PLAN_INFO: Record<
  CheckoutPlan,
  { price: string; target: string; highlights: string[] }
> = {
  starter: {
    price: "490–690 บาท/เดือน",
    target: "ร้านอาหารทั่วไป / คาเฟ่ขนาดเล็ก",
    highlights: ["POS พื้นฐาน", "รายรับ-รายจ่าย", "พิมพ์ใบเสร็จผ่าน Browser", "ประวัติลูกค้า"],
  },
  standard: {
    price: "990–1,290 บาท/เดือน",
    target: "ร้านบุฟเฟต์ / หมูกระทะ (ไม่มี QR)",
    highlights: ["ทุกอย่างใน Starter", "จัดการบุฟเฟต์", "จัดการสต็อก", "พิมพ์ Bluetooth/USB/IP"],
  },
  premium: {
    price: "1,590–2,290 บาท/เดือน",
    target: "ร้านบุฟเฟต์ที่ต้องการลดพนักงาน",
    highlights: ["ทุกอย่างใน Standard", "QR Food Ordering", "LINE Notify", "ลงเวลา GPS + คอมมิชชั่น"],
  },
  enterprise: {
    price: "Custom Quote",
    target: "ร้านหลายสาขา",
    highlights: ["จัดการสาขาแบบศูนย์กลาง", "รายงานรวมหลายสาขา", "API Integration", "Support พิเศษ"],
  },
};

const PLAN_ORDER: CheckoutPlan[] = ["starter", "standard", "premium", "enterprise"];

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("th-TH", { year: "numeric", month: "short", day: "numeric" });
}

function formatLimit(value: number): string {
  return Number.isFinite(value) ? String(value) : "ไม่จำกัด";
}

export function BillingManager({
  billingState,
  features,
  canManage,
  hasCustomer,
  priceIds,
  orgName,
}: {
  billingState: BillingState;
  features: PlanFeatures;
  canManage: boolean;
  hasCustomer: boolean;
  priceIds: Record<CheckoutPlan, string | null>;
  orgName: string;
}) {
  const searchParams = useSearchParams();
  const checkoutResult = searchParams.get("checkout");
  const [error, setError] = useState<string | null>(null);
  const [pendingPlan, setPendingPlan] = useState<CheckoutPlan | "portal" | null>(null);

  async function startCheckout(plan: CheckoutPlan) {
    const priceId = priceIds[plan];
    if (!priceId) {
      setError(`ยังไม่ได้ตั้งค่า price ของแพ็กเกจ ${PLAN_LABELS[plan]} (STRIPE_PRICE_*)`);
      return;
    }
    setError(null);
    setPendingPlan(plan);
    try {
      const res = await fetch("/api/stripe/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ priceId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.url) {
        setError(data.error ?? "เริ่มการสมัครไม่สำเร็จ");
        setPendingPlan(null);
        return;
      }
      window.location.assign(data.url);
    } catch {
      setError("เชื่อมต่อระบบชำระเงินไม่สำเร็จ");
      setPendingPlan(null);
    }
  }

  async function openPortal() {
    setError(null);
    setPendingPlan("portal");
    try {
      const res = await fetch("/api/stripe/portal", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.url) {
        setError(data.error ?? "เปิด Customer Portal ไม่สำเร็จ");
        setPendingPlan(null);
        return;
      }
      window.location.assign(data.url);
    } catch {
      setError("เชื่อมต่อระบบชำระเงินไม่สำเร็จ");
      setPendingPlan(null);
    }
  }

  return (
    <div className="page-shell">
      <div className="page-header">
        <div>
          <h1 className="page-title">การเรียกเก็บเงิน & แพ็กเกจ</h1>
          <p className="page-kicker">{orgName} · จัดการ subscription ผ่าน Stripe</p>
        </div>
        <span className="badge badge-brand">Billing</span>
      </div>

      {checkoutResult === "success" && (
        <p className="rounded-[var(--radius-md)] border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          เริ่มการสมัครสำเร็จ ระบบจะอัปเดตสถานะแพ็กเกจหลัง Stripe ยืนยันการชำระเงิน
        </p>
      )}
      {checkoutResult === "cancel" && (
        <p className="rounded-[var(--radius-md)] border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          ยกเลิกการสมัครแล้ว ยังไม่มีการเรียกเก็บเงิน
        </p>
      )}
      {error && <p className="alert-danger">{error}</p>}

      {!canManage && (
        <p className="rounded-[var(--radius-md)] border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          คุณดูข้อมูลแพ็กเกจได้ แต่ไม่มีสิทธิ์จัดการการเรียกเก็บเงิน (ต้องมีสิทธิ์ billing.manage)
        </p>
      )}

      <section className="panel max-w-3xl p-5">
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="panel-title">แพ็กเกจปัจจุบัน</h2>
            <p className="label-muted">สถานะและขีดจำกัดของแพ็กเกจที่ใช้งานอยู่</p>
          </div>
          <span className={`badge ${STATUS_BADGE[billingState.status]}`}>
            {STATUS_LABELS[billingState.status]}
          </span>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <InfoItem label="แพ็กเกจ" value={PLAN_LABELS[billingState.plan]} />
          <InfoItem label="สถานะ" value={STATUS_LABELS[billingState.status]} />
          <InfoItem label="จำนวนสาขาสูงสุด" value={formatLimit(features.maxStores)} />
          <InfoItem label="จำนวนสมาชิกสูงสุด" value={formatLimit(features.maxMembers)} />
          <InfoItem label="รอบบิลถัดไป" value={formatDate(billingState.currentPeriodEnd)} />
          <InfoItem
            label="สิ้นสุดทดลองใช้"
            value={billingState.trialEnd ? formatDate(billingState.trialEnd) : "—"}
          />
        </div>

        {billingState.cancelAtPeriodEnd && (
          <p className="mt-4 rounded-[var(--radius-md)] border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            แพ็กเกจจะถูกยกเลิกเมื่อสิ้นสุดรอบบิลปัจจุบัน ({formatDate(billingState.currentPeriodEnd)})
          </p>
        )}
        {billingState.status === "past_due" && (
          <p className="mt-4 rounded-[var(--radius-md)] border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            มียอดค้างชำระ กรุณาอัปเดตวิธีชำระเงินผ่าน Customer Portal เพื่อใช้งานต่อเนื่อง
          </p>
        )}

        {canManage && hasCustomer && (
          <button
            type="button"
            onClick={openPortal}
            disabled={pendingPlan !== null}
            className="btn-secondary mt-4 disabled:opacity-40"
          >
            {pendingPlan === "portal" ? "กำลังเปิด..." : "จัดการการชำระเงิน (Customer Portal)"}
          </button>
        )}
      </section>

      <section className="panel p-5">
        <div className="mb-4">
          <h2 className="panel-title">เลือกแพ็กเกจ</h2>
          <p className="label-muted">อัปเกรด/ดาวน์เกรดผ่าน Stripe Checkout</p>
        </div>

        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          {PLAN_ORDER.map((plan) => {
            const info = PLAN_INFO[plan];
            const isCurrent = billingState.plan === plan;
            const isEnterprise = plan === "enterprise";
            return (
              <div
                key={plan}
                className={`flex flex-col rounded-[var(--radius-lg)] border p-4 ${
                  isCurrent
                    ? "border-[var(--tenant-primary)] bg-[var(--tenant-primary-soft)]"
                    : "border-[var(--border)] bg-[var(--surface-muted)]"
                }`}
              >
                <div className="mb-2 flex items-center justify-between gap-2">
                  <p className="text-sm font-extrabold text-[var(--ink)]">{PLAN_LABELS[plan]}</p>
                  {isCurrent && <span className="badge badge-brand">ปัจจุบัน</span>}
                </div>
                <p className="text-lg font-extrabold text-[var(--tenant-primary-strong)]">{info.price}</p>
                <p className="mt-1 text-xs text-[var(--muted)]">{info.target}</p>
                <ul className="mt-3 flex-1 space-y-1">
                  {info.highlights.map((h) => (
                    <li key={h} className="text-xs text-[var(--ink-2)]">• {h}</li>
                  ))}
                </ul>
                <div className="mt-4">
                  {isEnterprise ? (
                    <a
                      href="mailto:sales@storeos.app?subject=Enterprise%20Quote"
                      className="btn-secondary w-full text-center text-xs"
                    >
                      ติดต่อฝ่ายขาย
                    </a>
                  ) : (
                    <button
                      type="button"
                      onClick={() => startCheckout(plan)}
                      disabled={!canManage || isCurrent || pendingPlan !== null}
                      className="btn-primary w-full text-xs disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {pendingPlan === plan
                        ? "กำลังเปิด..."
                        : isCurrent
                          ? "แพ็กเกจปัจจุบัน"
                          : "เลือกแพ็กเกจนี้"}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </section>
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
