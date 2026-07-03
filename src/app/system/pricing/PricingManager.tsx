"use client";

import { useActionState } from "react";
import { Button, SubmitButton } from "@/shared/components/ui";
import { PLAN_LABELS } from "@/modules/billing/types";
import { DURATION_LABELS, PAID_TIERS, type BillingDuration, type PaidTier } from "@/modules/billing/pricing";
import {
  BUSINESS_COMPONENTS,
  BUSINESS_COMPONENT_LABELS,
  type BusinessComponent,
  type BusinessPriceMap,
} from "@/modules/billing/business-plan";
import type { Promotion, PlanSetting } from "@/modules/billing/pricing-repository";
import type { BillingDiscountCode, DiscountablePlan } from "@/modules/billing/discount-code";
import {
  updatePriceAction,
  updateBusinessPriceAction,
  createPromotionAction,
  togglePromotionAction,
  updatePlanSettingsAction,
  createDiscountCodeAction,
  toggleDiscountCodeAction,
  type PricingState,
} from "./actions";

const INITIAL: PricingState = { error: null, ok: false };
const DURATIONS: BillingDuration[] = ["30d", "1y"];
const SCOPABLE_PLANS: DiscountablePlan[] = [...PAID_TIERS, "business"];

export function PricingManager({
  prices,
  businessPrices,
  promotions,
  planSettings,
  discountCodes,
}: {
  prices: Record<PaidTier, Record<BillingDuration, number>>;
  businessPrices: BusinessPriceMap;
  promotions: Promotion[];
  planSettings: PlanSetting[];
  discountCodes: BillingDiscountCode[];
}) {
  return (
    <div className="space-y-5">
      <div className="page-header">
        <div>
          <h1 className="page-title">แพ็กเกจ & ราคา</h1>
          <p className="page-kicker">ตั้งราคา ชื่อแพ็กเกจ การแสดงบน landing และโปรโมชั่น</p>
        </div>
      </div>

      <section className="panel p-5">
        <h2 className="panel-title mb-3">ราคาแพ็กเกจ (บาท)</h2>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {PAID_TIERS.map((tier) =>
            DURATIONS.map((duration) => (
              <PriceCell key={`${tier}-${duration}`} tier={tier} duration={duration} amount={prices[tier][duration]} />
            )),
          )}
        </div>
      </section>

      <section className="panel p-5">
        <h2 className="panel-title mb-3">ราคาแพ็กเกจ Business — คิดตามส่วนประกอบ (บาท)</h2>
        <p className="page-kicker mb-3">
          ลูกค้าเลือกที่นั่ง/สาขา/ฟีเจอร์เอง · ราคา = ค่าระบบพื้นฐาน + (ที่นั่ง × ราคาต่อที่นั่ง) + (สาขา × ราคาต่อสาขา) + ฟีเจอร์ที่เลือก
        </p>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {BUSINESS_COMPONENTS.map((component) =>
            DURATIONS.map((duration) => (
              <BusinessPriceCell
                key={`${component}-${duration}`}
                component={component}
                duration={duration}
                amount={businessPrices[component][duration]}
              />
            )),
          )}
        </div>
      </section>

      <section className="panel p-5">
        <h2 className="panel-title mb-3">แพ็กเกจบน landing (ชื่อ/ฟีเจอร์/การแสดง)</h2>
        <div className="grid gap-3 md:grid-cols-2">
          {planSettings.map((p) => (
            <PlanSettingCard key={p.tier} setting={p} />
          ))}
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
                <th className="px-4 py-2 font-bold">เฉพาะแพ็กเกจ</th>
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
                  <td className="px-4 py-2">{p.plan ? PLAN_LABELS[p.plan] : "ทุกแพ็กเกจ"}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{p.percentOff}%</td>
                  <td className="px-4 py-2 text-xs text-[var(--muted)]">{fmt(p.startsAt)} – {fmt(p.endsAt)}</td>
                  <td className="px-4 py-2">
                    <span className={`badge ${p.active ? "badge-success" : "badge-warning"}`}>
                      {p.active ? "เปิดใช้" : "ปิด"}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-right">
                    <form action={togglePromotionAction}>
                      <input type="hidden" name="id" value={p.id} />
                      <input type="hidden" name="active" value={p.active ? "0" : "1"} />
                      <SubmitButton variant="secondary" className="text-xs">{p.active ? "ปิด" : "เปิด"}</SubmitButton>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="panel p-5">
        <h2 className="panel-title mb-3">สร้างโค้ดส่วนลด (ใช้ตอนซื้อแพ็กเกจ)</h2>
        <DiscountCodeForm />
      </section>

      <section className="panel overflow-x-auto p-0">
        <h2 className="panel-title px-4 pt-4">โค้ดส่วนลดทั้งหมด ({discountCodes.length})</h2>
        {discountCodes.length === 0 ? (
          <p className="p-4 text-sm text-[var(--muted)]">ยังไม่มีโค้ดส่วนลด</p>
        ) : (
          <table className="mt-3 w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--border)] text-left text-xs text-[var(--muted)]">
                <th className="px-4 py-2 font-bold">โค้ด</th>
                <th className="px-4 py-2 font-bold">คำอธิบาย</th>
                <th className="px-4 py-2 text-right font-bold">ส่วนลด</th>
                <th className="px-4 py-2 font-bold">ขอบเขต</th>
                <th className="px-4 py-2 font-bold">จำกัดใช้</th>
                <th className="px-4 py-2 font-bold">ช่วงเวลา</th>
                <th className="px-4 py-2 font-bold">สถานะ</th>
                <th className="px-4 py-2 font-bold"></th>
              </tr>
            </thead>
            <tbody>
              {discountCodes.map((c) => (
                <tr key={c.id} className="border-b border-[var(--border)] last:border-0">
                  <td className="px-4 py-2 font-mono font-bold text-[var(--ink)]">{c.normalizedCode}</td>
                  <td className="px-4 py-2 text-[var(--ink-2)]">{c.description}</td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    {c.discountType === "percentage" ? `${c.discountValue}%` : `${c.discountValue.toLocaleString()} บาท`}
                  </td>
                  <td className="px-4 py-2 text-xs text-[var(--muted)]">
                    {c.plan ? PLAN_LABELS[c.plan] : "ทุกแพ็กเกจ"}
                    {" · "}
                    {c.duration ? DURATION_LABELS[c.duration] : "ทุกระยะเวลา"}
                  </td>
                  <td className="px-4 py-2 text-xs text-[var(--muted)]">
                    รวม {c.maxRedemptions ?? "∞"} · /ราย {c.maxRedemptionsPerOrg ?? "∞"}
                  </td>
                  <td className="px-4 py-2 text-xs text-[var(--muted)]">{fmt(c.startsAt)} – {fmt(c.endsAt)}</td>
                  <td className="px-4 py-2">
                    <span className={`badge ${c.active ? "badge-success" : "badge-warning"}`}>
                      {c.active ? "เปิดใช้" : "ปิด"}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-right">
                    <form action={toggleDiscountCodeAction}>
                      <input type="hidden" name="id" value={c.id} />
                      <input type="hidden" name="active" value={c.active ? "0" : "1"} />
                      <SubmitButton variant="secondary" className="text-xs">{c.active ? "ปิด" : "เปิด"}</SubmitButton>
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
        <input type="number" name="amount" defaultValue={amount} min={0} step={1} className="form-input tabular-nums" />
        <Button type="submit" variant="primary" loading={pending} loadingText="..." className="text-xs disabled:opacity-40">
          บันทึก
        </Button>
      </div>
      {state.error && <p className="alert-danger mt-2">{state.error}</p>}
      {state.ok && <p className="mt-1 text-xs text-emerald-700">บันทึกแล้ว</p>}
    </form>
  );
}

function BusinessPriceCell({
  component,
  duration,
  amount,
}: {
  component: BusinessComponent;
  duration: BillingDuration;
  amount: number;
}) {
  const [state, action, pending] = useActionState(updateBusinessPriceAction, INITIAL);
  return (
    <form action={action} className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-muted)] p-3">
      <input type="hidden" name="component" value={component} />
      <input type="hidden" name="duration" value={duration} />
      <p className="label-muted mb-1">{BUSINESS_COMPONENT_LABELS[component]} · {DURATION_LABELS[duration]}</p>
      <div className="flex items-center gap-2">
        <input type="number" name="amount" defaultValue={amount} min={0} step={1} className="form-input tabular-nums" />
        <Button type="submit" variant="primary" loading={pending} loadingText="..." className="text-xs disabled:opacity-40">
          บันทึก
        </Button>
      </div>
      {state.error && <p className="alert-danger mt-2">{state.error}</p>}
      {state.ok && <p className="mt-1 text-xs text-emerald-700">บันทึกแล้ว</p>}
    </form>
  );
}

function PlanSettingCard({ setting }: { setting: PlanSetting }) {
  const [state, action, pending] = useActionState(updatePlanSettingsAction, INITIAL);
  return (
    <form action={action} className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-muted)] p-3 space-y-2">
      <input type="hidden" name="tier" value={setting.tier} />
      <p className="label-muted">{setting.tier}</p>
      <input name="displayName" defaultValue={setting.displayName} className="form-input" placeholder="ชื่อแพ็กเกจ" />
      <textarea
        name="featureLines"
        defaultValue={setting.featureLines.join("\n")}
        rows={4}
        className="form-input text-xs"
        placeholder="ฟีเจอร์ บรรทัดละ 1 รายการ"
      />
      <div className="flex flex-wrap gap-4 text-xs text-[var(--ink-2)]">
        <label className="flex items-center gap-1">
          <input type="checkbox" name="visibleOnLanding" value="1" defaultChecked={setting.visibleOnLanding} />
          แสดงบน landing
        </label>
        <label className="flex items-center gap-1">
          <input type="checkbox" name="highlight" value="1" defaultChecked={setting.highlight} />
          แนะนำ (highlight)
        </label>
      </div>
      {state.error && <p className="alert-danger">{state.error}</p>}
      {state.ok && <p className="text-xs text-emerald-700">บันทึกแล้ว</p>}
      <Button type="submit" variant="primary" loading={pending} loadingText="กำลังบันทึก..." className="text-xs disabled:opacity-40">
        บันทึก
      </Button>
    </form>
  );
}

function PromotionForm() {
  const [state, action, pending] = useActionState(createPromotionAction, INITIAL);
  return (
    <form action={action} className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
      <div className="xl:col-span-2">
        <label className="field-label">คำอธิบาย</label>
        <input name="description" type="text" required maxLength={120} placeholder="เช่น ลดเปิดตัว 20%" className="form-input" />
      </div>
      <div>
        <label className="field-label">เฉพาะแพ็กเกจ</label>
        <select name="plan" className="form-input">
          <option value="">ทุกแพ็กเกจ</option>
          {SCOPABLE_PLANS.map((t) => (
            <option key={t} value={t}>{PLAN_LABELS[t]}</option>
          ))}
        </select>
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
      <div className="xl:col-span-5">
        {state.error && <p className="alert-danger mb-2">{state.error}</p>}
        {state.ok && <p className="mb-2 text-xs text-emerald-700">สร้างโปรโมชั่นแล้ว</p>}
        <Button type="submit" variant="primary" loading={pending} loadingText="กำลังสร้าง..." className="disabled:opacity-40">
          สร้างโปรโมชั่น
        </Button>
      </div>
    </form>
  );
}

function DiscountCodeForm() {
  const [state, action, pending] = useActionState(createDiscountCodeAction, INITIAL);
  return (
    <form action={action} className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <div>
        <label className="field-label">โค้ด</label>
        <input name="code" type="text" required maxLength={40} placeholder="เช่น NEWYEAR50" className="form-input font-mono uppercase" />
      </div>
      <div className="xl:col-span-2">
        <label className="field-label">คำอธิบาย</label>
        <input name="description" type="text" required maxLength={120} placeholder="เช่น ส่วนลดปีใหม่" className="form-input" />
      </div>
      <div>
        <label className="field-label">ประเภท</label>
        <select name="discountType" className="form-input">
          <option value="percentage">เปอร์เซ็นต์ (%)</option>
          <option value="fixed">จำนวนเงิน (บาท)</option>
        </select>
      </div>
      <div>
        <label className="field-label">มูลค่าส่วนลด</label>
        <input name="discountValue" type="number" min={1} step="0.01" required className="form-input" />
      </div>
      <div>
        <label className="field-label">เฉพาะแพ็กเกจ</label>
        <select name="plan" className="form-input">
          <option value="">ทุกแพ็กเกจ</option>
          {SCOPABLE_PLANS.map((t) => (
            <option key={t} value={t}>{PLAN_LABELS[t]}</option>
          ))}
        </select>
      </div>
      <div>
        <label className="field-label">เฉพาะระยะเวลา</label>
        <select name="duration" className="form-input">
          <option value="">ทุกระยะเวลา</option>
          {DURATIONS.map((d) => (
            <option key={d} value={d}>{DURATION_LABELS[d]}</option>
          ))}
        </select>
      </div>
      <div>
        <label className="field-label">ยอดขั้นต่ำ (บาท)</label>
        <input name="minAmount" type="number" min={0} step={1} defaultValue={0} className="form-input" />
      </div>
      <div>
        <label className="field-label">จำกัดใช้รวม (ว่าง = ไม่จำกัด)</label>
        <input name="maxRedemptions" type="number" min={1} step={1} placeholder="∞" className="form-input" />
      </div>
      <div>
        <label className="field-label">จำกัดต่อบัญชี (ว่าง = ไม่จำกัด)</label>
        <input name="maxRedemptionsPerOrg" type="number" min={1} step={1} placeholder="∞" className="form-input" />
      </div>
      <div className="grid grid-cols-2 gap-2 xl:col-span-2">
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
        {state.ok && <p className="mb-2 text-xs text-emerald-700">สร้างโค้ดส่วนลดแล้ว</p>}
        <Button type="submit" variant="primary" loading={pending} loadingText="กำลังสร้าง..." className="disabled:opacity-40">
          สร้างโค้ดส่วนลด
        </Button>
      </div>
    </form>
  );
}
