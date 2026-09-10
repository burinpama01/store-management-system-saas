import { describe, expect, it } from "vitest";
import {
  buildPlatformDailyDigest,
  daysSince,
  type PlatformDailyReport,
  type PlatformDailyTenant,
} from "@/modules/system/platform-daily-report";

const NOW = new Date("2026-09-09T02:00:00.000Z");

function tenant(overrides: Partial<PlatformDailyTenant> = {}): PlatformDailyTenant {
  return {
    organizationId: "org-1",
    name: "ร้านทดสอบ",
    plan: "premium",
    createdAt: "2026-09-08T03:00:00.000Z",
    ownerEmail: "owner@example.com",
    orderCount7d: 20,
    revenue7d: 5000,
    lastOrderAt: "2026-09-08T10:00:00.000Z",
    ...overrides,
  };
}

function report(overrides: Partial<PlatformDailyReport> = {}): PlatformDailyReport {
  return {
    today: "2026-09-09",
    yesterday: "2026-09-08",
    totalTenants: 15,
    suspendedTenants: 1,
    newTenants: [tenant({ organizationId: "org-new", name: "ร้านใหม่เอี่ยม" })],
    newTenants7d: 3,
    newMembers7d: 7,
    recentTenants: [tenant({ organizationId: "org-recent", name: "ร้านล่าสุด" })],
    activeTenants: [tenant({ organizationId: "org-active", name: "ร้านที่ยังขายอยู่" })],
    dormantTenants: [
      tenant({
        organizationId: "org-dormant",
        name: "ร้านที่หายไป",
        orderCount7d: 0,
        revenue7d: 0,
        lastOrderAt: null,
      }),
    ],
    yesterdayOrderCount: 42,
    yesterdayRevenue: 12345.5,
    yesterdaySellingTenants: 4,
    ...overrides,
  };
}

describe("buildPlatformDailyDigest", () => {
  it("ตอบสามคำถามหลักของผู้ดูแล: ผู้ใช้ใหม่ / ผู้ใช้ล่าสุด / ผู้ใช้ที่ยังแอคทีฟ", () => {
    const digest = buildPlatformDailyDigest(report(), null, NOW);

    expect(digest).toContain("ผู้ใช้ใหม่เมื่อวาน: 1 องค์กร");
    expect(digest).toContain("ร้านใหม่เอี่ยม");
    expect(digest).toContain("ผู้ใช้ล่าสุด:");
    expect(digest).toContain("ร้านล่าสุด");
    expect(digest).toContain("ผู้ใช้ที่ยังแอคทีฟ (มีบิลใน 7 วัน): 1 องค์กร");
    expect(digest).toContain("ร้านที่ยังขายอยู่");
  });

  it("บอกยอดขายทั้งแพลตฟอร์มของเมื่อวาน", () => {
    const digest = buildPlatformDailyDigest(report(), null, NOW);
    expect(digest).toContain("2026-09-08");
    expect(digest).toContain("฿12,345.5");
    expect(digest).toContain("42 บิล");
    expect(digest).toContain("ขายได้ 4 ร้าน");
  });

  it("เตือนร้านที่เงียบเกิน 14 วัน พร้อมบอกว่าไม่เคยปิดบิล", () => {
    const digest = buildPlatformDailyDigest(report(), null, NOW);
    expect(digest).toContain("เงียบเกิน 14 วัน");
    expect(digest).toContain("ร้านที่หายไป");
    expect(digest).toContain("ยังไม่เคยปิดบิล");
  });

  it("ไม่ขึ้นหัวข้อร้านเงียบเมื่อไม่มีร้านไหนหายไป", () => {
    const digest = buildPlatformDailyDigest(report({ dormantTenants: [] }), null, NOW);
    expect(digest).not.toContain("เงียบเกิน 14 วัน (ควรตาม");
  });

  // ของเดิมส่งอีเมลแยกใบ "สรุปแพ็กเกจร้านประจำวัน" — รวมมาเป็นส่วนหนึ่งของรายงานเดียว
  it("ต่อท้ายส่วนแพ็กเกจที่ต้องตามเมื่อ subscription watch ส่งมา", () => {
    const digest = buildPlatformDailyDigest(report(), "[2026-09-09] สรุปแพ็กเกจร้าน — หมดอายุแล้ว 1 ร้าน", NOW);
    expect(digest).toContain("— แพ็กเกจ —");
    expect(digest).toContain("หมดอายุแล้ว 1 ร้าน");
  });

  it("ไม่มีส่วนแพ็กเกจเมื่อวันนั้นไม่มีร้านต้องตาม", () => {
    expect(buildPlatformDailyDigest(report(), null, NOW)).not.toContain("— แพ็กเกจ —");
    expect(buildPlatformDailyDigest(report(), "   ", NOW)).not.toContain("— แพ็กเกจ —");
  });

  it("รายงานได้แม้ไม่มีใครสมัครใหม่และไม่มีใครขายเลย", () => {
    const digest = buildPlatformDailyDigest(
      report({
        newTenants: [],
        newTenants7d: 0,
        newMembers7d: 0,
        activeTenants: [],
        yesterdayOrderCount: 0,
        yesterdayRevenue: 0,
        yesterdaySellingTenants: 0,
      }),
      null,
      NOW,
    );
    expect(digest).toContain("ผู้ใช้ใหม่เมื่อวาน: 0 องค์กร");
    expect(digest).toContain("ผู้ใช้ที่ยังแอคทีฟ (มีบิลใน 7 วัน): 0 องค์กร");
  });
});

describe("daysSince", () => {
  it("นับจำนวนวันเต็มที่ผ่านมา", () => {
    expect(daysSince("2026-09-08T02:00:00.000Z", NOW)).toBe(1);
    expect(daysSince("2026-09-09T01:00:00.000Z", NOW)).toBe(0);
  });

  it("คืน null เมื่อไม่มีข้อมูล และไม่ติดลบเมื่อเวลาอยู่ในอนาคต", () => {
    expect(daysSince(null, NOW)).toBeNull();
    expect(daysSince("2026-09-20T00:00:00.000Z", NOW)).toBe(0);
  });
});
