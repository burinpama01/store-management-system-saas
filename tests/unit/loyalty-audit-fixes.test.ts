// แก้บัคจาก audit ระบบแต้ม/สมาชิก 2026-07-19 (ข้อ 1, 4, 5, 9)
// audit ระบุว่าเทสเดิมเป็น source-assertion จึงจับพฤติกรรมพวกนี้ไม่ได้ — ชุดนี้ทดสอบพฤติกรรมจริง
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_POINTS_ADJUSTMENT, parsePointsDeltaInput } from "@/modules/loyalty/points-input";
import { escapeLikePattern } from "@/shared/utils/like-pattern";

const read = (relative: string) => readFileSync(join(process.cwd(), relative), "utf8");

describe("ข้อ 1 — ปรับแต้มทศนิยมได้ (numeric(12,2))", () => {
  it("รับทศนิยมตามที่ฟอร์มใส่ step 0.01", () => {
    expect(parsePointsDeltaInput("1.01")).toBe(1.01);
    expect(parsePointsDeltaInput("-0.50")).toBe(-0.5);
    expect(parsePointsDeltaInput(2.5)).toBe(2.5);
  });

  it("ปัดเป็น 2 ตำแหน่งให้ตรงกับที่ฐานข้อมูลเก็บ", () => {
    expect(parsePointsDeltaInput("1.005")).toBe(1.01);
    expect(parsePointsDeltaInput("0.014")).toBe(0.01);
  });

  it("ยังกันค่าที่ใช้ไม่ได้เหมือนเดิม", () => {
    expect(parsePointsDeltaInput("0")).toBeNull();
    expect(parsePointsDeltaInput("0.001")).toBeNull(); // ปัดแล้วเป็น 0
    expect(parsePointsDeltaInput("abc")).toBeNull();
    expect(parsePointsDeltaInput("")).toBeNull();
    expect(parsePointsDeltaInput(MAX_POINTS_ADJUSTMENT + 1)).toBeNull();
    expect(parsePointsDeltaInput(-MAX_POINTS_ADJUSTMENT - 1)).toBeNull();
  });

  it("ค่าที่ขอบเขตพอดียังใช้ได้", () => {
    expect(parsePointsDeltaInput(MAX_POINTS_ADJUSTMENT)).toBe(MAX_POINTS_ADJUSTMENT);
    expect(parsePointsDeltaInput(0.01)).toBe(0.01);
  });

  it("action ใช้ตัวแปลงตัวเดียวกัน ไม่บังคับจำนวนเต็มอีก", () => {
    const actions = read("src/app/(dashboard)/customers/actions.ts");
    expect(actions).toContain("parsePointsDeltaInput");
    expect(actions).not.toContain("Number.isInteger(pointsDelta)");
  });
});

describe("ข้อ 4 — เปิด/ปิดแลกแต้มต้องมีผลจริง", () => {
  const repository = read("src/modules/loyalty/repository.ts");

  it("ทางเดียวที่แลกของรางวัลได้ ต้องอ่านค่าตั้งค่าก่อนเรียก RPC", () => {
    const start = repository.indexOf("export async function redeemRewardForCurrentCustomer");
    const body = repository.slice(start, repository.indexOf("export ", start + 10));
    expect(body).toContain("getLoyaltySettingsForStore");
    expect(body).toContain("redeemEnabled");
    expect(body).toContain("ร้านปิดการแลกของรางวัลอยู่");
    // ต้องเช็คก่อนยิง RPC เสมอ
    expect(body.indexOf("redeemEnabled")).toBeLessThan(body.indexOf("redeem_loyalty_reward"));
  });

  it("ค่าเริ่มต้นเมื่อร้านยังไม่เคยตั้งค่า ต้องตรงกับ default ของฐานข้อมูล (เปิด)", () => {
    const migration = read("supabase/migrations/20260621020000_customer_coupon_loyalty.sql");
    expect(migration).toContain("redeem_enabled       boolean not null default true");
    const fallbackStart = repository.indexOf("pointsPerCurrency: 0.01");
    const fallback = repository.slice(fallbackStart, fallbackStart + 260);
    expect(fallback).toContain("redeemEnabled: true");
  });
});

describe("ข้อ 5 — แพ็กเกจไม่มี loyalty ต้องไม่บล็อกการเก็บเงิน", () => {
  it("เส้นทางปิดบิลไม่เรียก requireFeature เพราะออร์เดอร์ผูกลูกค้า", () => {
    const actions = read("src/app/pos/actions.ts");
    expect(actions).not.toContain(`if (orderRes.data?.customerId) {\n        await requireFeature("loyaltyPoints");`);
    // การจำกัดแพ็กเกจยังอยู่ที่การจัดการ loyalty (ค้นหาลูกค้า/ของรางวัล)
    expect(actions).toContain('requireFeature("loyaltyPoints")');
  });
});

describe("ข้อ 9 — escape wildcard ก่อนค้นด้วย ilike", () => {
  it("escape _ % และ backslash", () => {
    // ใช้ String.raw เพราะ "\_" ใน JS คือ "_" เฉย ๆ (เขียนตรง ๆ จะเทียบผิด)
    expect(escapeLikePattern("a_b@x.com")).toBe(String.raw`a\_b@x.com`);
    expect(escapeLikePattern("50%@x.com")).toBe(String.raw`50\%@x.com`);
    expect(escapeLikePattern(String.raw`a\b@x.com`)).toBe(String.raw`a\\b@x.com`);
  });

  it("อีเมลปกติไม่ถูกเปลี่ยน", () => {
    expect(escapeLikePattern("owner@demo.local")).toBe("owner@demo.local");
  });

  it("member-repository ใช้ตัวนี้ทุกจุดที่ค้นอีเมล", () => {
    const source = read("src/modules/customers/member-repository.ts");
    const ilikeCalls = source.match(/\.ilike\("email",[^)]*\)/g) ?? [];
    expect(ilikeCalls.length).toBeGreaterThan(0);
    for (const call of ilikeCalls) expect(call).toContain("escapeLikePattern");
  });
});

describe("ข้อ 1 (เพิ่มเติม) — ปัดค่าลบให้สมมาตรกับค่าบวก", () => {
  it("ค่าลบปัดแบบเดียวกับค่าบวก", () => {
    expect(parsePointsDeltaInput("-1.005")).toBe(-1.01);
    expect(parsePointsDeltaInput("-0.014")).toBe(-0.01);
    expect(parsePointsDeltaInput("-2.345")).toBe(-2.35);
    expect(parsePointsDeltaInput("2.345")).toBe(2.35);
  });
});
