"use client";

import { useState } from "react";
import Link from "next/link";
import type { PublicPlan } from "@/modules/billing/pricing-repository";
import { GlassPanel } from "@/shared/components/marketing/MarketingShell";

type BillingPeriod = "30d" | "1y";

const PLAN_COPY: Record<string, { icon: string; intro: string; cta: string }> = {
  starter: {
    icon: "▣",
    intro: "เหมาะสำหรับร้านเริ่มต้นที่อยากมีระบบครบพื้นฐาน",
    cta: "เริ่มใช้งาน",
  },
  standard: {
    icon: "◇",
    intro: "เหมาะสำหรับร้านที่เติบโต เพิ่มประสิทธิภาพการจัดการ",
    cta: "เริ่มใช้งาน",
  },
  premium: {
    icon: "♕",
    intro: "เหมาะสำหรับร้านที่ต้องการครบทุกเครื่องมือและระบบขั้นสูง",
    cta: "ทดลองใช้ฟรี 30 วัน",
  },
  business: {
    icon: "⚙",
    intro: "ออกแบบแพ็กเกจเอง เลือกที่นั่ง สาขา และฟีเจอร์ที่ใช้จริง",
    cta: "เลือกฟีเจอร์เอง",
  },
  enterprise: {
    icon: "▥",
    intro: "เหมาะสำหรับธุรกิจขนาดใหญ่ ปรับแต่งระบบและดูแลพิเศษ",
    cta: "ติดต่อฝ่ายขาย",
  },
};

function formatPrice(amount: number | null) {
  return amount == null ? "สอบถามราคา" : `฿ ${amount.toLocaleString("th-TH")}`;
}

export function PricingPlans({ plans }: Readonly<{ plans: PublicPlan[] }>) {
  const [billingPeriod, setBillingPeriod] = useState<BillingPeriod>("30d");
  const isAnnual = billingPeriod === "1y";

  return (
    <>
      <div className="reference-billing-toggle" role="group" aria-label="รอบการชำระเงิน">
        <button
          type="button"
          className={!isAnnual ? "is-active" : ""}
          aria-pressed={!isAnnual}
          onClick={() => setBillingPeriod("30d")}
        >
          รายเดือน
        </button>
        <button
          type="button"
          className={isAnnual ? "is-active" : ""}
          aria-pressed={isAnnual}
          onClick={() => setBillingPeriod("1y")}
        >
          รายปี ประหยัดสูงสุด 20%
        </button>
      </div>

      <section className="reference-pricing-grid" aria-label="แพ็กเกจ StoreOS">
        {plans.map((plan) => {
          const copy = PLAN_COPY[plan.tier] ?? PLAN_COPY.starter;
          const isPremium = plan.tier === "premium";
          const isEnterprise = plan.price30d == null;
          const isConfigurable = plan.configurable;
          const activePrice = isAnnual ? plan.price1y : plan.price30d;
          const inactivePrice = isAnnual ? plan.price30d : plan.price1y;

          return (
            <GlassPanel
              key={plan.tier}
              className={`reference-plan-card${plan.highlight || isPremium ? " is-highlight" : ""}`}
            >
              {isPremium && <span className="reference-plan-ribbon">แนะนำ</span>}
              <span className="reference-plan-icon">{copy.icon}</span>
              <h2>{plan.displayName}</h2>
              <p>{copy.intro}</p>

              <div className="reference-plan-price">
                {isEnterprise ? (
                  <>
                    <strong>สอบถามราคา</strong>
                    <small>ทีมงานช่วยออกแบบแพ็กเกจและเงื่อนไขรายปีให้เหมาะกับหลายสาขา</small>
                  </>
                ) : isConfigurable ? (
                  <>
                    <strong>เริ่มต้น {formatPrice(activePrice)}</strong>
                    <span>/ {isAnnual ? "ปี" : "เดือน"}</span>
                    <small>ราคาขึ้นกับจำนวนที่นั่ง สาขา และฟีเจอร์ที่เลือก</small>
                    <small>ปรับแต่งและชำระได้ในหน้าตั้งค่าแพ็กเกจหลังสมัคร</small>
                  </>
                ) : isPremium ? (
                  <>
                    <strong className="reference-trial-price">0 บาท</strong>
                    <span className="reference-trial-period">/ 30 วันแรก</span>
                    <small>
                      หลังจากนั้น {formatPrice(activePrice)} / {isAnnual ? "ปี" : "เดือน"}
                    </small>
                    <small>โปร Premium ฟรี 30 วันใช้ได้ 1 ครั้งต่อบัญชี</small>
                  </>
                ) : (
                  <>
                    <strong>{formatPrice(activePrice)}</strong>
                    <span>/ {isAnnual ? "ปี" : "เดือน"}</span>
                    <small>
                      {isAnnual ? "รายเดือน" : "รายปี"} {formatPrice(inactivePrice)} /{" "}
                      {isAnnual ? "เดือน" : "ปี"}
                    </small>
                  </>
                )}
              </div>

              <Link
                href={isEnterprise ? "/enterprise" : `/register?plan=${plan.tier}`}
                className={isPremium ? "btn-primary reference-plan-action" : "btn-secondary reference-plan-action"}
              >
                {copy.cta}
              </Link>

              <ul>
                {plan.featureLines.map((feature) => (
                  <li key={feature}>{feature}</li>
                ))}
              </ul>
            </GlassPanel>
          );
        })}
      </section>
    </>
  );
}
