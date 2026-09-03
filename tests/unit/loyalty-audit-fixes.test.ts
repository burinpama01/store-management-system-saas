// แก้บัคจาก audit ระบบแต้ม/สมาชิก 2026-07-19 (ข้อ 1, 4, 5, 9)
// audit ระบุว่าเทสเดิมเป็น source-assertion จึงจับพฤติกรรมพวกนี้ไม่ได้ — ชุดนี้ทดสอบพฤติกรรมจริง
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_POINTS_ADJUSTMENT, parsePointsDeltaInput } from "@/modules/loyalty/points-input";
import { escapeLikePattern } from "@/shared/utils/like-pattern";
import {
  normalizeCustomerPhone,
  normalizeCustomerPhoneOrNull,
} from "@/shared/utils/customer-phone";

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

describe("ข้อ 2 — เบอร์ลูกค้าใช้กฎเดียวกันทั้งระบบ", () => {
  it("normalize ตัดช่องว่าง วงเล็บ ขีด (คงตัวเลขเดิม)", () => {
    expect(normalizeCustomerPhone("081-234-5678")).toBe("0812345678");
    expect(normalizeCustomerPhone(" (081) 234 5678 ")).toBe("0812345678");
    expect(normalizeCustomerPhone("0812345678")).toBe("0812345678");
    expect(normalizeCustomerPhone("+66 81 234 5678")).toBe("+66812345678");
  });

  it("ไม่มีเบอร์ = null (คอลัมน์ nullable)", () => {
    expect(normalizeCustomerPhoneOrNull("")).toBeNull();
    expect(normalizeCustomerPhoneOrNull("   ")).toBeNull();
    expect(normalizeCustomerPhoneOrNull(null)).toBeNull();
    expect(normalizeCustomerPhoneOrNull("081-234-5678")).toBe("0812345678");
  });

  it("แดชบอร์ดและ member portal ใช้ helper ตัวเดียวกัน (ห้ามแยกกฎ)", () => {
    const dashboard = read("src/modules/customers/repository.ts");
    const member = read("src/modules/customers/member-repository.ts");
    expect(dashboard).toContain("normalizeCustomerPhoneOrNull(input.phone)");
    expect(dashboard).not.toContain("phone: input.phone?.trim() || null");
    expect(member).toContain("normalizeCustomerPhone");
    expect(member).not.toMatch(/function normalizePhone\(/);
  });
});

describe("ข้อ 3 — เบอร์ซ้ำต่อร้านต้องเป็นไปไม่ได้", () => {
  const migration = read("supabase/migrations/20260903000001_customers_phone_unique.sql");

  it("migration normalize ก่อน แล้วจึงสร้าง unique index เฉพาะแถวที่มีเบอร์", () => {
    expect(migration).toContain("update public.customers");
    expect(migration).toContain("create unique index if not exists customers_store_phone_unique");
    expect(migration).toContain("where phone is not null and phone <> ''");
    // ต้อง normalize ก่อนสร้าง index เสมอ
    expect(migration.indexOf("update public.customers")).toBeLessThan(
      migration.indexOf("create unique index"),
    );
  });

  it("ถ้ามีเบอร์ซ้ำ migration ต้องหยุดพร้อมบอกที่ซ้ำ ไม่รวม/ลบข้อมูลเอง", () => {
    expect(migration).toContain("raise exception");
    expect(migration).toContain("พบเบอร์ลูกค้าซ้ำ");
    expect(migration).not.toMatch(/delete\s+from\s+public\.customers/i);
  });

  it("สมัครชนกันพร้อมกัน → หยิบแถวที่มีอยู่ ไม่โยน error ให้ลูกค้า", () => {
    const member = read("src/modules/customers/member-repository.ts");
    const start = member.indexOf("export async function createOrFindMemberCustomer");
    const nextExport = member.indexOf("\nexport ", start + 10);
    const body = member.slice(start, nextExport > 0 ? nextExport : member.length);
    expect(body).toContain('created.error.code === "23505"');
    expect(body).toContain("raced.data.id");
  });

  it("พนักงานกรอกเบอร์ซ้ำ → ข้อความบอกชัดว่าซ้ำ", () => {
    const dashboard = read("src/modules/customers/repository.ts");
    expect(dashboard).toContain("เบอร์นี้มีลูกค้าอยู่แล้วในร้าน");
  });
});
