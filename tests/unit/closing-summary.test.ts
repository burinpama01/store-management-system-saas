import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildClosingSummaryTrigger,
  CLOSING_SUMMARY_OT_WAIT_MAX_HOURS,
  closingSummaryDueAtMs,
  formatClosingTime,
  shouldWaitForOtStaff,
  parseClosingTimeInput,
} from "@/modules/reports/closing-summary";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const migration = "supabase/migrations/20261004120000_store_closing_summary.sql";

describe("เวลาปิดร้าน — แปลงค่าจากฟอร์ม", () => {
  it("รับ HH:MM และ HH:MM:SS", () => {
    expect(parseClosingTimeInput("22:00")).toBe("22:00");
    expect(parseClosingTimeInput("01:30:00")).toBe("01:30");
  });
  it("ว่าง = ไม่ใช้เวลาปิดร้าน", () => {
    expect(parseClosingTimeInput("")).toBeNull();
    expect(parseClosingTimeInput(null)).toBeNull();
  });
  it("รูปแบบผิดถูกปฏิเสธ", () => {
    for (const v of ["24:00", "9:00", "22:60", "abc"]) expect(parseClosingTimeInput(v)).toBe("invalid");
  });
  it("ตัดวินาทีจาก DB ก่อนแสดง", () => {
    expect(formatClosingTime("22:00:00")).toBe("22:00");
    expect(formatClosingTime(null)).toBe("");
  });
});

describe("ข้อความที่มาของสรุป", () => {
  it("บอกชื่อคนที่ยังไม่กดออกงาน (ไม่ซ้ำ)", () => {
    const text = buildClosingSummaryTrigger("22:00:00", ["gg@x.com", "gg@x.com", "mild"]);
    expect(text).toContain("เลยเวลาปิดร้าน (22:00 น.) มา 1 ชม.");
    expect(text).toContain("ยังไม่กดออกงาน: gg@x.com, mild");
  });
  it("ไม่มีคนค้างกะ (เช่น แอดมินแก้เวลาออกให้ทีหลัง) ก็ยังส่งได้", () => {
    expect(buildClosingSummaryTrigger("21:00", [])).toContain("ส่งสรุปให้อัตโนมัติ");
  });
  it("คนค้างเยอะ ย่อรายชื่อ", () => {
    const text = buildClosingSummaryTrigger("21:00", ["a", "b", "c", "d", "e", "f", "g"]);
    expect(text).toContain("และอีก 2 คน");
  });
});

