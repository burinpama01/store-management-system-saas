"use client";

import { useState } from "react";
import Link from "next/link";
import type { PublicPlan } from "@/modules/billing/pricing-repository";
import { ALWAYS_INCLUDED, COMPARISON_FEATURES, featureAvailability, planHighlights } from "./plan-catalog";

const PLAN_COPY: Record<string, { intro: string; cta: string }> = {
  starter: { intro: "เริ่มจัดการงานขายและเมนูของร้าน", cta: "เลือก Starter" },
  standard: { intro: "เพิ่มสต็อก บุฟเฟต์ และรายงานขั้นสูง", cta: "เลือก Standard" },
  premium: { intro: "ให้ลูกค้าสั่งเอง พร้อมเครื่องมือดูแลทีม", cta: "เลือก Premium" },
  business: { intro: "ประกอบแพ็กเกจจากสิ่งที่ร้านใช้", cta: "จัดแพ็กเกจของคุณ" },
  enterprise: { intro: "รวมเครื่องมือสำหรับบริหารหลายสาขา", cta: "สอบถาม Enterprise" },
};
const money = (amount: number | null) => amount === null ? "สอบถามราคา" : `฿${amount.toLocaleString("th-TH")}`;

export function PricingPlans({ plans, freeTrialOpen = false }: Readonly<{ plans: PublicPlan[]; freeTrialOpen?: boolean }>) {
  const [annual, setAnnual] = useState(false);
  const fixed = plans.filter(p => p.tier !== "business" && p.tier !== "enterprise");
  const flexible = plans.filter(p => p.tier === "business" || p.tier === "enterprise");
  function card(plan: PublicPlan) {
    const enterprise = plan.tier === "enterprise";
    const price = annual ? plan.price1y : plan.price30d;
    const copy = PLAN_COPY[plan.tier] ?? PLAN_COPY.starter;
    return <article key={plan.tier} aria-label={`แพ็กเกจ ${plan.displayName}`} className={`pricing-card pricing-card-${plan.tier}${plan.highlight ? " is-featured" : ""}`}>
      <div className="pricing-card-top"><span className="pricing-sculpture" aria-hidden="true"><i/><i/><i/></span>{plan.highlight && <span className="pricing-badge">แพ็กเกจแนะนำ</span>}</div>
      <h2>{plan.displayName}</h2><p className="pricing-intro">{copy.intro}</p>
      <div className="pricing-price" aria-live="polite">{plan.configurable && <small>เริ่มต้น</small>}<strong>{money(price)}</strong>{!enterprise && price !== null && <span>/ {annual ? "365 วัน" : "30 วัน"}</span>}</div>
      {plan.configurable && <p className="pricing-capacity">สมาชิก สาขา และฟีเจอร์ตามที่เลือก</p>}
      {plan.configurable && <p className="pricing-branch-note">หากต้องการเพิ่มสาขา ต้องเลือกฟีเจอร์รายงานหลายสาขาด้วย</p>}
      <Link className={`pricing-action ${plan.highlight ? "is-primary" : ""}`} href={enterprise ? "/enterprise" : `/register?plan=${plan.tier}`}>{copy.cta}<span aria-hidden="true">↗</span></Link>
      <ul>{planHighlights(plan.tier).map(line => <li key={line}><span aria-hidden="true">✓</span>{line}</li>)}</ul>
      {enterprise && <p className="pricing-card-note">ราคาและระยะเวลาเป็นไปตามข้อเสนอของทีมงาน</p>}
    </article>;
  }
  return <>
    {freeTrialOpen && <aside className="pricing-trial"><div><span className="pricing-eyebrow">เริ่มด้วยการลองใช้</span><h2>ทดลอง Enterprise ฟรี 30 วัน</h2><p>สำหรับบัญชีและกิจการที่ยังไม่เคยใช้สิทธิ์ทดลอง และไม่มีแพ็กเกจที่ยังใช้งานอยู่ ระบบตรวจสิทธิ์หลังสมัครหรือเข้าสู่ระบบ</p></div><Link href="/register" className="pricing-action is-primary">เริ่มทดลอง Enterprise<span aria-hidden="true">↗</span></Link></aside>}
    <div className="pricing-selection"><div><h2>เลือกจังหวะที่เหมาะกับร้าน</h2><p>ราคาแพ็กเกจพื้นฐานจากการตั้งค่าปัจจุบันของ StoreOS</p></div><div className="pricing-toggle" role="group" aria-label="รอบการชำระเงิน"><button type="button" aria-pressed={!annual} onClick={() => setAnnual(false)}>30 วัน</button><button type="button" aria-pressed={annual} onClick={() => setAnnual(true)}>1 ปี · 365 วัน</button></div></div>
    {plans.length === 0 ? <p className="pricing-empty" role="status">ยังไม่มีแพ็กเกจแสดงในขณะนี้ กรุณาติดต่อทีม StoreOS</p> : <>
      <section className="pricing-grid" aria-label="แพ็กเกจสำเร็จรูป">{fixed.map(card)}</section>
      {flexible.length > 0 && <section className="pricing-flex-section"><div className="pricing-section-title"><span className="pricing-eyebrow">ร้านคุณ เลือกได้</span><h2>อยากเลือกเอง หรือมีหลายสาขา?</h2></div><div className="pricing-flex-grid">{flexible.map(card)}</div></section>}
      <section className="pricing-comparison"><div className="pricing-section-title"><span className="pricing-eyebrow">ดูให้ชัด ก่อนตัดสินใจ</span><h2>เปรียบเทียบฟีเจอร์หลัก</h2><p>ทุกช่องอ่านจากสิทธิ์จริงของระบบ · Business เลือกซื้อเฉพาะฟีเจอร์ที่ต้องใช้</p></div><div className="pricing-table-scroll" tabIndex={0} role="region" aria-label="ตารางฟีเจอร์ เลื่อนแนวนอนได้"><table aria-label="เปรียบเทียบสิทธิ์แพ็กเกจ"><thead><tr><th scope="col">ฟีเจอร์</th>{plans.map(p => <th scope="col" key={p.tier}>{p.displayName}</th>)}</tr></thead><tbody>{COMPARISON_FEATURES.map(f => <tr key={f.key}><th scope="row">{f.label}</th>{plans.map(p => <td key={p.tier} className={featureAvailability(p.tier, f.key) === "รวมแล้ว" ? "is-included" : ""}>{featureAvailability(p.tier, f.key)}</td>)}</tr>)}</tbody></table></div></section>
    </>}
    <section className="pricing-included" aria-label="ความสามารถที่ได้ทุกแพ็กเกจ"><div className="pricing-section-title"><span className="pricing-eyebrow">ได้ทุกแพ็กเกจ</span><h2>ใช้ได้เลย ไม่ต้องซื้อเพิ่ม</h2><p>ความสามารถพื้นฐานที่ไม่ผูกกับแพ็กเกจ ทุกร้านใช้ได้ตั้งแต่วันแรก</p></div><ul className="pricing-included-grid">{ALWAYS_INCLUDED.map(item => <li key={item.title}><span aria-hidden="true">✓</span><div><strong>{item.title}</strong><small>{item.detail}</small></div></li>)}</ul></section>
    <p className="pricing-terms">ราคาแสดงเป็นบาทต่อรอบที่เลือก โปรโมชันหรือโค้ดส่วนลดที่เข้าเงื่อนไขจะคำนวณในหน้าชำระเงิน กรุณาตรวจยอดสุดท้ายก่อนยืนยัน ฟีเจอร์บางส่วนต้องตั้งค่าร้าน อุปกรณ์ หรือบริการที่เชื่อมต่อก่อนใช้งาน</p>
  </>;
}
