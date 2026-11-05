import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// ISSUE-20261105-PAY-003: พนักงานต้องอ่านเงินเดือน/รายการปรับได้เฉพาะของตัวเอง
describe("RLS เงินเดือน: อ่านได้เฉพาะของตัวเองหรือผู้จัดการ", () => {
  const sql = readFileSync(
    join(process.cwd(), "supabase/migrations/20261106000000_hr_payroll_rls_own_or_manager.sql"),
    "utf8",
  );

  it.each(["employee_profiles", "payroll_adjustments"])("%s: ลบ policy ที่ให้ทุกคนในสาขาอ่าน", (table) => {
    expect(sql).toContain(`drop policy if exists "${table}: store member can read" on ${table};`);
  });

  it.each(["employee_profiles", "payroll_adjustments"])("%s: อ่านได้เฉพาะแถวตัวเอง หรือมีสิทธิ์ attendance.manage", (table) => {
    const block = sql.slice(sql.indexOf(`create policy "${table}: own row`));
    expect(block).toContain(`on ${table} for select`);
    expect(block).toContain("user_id = auth.uid()");
    expect(block).toContain("auth_user_has_permission(organization_id, store_id, 'attendance.manage')");
  });

  it("ไม่มี policy อ่านแบบเปิดให้ทุกคนในสาขาหลงเหลือ", () => {
    expect(sql).not.toMatch(/for select\s+using \(store_id in \(select auth_user_store_ids\(\)\)\)/);
  });
});
