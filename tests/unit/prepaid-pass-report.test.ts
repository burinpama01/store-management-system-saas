import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { mapPassReport } from "@/modules/prepaid-passes/report";

const read = (path: string) => readFileSync(path, "utf8");
const MIGRATION = "supabase/migrations/20261117120000_prepaid_pass_reports.sql";

describe("รายงานแพ็ก — แปลงผล RPC", () => {
  it("แปลงตัวเลข (numeric จาก Postgres มาเป็น string) และค่าว่างเป็น 0", () => {
    const report = mapPassReport({
      from: "2026-11-01",
      to: "2026-11-30",
      sold: { count_all: 3, value_all: "1050.00", count_pos: 2, value_pos: "700", count_online: 1, value_online: "350", credits_used: 7, value_recognized: "245.00" },
      outstanding: { passes: 2, credits: 23, value: "805.00", expiring_7d: 1 },
      by_plan: [{ plan_id: "plan-1", plan_name: "แพ็กอเมริกาโน่ 10 แก้ว", sold: 3, sold_value: "1050", credits_used: 7, value_recognized: "245" }],
    });
    expect(report.sold.valueAll).toBe(1050);
    expect(report.sold.valueRecognized).toBe(245);
    expect(report.sold.creditsExpired).toBe(0);
    expect(report.outstanding.value).toBe(805);
    expect(report.byPlan[0]).toEqual({ planId: "plan-1", planName: "แพ็กอเมริกาโน่ 10 แก้ว", sold: 3, soldValue: 1050, creditsUsed: 7, valueRecognized: 245 });
  });

  it("ผลว่าง/พังไม่ทำให้หน้าแตก", () => {
    const report = mapPassReport(null);
    expect(report.byPlan).toEqual([]);
    expect(report.outstanding.passes).toBe(0);
  });
});

describe("migration รายงานแพ็ก + บัญชีขายออนไลน์", () => {
  const sql = read(MIGRATION);

  it("ดูรายงานต้องมีสิทธิ์ reports.view และจำกัดช่วงวันที่", () => {
    expect(sql).toContain("auth_user_has_permission(v_org, p_store_id, 'reports.view')");
    expect(sql).toContain("p_to - p_from > 400");
    expect(sql).toContain("at time zone 'Asia/Bangkok'");
  });

  it("รายได้ที่รับรู้ = ใช้ − คืน (redeem/release/reverse) และยอดคงค้างคิดจากแพ็กที่ยังใช้ได้", () => {
    expect(sql).toContain("filter (where type in ('redeem', 'release', 'reverse'))");
    expect(sql).toContain("sum(round(credits_remaining * unit_value, 2))");
    expect(sql).toContain("and (expires_at is null or expires_at > now())");
  });

  it("ขายออนไลน์ลง transactions หมวด ขายแพ็กออนไลน์ ครั้งเดียวต่อแพ็ก", () => {
    expect(sql).toContain("name = 'ขายแพ็กออนไลน์'");
    expect(sql).toContain("insert into public.transactions (");
    // ลงบัญชีเฉพาะตอนออกแพ็กใหม่จริง (v_pass_id ไม่ว่าง) — webhook ซ้ำไม่ลงซ้ำ
    const issueBlock = sql.slice(sql.indexOf("if v_pass_id is not null then"), sql.indexOf("else\n    select id into v_pass_id"));
    expect(issueBlock).toContain("insert into public.transactions (");
    expect(sql).toContain("m.role = 'owner'");
    // ไม่มีผู้บันทึก → ต้องมี log ให้ตามแก้ ไม่หายเงียบ (review P3 Major)
    expect(sql).toContain("md5('prepaid-pass.online|issueOnlinePass|no_recorder')");
    expect(sql).toContain("group by plan_id, plan_name");
  });

  it("logic ออกแพ็กเดิมยังอยู่ครบ (ไม่ถอยหลัง P1b)", () => {
    expect(sql).toContain("on conflict (purchase_id) do nothing");
    expect(sql).toContain("if new.status = 'LATE_PAID' then");
    expect(sql).toContain("new.status := 'REVIEW_REQUIRED';");
  });

  it("หน้ารายงานต้องมีสิทธิ์ reports.view", () => {
    const page = read("src/app/(dashboard)/reports/prepaid-passes/page.tsx");
    expect(page).toContain('if (!resolved.can("reports.view")) redirect("/dashboard");');
  });
});