describe("migration + เส้นทางเรียก", () => {
  const sql = read(migration);
  it("pg_cron ทุก 30 นาที และเรียก API เฉพาะเมื่อมีสาขาถึงเวลา", () => {
    expect(sql).toContain("'*/30 * * * *'");
    expect(sql).toContain("where exists (select 1 from public.closing_summary_due_stores())");
  });
  it("เลยเวลาปิด 1 ชม. รองรับปิดหลังเที่ยงคืน และไม่ไล่ส่งย้อนหลังเกิน 12 ชม.", () => {
    expect(sql).toContain("+ interval '1 hour'");
    expect(sql).toContain("when s.closing_time < time '05:00' then interval '1 day'");
    expect(sql).toContain("p_now < x.due_at + interval '12 hours'");
  });
  it("คืนชื่อสาขาให้สรุป และกันสาขาที่ไม่มี timezone", () => {
    expect(sql).toContain("select s.organization_id, s.id, s.name, d.day");
    expect(sql).toContain("and s.timezone is not null");
    expect(read("src/modules/reports/closing-summary-runner.ts")).toContain('storeName: store.store_name ?? ""');
  });
  it("ไม่ส่งซ้ำกับสรุปตอนออกงาน (ตารางกันซ้ำตัวเดียวกัน)", () => {
    expect(sql).toContain("from public.daily_summary_notification_log l");
    expect(sql).toContain("check (delivery_status in ('claimed', 'sent', 'failed', 'skipped'))");
  });
  it("ไม่แตะข้อมูลกะ", () => {
    expect(sql).not.toMatch(/update\s+public\.attendance_records/i);
    const runner = read("src/modules/reports/closing-summary-runner.ts");
    expect(runner).not.toMatch(/attendance_records[\s\S]{0,80}\.(update|upsert|delete)\(/);
  });
  it("API เป็น public route (pg_cron ไม่มี session) และตรวจกุญแจจาก Vault", () => {
    expect(read("src/server/integrations/supabase/middleware.ts")).toContain(
      '"/api/attendance/cron/closing-summary"',
    );
    const route = read("src/app/api/attendance/cron/closing-summary/route.ts");
    expect(route).toContain('rpc("verify_closing_summary_cron_key"');
    expect(route).toContain("status: 401");
  });
});

describe("วันให้ OT — รอคน OT ออกงานก่อนส่งสรุปจากเวลาปิดร้าน", () => {
  const H = 60 * 60 * 1000;
  const otDay = { capHours: 3, userIds: ["ot1", "ot2"] };
  // ปิด 20:00 เวลาไทย → ถึงกำหนด 21:00 (+07) = 14:00Z
  const dueAtMs = closingSummaryDueAtMs("2026-11-24", "20:00:00", "Asia/Bangkok");

  it("เวลาถึงกำหนดตรงกับ SQL (ปิด + 1 ชม. · ปิดก่อน 05:00 = วันถัดไป)", () => {
    expect(dueAtMs).toBe(Date.parse("2026-11-24T14:00:00Z"));
    expect(closingSummaryDueAtMs("2026-11-24", "01:30", "Asia/Bangkok")).toBe(Date.parse("2026-11-24T19:30:00Z"));
    expect(closingSummaryDueAtMs("2026-11-24", "", "Asia/Bangkok")).toBeNull();
  });

  it("คน OT ยังไม่ออกงาน และยังไม่เลยเพดาน → รอ", () => {
    expect(shouldWaitForOtStaff({ otDay, openUserIds: ["ot1"], dueAtMs, nowMs: dueAtMs! + 1 * H })).toBe(true);
  });

  it("เหลือแต่คนที่ไม่อยู่ในรายชื่อ OT (เช่นลืมกดออก) → ส่งเลย", () => {
    expect(shouldWaitForOtStaff({ otDay, openUserIds: ["x"], dueAtMs, nowMs: dueAtMs! + 1 * H })).toBe(false);
  });

  it("ไม่มีเวลาถึงกำหนด (เวลาปิดว่าง) → ไม่รอ", () => {
    expect(shouldWaitForOtStaff({ otDay, openUserIds: ["ot1"], dueAtMs: null, nowMs: 0 })).toBe(false);
  });

  it("เทียบ id ไม่สนตัวพิมพ์", () => {
    expect(shouldWaitForOtStaff({ otDay: { capHours: 3, userIds: ["AB-1"] }, openUserIds: ["ab-1"], dueAtMs, nowMs: dueAtMs! })).toBe(true);
  });

  it("ไม่ใช่วันให้ OT → ส่งตามเดิม", () => {
    expect(shouldWaitForOtStaff({ otDay: null, openUserIds: ["ot1"], dueAtMs, nowMs: dueAtMs! })).toBe(false);
  });

  it("เลยเวลาถึงกำหนด + เพดาน OT แล้ว → ส่งเลย (กันลืมกดออกจนไม่มีสรุป)", () => {
    expect(shouldWaitForOtStaff({ otDay, openUserIds: ["ot1"], dueAtMs, nowMs: dueAtMs! + 3 * H })).toBe(false);
  });

  it("เพดาน 12 ชม. รอได้ไม่เกิน 11 ชม. (อยู่ในหน้าต่าง 12 ชม. ของ SQL)", () => {
    const big = { capHours: 12, userIds: ["ot1"] };
    expect(CLOSING_SUMMARY_OT_WAIT_MAX_HOURS).toBeLessThan(12);
    expect(shouldWaitForOtStaff({ otDay: big, openUserIds: ["ot1"], dueAtMs, nowMs: dueAtMs! + 11 * H })).toBe(false);
  });

  it("runner: รอ = ไม่จอง (อ่านคนค้างกะ + เช็ก OT ก่อน insert claim) และอ่าน OT ไม่ได้ = ไม่รอ", () => {
    const runner = read("src/modules/reports/closing-summary-runner.ts");
    expect(runner.indexOf("shouldWaitForOtStaff({")).toBeLessThan(runner.indexOf('.from("daily_summary_notification_log").insert('));
    expect(runner).toContain('return "waitingOt";');
    expect(runner).toContain('if (hr?.ot_mode !== "scheduled") return null;');
    expect(runner).toContain('action: "loadOtDayForSummary"');
    expect(runner).toContain('action: "waitForOtStaff"');
  });
});
