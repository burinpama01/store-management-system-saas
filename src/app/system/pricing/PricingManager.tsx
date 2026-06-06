"use client";

import { useActionState } from "react";
import { PLAN_LABELS } from "@/modules/billing/types";
import { DURATION_LABELS, PAID_TIERS, type BillingDuration, type PaidTier } from "@/modules/billing/pricing";
import type { Promotion } from "@/modules/billing/pricing-repository";
import {
  updatePriceAction,
  createPromotionAction,
  togglePromotionAction,
  type PricingState,
} from "./actions";

const INITIAL: PricingState = { error: null, ok: false };
const DURATIONS: BillingDuration[] = ["30d", "1y"];

export function PricingManager({
  prices,
  promotions,
}: {
  prices: Record<PaidTier, Record<BillingDuration, number>>;
  promotions: Promotion[];
}) {
  return (
    <div className="space-y-5">
      <div className="page-header">
        <div>
          <h1 className="page-title">แพ็กเกจ & ราคา</h1>
          <p className="page-kicker">ตั้งราคาแต่ละแพ็กเกจ/ระยะเวลา และโปรโมชั่นส่วนลด</p>
        </div>
      </div>

      <section className="panel p-5">
        <h2 className="panel-title mb-3">ราคาแพ็กเกจ (บาท)</h2>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {PAID_TIERS.map((tier) =>
            DURATIONS.map((duration) => (
              <PriceCell
                key={`${tier}-${duration}`}
                tier={tier}
                duration={duration}
                amount={prices[tier][duration]}
              />
            )),
          )}
        </div>
      </section>

      <section className="panel p-5">
        <h2 className="panel-title mb-3">สร้างโปรโมชั่น (ส่วนลด %)</h2>
        <PromotionForm />
      </section>

      <section className="panel overflow-x-auto p-0">
        <h2 className="panel-title px-4 pt-4">โปรโมชั่นทั้งหมด ({promotions.length})</h2>
        {promotions.length === 0 ? (
          <p className="p-4 text-sm text-[var(--muted)]">ยังไม่มีโปรโมชั่น</p>
        ) : (
          <table className="mt-3 w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--border)] text-left text-xs text-[var(--muted)]">
                <th className="px-4 py-2 font-bold">คำอธิบาย</th>
                <th className="px-4 py-2 text-right font-bold">ส่วนลด</th>
                <th className="px-4 py-2 font-bold">ช่วงเวลา</th>
                <th className="px-4 py-2 font-bold">สถานะ</th>
                <th className="px-4 py-2 font-bold"></th>
              </tr>
            </thead>
            <tbody>
              {promotions.map((p) => (
                <tr key={p.id} className="border-b border-[var(--border)] last:border-0">
                  <td className="px-4 py-2 font-bold text-[var(--ink)]">{p.description}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{p.percentOff}%</td>
                  <td className="px-4 py-2 text-xs text-[var(--muted)]">
                    {fmt(p.startsAt)} – {fmt(p.endsAt)}
                  </td>
                  <td className="px-4 py-2">
                    <span className={`badge ${p.active ? "badge-success" : "badge-warning"}`}>
                      {p.active ? "เปิดใช้" : "ปิด"}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-right">
                    <form action={togglePromotionAction}>
                      <input type="hidden" name="id" value={p.id} />
                      <input type="hidden" name="active" value={p.active ? "0" : "1"} />
                      <button type="submit" className="btn-secondary text-xs">
                        {p.active ? "ปิด" : "เปิด"}
                      </button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

function fmt(iso: string | null) {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString("th-TH", { day: "numeric", month: "short" });
}

function PriceCell({ tier, duration, amount }: { tier: PaidTier; duration: BillingDuration; amount: number }) {
  const [state, action, pending] = useActionState(updatePriceAction, INITIAL);
  return (
    <form action={action} className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-muted)] p-3">
      <input type="hidden" name="tier" value={tier} />
      <input type="hidden" name="duration" value={duration} />
      <p className="label-muted mb-1">{PLAN_LABELS[tier]} · {DURATION_LABELS[duration]}</p>
      <div className="flex items-center gap-2">
        <input
          type="number"
          name="amount"
          defaultValue={amount}
          min={0}
          step={1}
          className="form-input tabular-nums"
        />
        <button type="submit" disabled={pending} className="btn-primary text-xs disabled:opacity-40">
          {pending ? "..." : "บันทึก"}
        </button>
      </div>
      {state.error && <p className="alert-danger mt-2">{state.error}</p>}
      {state.ok && <p className="mt-1 text-xs text-emerald-700">บันทึกแล้ว</p>}
    </form>
  );
}

function PromotionForm() {
  const [state, action, pending] = useActionState(createPromotionAction, INITIAL);
  return (
    <form action={action} className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <div className="xl:col-span-2">
        <label className="field-label">คำอธิบาย</label>
        <input name="description" type="text" required maxLength={120} placeholder="เช่น ลดเปิดตัว 20%" className="form-input" />
      </div>
      <div>
        <label className="field-label">ส่วนลด (%)</label>
        <input name="percentOff" type="number" min={1} max={90} required className="form-input" />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="field-label">เริ่ม</label>
          <input name="startsAt" type="date" className="form-input" />
        </div>
        <div>
          <label className="field-label">สิ้นสุด</label>
          <input name="endsAt" type="date" className="form-input" />
        </div>
      </div>
      <div className="xl:col-span-4">
        {state.error && <p className="alert-danger mb-2">{state.error}</p>}
        {state.ok && <p className="mb-2 text-xs text-emerald-700">สร้างโปรโมชั่นแล้ว</p>}
        <button type="submit" disabled={pending} className="btn-primary disabled:opacity-40">
          {pending ? "กำลังสร้าง..." : "สร้างโปรโมชั่น"}
        </button>
      </div>
    </form>
  );
}
