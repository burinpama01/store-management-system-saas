// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { PricingPlans } from "@/app/pricing/PricingPlans";
import type { PublicPlan } from "@/modules/billing/pricing-repository";

vi.stubGlobal("React", React);
afterEach(cleanup);
const plans: PublicPlan[] = [
  { tier: "standard", displayName: "Standard", price30d: 299, price1y: 2990, highlight: false, configurable: false, featureLines: [] },
  { tier: "starter", displayName: "Starter", price30d: 123, price1y: 1200, highlight: false, configurable: false, featureLines: ["สั่งอาหารผ่าน QR", "กำไรแน่นอน"] },
  { tier: "premium", displayName: "Premium", price30d: 456, price1y: 4500, highlight: true, configurable: false, featureLines: [] },
  { tier: "business", displayName: "Business", price30d: 550, price1y: 5500, highlight: false, configurable: true, featureLines: [] },
  { tier: "enterprise", displayName: "Enterprise", price30d: null, price1y: null, highlight: false, configurable: false, featureLines: [] },
];
describe("public pricing reflects current prices and entitlements", () => {
  it("uses supplied prices, exact durations and audited tier features instead of stale marketing text", () => {
    render(<PricingPlans plans={plans} />);
    const starter = screen.getByRole("article", { name: "แพ็กเกจ Starter" });
    expect(within(starter).getByText("฿123")).toBeTruthy();
    expect(within(starter).queryByText("สั่งอาหารผ่าน QR")).toBeNull();
    // เจ้าของร้านสั่งเอาเพดานสาขา/สมาชิกออกจากหน้าแพ็กเกจ (2026-09-07) — สิทธิ์เพิ่มสาขายังดูได้ในตารางเปรียบเทียบ
    expect(screen.queryByText(/เพดาน/)).toBeNull();
    expect(screen.queryByText("แพ็กเกจนี้ยังเพิ่มสาขาเองไม่ได้")).toBeNull();
    expect(screen.queryByRole("row", { name: /เพดานจำนวนสาขา/ })).toBeNull();
    expect(screen.getByRole("row", { name: /เพิ่มสาขาและรายงานหลายสาขา/ })).toBeTruthy();
    expect(screen.queryByText("กำไรแน่นอน")).toBeNull();
    expect(screen.queryByText(/20%/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "1 ปี · 365 วัน" }));
    expect(within(starter).getByText("฿1,200")).toBeTruthy();
    expect(within(starter).getByText("/ 365 วัน")).toBeTruthy();
    expect(screen.getByRole("table", { name: "เปรียบเทียบสิทธิ์แพ็กเกจ" })).toBeTruthy();
    expect(within(starter).getByRole("link").getAttribute("href")).toBe("/register?plan=starter");
  });

  it("lists the newest entitlements and the capabilities every plan already has", () => {
    render(<PricingPlans plans={plans} />);
    // ฟีเจอร์ใหม่ที่มี feature gate จริงต้องอยู่ในตารางเปรียบเทียบ
    for (const label of ["AI สแกนเมนูจากรูปภาพ", "ผู้ช่วย AI ช่วยแก้ปัญหาอุปกรณ์", "เชื่อมต่อเดลิเวอรีและ API"]) {
      expect(screen.getByRole("row", { name: new RegExp(label) })).toBeTruthy();
    }
    // aiForecast ยังไม่มีฟีเจอร์ให้ผู้ใช้จริง ห้ามโฆษณา
    expect(screen.queryByText(/พยากรณ์/)).toBeNull();
    // ความสามารถที่ไม่มี feature gate ต้องบอกว่าได้ทุกแพ็กเกจ ไม่ใช่ปล่อยหาย
    const included = screen.getByRole("region", { name: "ความสามารถที่ได้ทุกแพ็กเกจ" });
    expect(within(included).getByText("สั่งงานด้วยเสียงในหน้าขาย")).toBeTruthy();
    expect(within(included).getByText("พิมพ์ผ่านคอมพิวเตอร์ร้าน")).toBeTruthy();
    expect(within(included).getByText("ลงเวลาและคำนวณเงินเดือน")).toBeTruthy();
  });
  it("keeps Enterprise contract pricing separate from trial and describes minimum Business configuration", () => {
    render(<PricingPlans plans={plans} freeTrialOpen />);
    const enterprise = screen.getByRole("article", { name: "แพ็กเกจ Enterprise" });
    expect(within(enterprise).getByText("สอบถามราคา")).toBeTruthy();
    expect(within(enterprise).getByRole("link").getAttribute("href")).toBe("/enterprise");
    expect(screen.getByRole("link", { name: "เริ่มทดลอง Enterprise" }).getAttribute("href")).toBe("/register");
    expect(screen.getByText(/เริ่มต้น 1 สาขา · 1 สมาชิก · ยังไม่รวมฟีเจอร์เสริม/)).toBeTruthy();
    expect(screen.getByText("หากต้องการเพิ่มสาขา ต้องเลือกฟีเจอร์รายงานหลายสาขาด้วย")).toBeTruthy();
    cleanup();
    render(<PricingPlans plans={plans} freeTrialOpen={false} />);
    expect(screen.queryByRole("link", { name: "เริ่มทดลอง Enterprise" })).toBeNull();
  });
});
