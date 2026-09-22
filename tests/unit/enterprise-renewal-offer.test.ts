import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  computeOfferExpiry,
  describeOffer,
  parseEnterpriseOfferInput,
} from "@/modules/billing/enterprise-offer";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const migration = "supabase/migrations/20260922120000_enterprise_renewal_offer.sql";

describe("ข้อเสนอต่ออายุ Enterprise — ตรรกะราคาและอายุ", () => {
  it("แบบจำนวนวันสะสมจากวันหมดอายุเดิมที่ยังไม่หมด", () => {
    const expiry = computeOfferExpiry(
      { kind: "days", days: 30 },
      "2026-10-31T00:00:00.000Z",
      new Date("2026-10-01T00:00:00.000Z"),
    );
    expect(expiry).toBe("2026-11-30T00:00:00.000Z");
  });

  it("แบบจำนวนวันเริ่มนับจากวันนี้เมื่อแพ็กเกจหมดอายุไปแล้ว", () => {
    const expiry = computeOfferExpiry(
      { kind: "days", days: 365 },
      "2026-09-01T00:00:00.000Z",
      new Date("2026-10-01T00:00:00.000Z"),
    );
    expect(expiry).toBe("2027-10-01T00:00:00.000Z");
  });

  it("แบบถึงวันที่กำหนดได้วันตายตัว ไม่สนเวลาที่เหลือเดิม", () => {
    const endsAt = "2027-03-31T16:59:59.000Z";
    expect(
      computeOfferExpiry({ kind: "until", endsAt }, "2026-12-31T00:00:00.000Z", new Date("2026-10-01T00:00:00.000Z")),
    ).toBe(endsAt);
  });

  it("ปฏิเสธราคาที่ไม่ใช่ตัวเลขบวก", () => {
    for (const amount of [0, -1, "", "abc", null]) {
      const r = parseEnterpriseOfferInput({ amount, termKind: "days", termDays: 30 });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("amount_invalid");
    }
  });

  it("ปฏิเสธจำนวนวันนอกช่วง 1–3650 และเลขไม่เต็มหน่วย", () => {
    for (const days of [0, 3651, 1.5]) {
      const r = parseEnterpriseOfferInput({ amount: 5000, termKind: "days", termDays: days });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("days_invalid");
    }
  });

  it("ปฏิเสธวันหมดอายุที่เป็นอดีต", () => {
    const r = parseEnterpriseOfferInput(
      { amount: 5000, termKind: "until", endsAt: "2026-01-01T00:00:00.000Z" },
      new Date("2026-10-01T00:00:00.000Z"),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("ends_at_past");
  });

  it("รับค่าที่ถูกต้องและปัดราคาเป็นทศนิยม 2 ตำแหน่ง", () => {
    const r = parseEnterpriseOfferInput({ amount: "12000.456", termKind: "days", termDays: 365, note: "  ดีลปี 70  " });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.amount).toBe(12000.46);
      expect(r.term).toEqual({ kind: "days", days: 365 });
      expect(r.note).toBe("ดีลปี 70");
    }
  });

  it("สรุปข้อเสนอเป็นข้อความไทยที่มีทั้งยอดและวันหมดอายุ", () => {
    const text = describeOffer(
      { amount: 12000, term: { kind: "days", days: 365 } },
      null,
      new Date("2026-10-01T00:00:00.000Z"),
    );
    expect(text).toContain("12,000");
    expect(text).toContain("365 วัน");
    expect(text).toContain("2570");
  });
});

describe("ด่านความปลอดภัยของเส้นทางชำระเงิน", () => {
  it("PromptPay: ยอดมาจากข้อเสนอ และตั้ง enterprise_limited เสมอ", () => {
    const source = read("src/modules/billing/subscription-service.ts");
    expect(source).toContain("getPayableEnterpriseOffer(input.organizationId)");
    expect(source).toContain("enterprise_limited: isEnterprise");
    expect(source).toContain("computeOfferExpiry(offer.term");
    // ข้อเสนอแบบถึงวันที่ต้องปิดตัวเองหลังใช้
    expect(source).toContain('offer?.term.kind === "until"');
  });

  it("Beam: สร้างรายการด้วยยอดจากข้อเสนอ และติดอายุไปกับรายการ", () => {
    const source = read("src/modules/billing/beam-billing.ts");
    expect(source).toContain("getPayableEnterpriseOffer(input.organizationId)");
    expect(source).toContain('duration: offer ? "custom" : input.duration');
    expect(source).toContain("term_ends_at: offer?.term.kind");
  });

  it("action ของร้านตรวจข้อเสนอกับ DB ไม่เชื่อค่าจาก client", () => {
    const source = read("src/app/(dashboard)/settings/billing/actions.ts");
    expect(source).toContain("await getPayableEnterpriseOffer(ctx.organizationId)");
    expect(source).toContain("ไม่มีข้อเสนอต่ออายุ Enterprise ที่เปิดอยู่สำหรับบัญชีนี้");
  });

  it("ตั้งข้อเสนอได้เฉพาะผู้ดูแลแพลตฟอร์ม และบันทึก audit log", () => {
    const source = read("src/app/system/tenants/[id]/actions.ts");
    expect(source).toContain("saveEnterpriseOfferAction");
    expect(source).toContain("await requireSystemAccess()");
    expect(source).toContain('action: "subscription.enterprise_offer.set"');
  });
});

describe("migration", () => {
  it("ปลดล็อก enterprise/custom ให้ทั้งสลิปและรายการ Beam", () => {
    const sql = read(migration);
    expect(sql).toContain("check (plan in ('starter', 'standard', 'premium', 'business', 'enterprise'))");
    expect(sql).toContain("check (duration in ('30d', '1y', 'custom'))");
    expect(sql).toContain("add column if not exists term_days integer");
  });

  it("RPC ตัดสิทธิ์เคารพอายุที่ตกลงไว้ และกันสัญญาไม่มีวันหมดอายุ", () => {
    const sql = read(migration);
    expect(sql).toContain("when o.term_ends_at is not null then o.term_ends_at");
    expect(sql).toContain("make_interval(days => o.term_days)");
    // ธงนี้คือสิ่งเดียวที่กันไม่ให้จ่ายครั้งเดียวแล้วใช้ Enterprise ฟรีตลอดชีพ
    expect(sql).toContain("o.plan='enterprise'");
    expect(sql).toContain("enterprise_limited=excluded.enterprise_limited");
  });

  it("ข้อเสนอแบบถึงวันที่ปิดตัวเองหลังชำระสำเร็จ", () => {
    const sql = read(migration);
    expect(sql).toContain("update public.organization_enterprise_offers");
    expect(sql).toContain("term_kind = 'until'");
  });
});
