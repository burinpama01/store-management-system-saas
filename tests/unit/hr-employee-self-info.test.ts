import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { applySelfInfo, describeSelfInfoChanges, lockedFields, parseSelfInfoForm, splitSelfInfoPatch } from "@/modules/hr/self-info";

const form = (values: Record<string, string>) => (key: string) => values[key] ?? null;
const today = "2026-11-09";

describe("ช่องที่เจ้าของตั้งแล้วถูกล็อก", () => {
  it("ล็อกเฉพาะช่องที่มีค่า (ช่องว่าง/ช่องว่างล้วนไม่ล็อก)", () => {
    expect([...lockedFields({ fullName: "สมชาย ใจดี", bankName: "  ", bankAccountNo: "1234567890", bankAccountName: undefined })]).toEqual([
      "fullName",
      "bankAccountNo",
    ]);
    expect(lockedFields(null).size).toBe(0);
  });

  it("ฟอร์มไม่อ่านช่องที่ล็อก แม้ถูกส่งมา (กันแก้ผ่าน devtools)", () => {
    const r = parseSelfInfoForm(form({ fullName: "ชื่อปลอม", bankAccountNo: "9999999999", bankName: "กสิกร" }), {
      locked: new Set(["fullName", "bankAccountNo"]),
      today,
    });
    expect(r.error).toBeNull();
    expect(r.value).not.toHaveProperty("fullName");
    expect(r.value).not.toHaveProperty("bankAccountNo");
    expect(r.value?.bankName).toBe("กสิกร");
  });
});

describe("ตรวจฟอร์มพนักงาน", () => {
  const open = { locked: new Set<never>(), today };

  it("เลขบัญชี: ตัด - และช่องว่าง · ว่าง = ไม่เปลี่ยน · ติ๊กลบ = ล้าง", () => {
    expect(parseSelfInfoForm(form({ bankAccountNo: "123-4-56789-0" }), open).value?.bankAccountNo).toBe("1234567890");
    expect(parseSelfInfoForm(form({}), open).value).not.toHaveProperty("bankAccountNo");
    expect(parseSelfInfoForm(form({ clearBankAccount: "on" }), open).value?.bankAccountNo).toBeNull();
    expect(parseSelfInfoForm(form({ bankAccountNo: "12ab" }), open).error).toContain("6–20");
  });

  it("เบอร์โทรต้องเป็นตัวเลข 9–15 หลัก และวันเกิดห้ามเกินวันนี้", () => {
    expect(parseSelfInfoForm(form({ phone: "081-234-5678" }), open).value?.phone).toBe("0812345678");
    expect(parseSelfInfoForm(form({ phone: "123" }), open).error).toContain("เบอร์โทร");
    expect(parseSelfInfoForm(form({ emergencyContactPhone: "abc" }), open).error).toContain("ผู้ติดต่อฉุกเฉิน");
    expect(parseSelfInfoForm(form({ birthDate: "2027-01-01" }), open).error).toContain("ไม่เกินวันนี้");
    expect(parseSelfInfoForm(form({ birthDate: "2026-02-30" }), open).error).toContain("ไม่ถูกต้อง");
    expect(parseSelfInfoForm(form({ birthDate: "1995-05-20" }), open).value?.birthDate).toBe("1995-05-20");
  });

  it("ตัดตัวอักษรล่องหน/อักขระควบคุมออกจากชื่อ", () => {
    expect(parseSelfInfoForm(form({ fullName: "​สม‍ชาย﻿ ใจดี" }), open).value?.fullName).toBe("สมชาย ใจดี");
  });

  it("ทุกช่องตัวตนถูกล็อก → patch ไม่มีช่องเหล่านั้นเลย", () => {
    const r = parseSelfInfoForm(form({ fullName: "x", bankName: "x", bankAccountNo: "1234567", bankAccountName: "x", clearBankAccount: "on" }), {
      locked: new Set(["fullName", "bankName", "bankAccountNo", "bankAccountName"]),
      today,
    });
    expect(Object.keys(r.value ?? {}).sort()).toEqual(["address", "birthDate", "emergencyContactName", "emergencyContactPhone", "nickname", "phone"]);
  });

  it("ช่องว่าง = ล้างค่า และตัดช่องว่างซ้ำ", () => {
    const r = parseSelfInfoForm(form({ nickname: "  บี  ", address: "" }), open);
    expect(r.value?.nickname).toBe("บี");
    expect(r.value?.address).toBeNull();
  });
});

describe("ค่าที่ใช้จริงบนสลิป", () => {
  it("เจ้าของก่อน · ช่องที่เจ้าของว่างใช้ค่าพนักงาน", () => {
    const owner = { fullName: "สมชาย ใจดี", bankName: undefined, bankAccountNo: undefined, bankAccountName: "" };
    const merged = applySelfInfo(owner, {
      storeId: "s",
      userId: "u",
      fullName: "ชื่อที่พนักงานกรอก",
      bankName: "กสิกรไทย",
      bankAccountNo: "1234567890",
      bankAccountName: "สมชาย ใจดี",
    });
    expect(merged).toEqual({ fullName: "สมชาย ใจดี", bankName: "กสิกรไทย", bankAccountNo: "1234567890", bankAccountName: "สมชาย ใจดี" });
    expect(applySelfInfo(owner, null)).toBe(owner);
  });

});

describe("กรอกครั้งแรกบันทึกทันที · แก้ครั้งถัดไปต้องอนุมัติ", () => {
  const before = { storeId: "s", userId: "u", phone: "0812345678", address: "บ้านเดิม", bankAccountNo: "1234567890" };

  it("ช่องว่าง → บันทึกทันที · ช่องมีค่าแล้วและเปลี่ยน → ส่งคำขอ · ค่าเดิม → ไม่ทำอะไร", () => {
    const { direct, needsApproval } = splitSelfInfoPatch(before, { phone: "0812345678", nickname: "บี", address: "บ้านใหม่" });
    expect(direct).toEqual({ nickname: "บี" });
    expect(needsApproval).toEqual({ address: "บ้านใหม่" });
  });

  it("ลบค่าที่มีอยู่ต้องอนุมัติ · ว่างแล้วยังว่างไม่นับ", () => {
    const { direct, needsApproval } = splitSelfInfoPatch(before, { address: null, nickname: null });
    expect(direct).toEqual({});
    expect(needsApproval).toEqual({ address: null });
  });

  it("ยังไม่เคยกรอกเลย → ทุกช่องบันทึกทันที", () => {
    const { direct, needsApproval } = splitSelfInfoPatch(null, { phone: "0812345678", address: null });
    expect(direct).toEqual({ phone: "0812345678" });
    expect(needsApproval).toEqual({});
  });

  it("เลขบัญชีไม่กรอก (undefined) = ไม่แตะ · เปลี่ยนเลข = ต้องอนุมัติ", () => {
    expect(splitSelfInfoPatch(before, {}).needsApproval).toEqual({});
    expect(splitSelfInfoPatch(before, { bankAccountNo: "9999999999" }).needsApproval).toEqual({ bankAccountNo: "9999999999" });
  });

  it("รายการแสดงผล: เลขบัญชีปิดหลัก · null = ขอลบ · คอลัมน์แปลกถูกตัด", () => {
    expect(describeSelfInfoChanges({ bank_account_no: "1234567890", phone: null, monthly_salary: "9" })).toEqual([
      { field: "bankAccountNo", label: "เลขบัญชี", value: "••7890" },
      { field: "phone", label: "เบอร์โทร", value: null },
    ]);
    expect(describeSelfInfoChanges(null)).toEqual([]);
    expect(describeSelfInfoChanges([1])).toEqual([]);
  });
});

describe("migration + wiring", () => {
  const sql = readFileSync("supabase/migrations/20261109120000_employee_self_info.sql", "utf8");
  const payroll = readFileSync("src/modules/hr/advanced/store-payroll.ts", "utf8");
  const payslip = readFileSync("src/app/payslip/page.tsx", "utf8");
  const staffPage = readFileSync("src/app/(dashboard)/staff/page.tsx", "utf8");
  const action = readFileSync("src/app/(dashboard)/my-profile/actions.ts", "utf8");

  it("RLS: อ่านได้แถวตัวเองหรือ attendance.manage · เขียนได้แค่แถวตัวเอง · ไม่มี delete", () => {
    expect(sql).toContain("alter table public.employee_self_info enable row level security;");
    expect(sql).toContain("auth_user_has_permission(organization_id, store_id, 'attendance.manage')");
    expect((sql.match(/user_id = auth\.uid\(\)/g) ?? []).length).toBeGreaterThanOrEqual(4);
    expect(sql).not.toMatch(/for delete/);
    expect(sql).not.toMatch(/alter table (public\.)?employee_profiles/);
  });

  it("trigger ล้างช่องที่เจ้าของตั้งแล้ว และห้ามย้ายแถวไปคนอื่น", () => {
    for (const col of ["full_name", "bank_name", "bank_account_no", "bank_account_name"]) {
      expect(sql).toContain(`if coalesce(btrim(v_profile.${col}), '') <> '' then new.${col} := null; end if;`);
    }
    expect(sql).toContain("new.user_id := old.user_id;");
    expect(sql).toContain("revoke all on function public.employee_self_info_enforce_owner_locks() from public, anon, authenticated;");
  });

  it("trigger ปฏิเสธการแก้ช่องที่มีค่าแล้ว โดยแยกผู้เรียกด้วย current_user (ต้องเป็น invoker)", () => {
    const fn = sql.slice(sql.indexOf("create or replace function public.employee_self_info_enforce_owner_locks"), sql.indexOf("revoke all on function public.employee_self_info_enforce_owner_locks"));
    expect(fn).toContain("security invoker");
    expect(fn).not.toContain("security definer");
    expect(fn).toContain("if current_user in ('authenticated', 'anon') then");
    // ตรวจก่อนล้างช่องที่เจ้าของตั้ง ไม่งั้นการล้างของ trigger เองจะถูกนับเป็นการแก้
    expect(fn.indexOf("current_user in")).toBeLessThan(fn.indexOf("select * into v_profile"));
  });

  it("คำขอเขียนผ่าน RPC เท่านั้น และตรวจสิทธิ์ก่อนอนุมัติ", () => {
    const requests = sql.slice(sql.indexOf("create table if not exists public.employee_self_info_requests"));
    expect(requests).not.toMatch(/on public\.employee_self_info_requests for (insert|update|delete|all)/);
    expect(requests).toContain("not (v_key = any (employee_self_info_allowed_columns()))");
    // ตรวจค่าตอนส่ง ไม่ปล่อยให้คำขอค้างจนอนุมัติไม่ได้
    expect(requests).toContain("perform v_val::date;");
    expect(requests).toContain("ช่องนี้เจ้าของร้านตั้งไว้แล้ว");
    expect(sql).toContain("constraint employee_self_info_phone_check");
    expect(requests).toContain("if not auth_user_has_permission(r.organization_id, r.store_id, 'attendance.manage') then");
    expect(requests).toContain("revoke all on function public.review_employee_self_info_request(uuid, boolean, text) from public, anon;");
  });

  it("สลิป/ปิดงวดใช้ค่าที่พนักงานกรอกเมื่อร้านยังไม่ตั้ง", () => {
    expect(payroll).toContain('db.from("employee_self_info")');
    expect(payroll).toContain("applySelfInfo(p, selfByUser.get(p.userId))");
    expect(payslip).toContain("applySelfInfo(p, selfInfo.get(p.userId))");
  });

  it("เลขบัญชีเต็มไม่ไปถึง browser และ log ไม่เก็บค่าจริง", () => {
    expect(staffPage).toContain("bankAccountMasked: maskBankAccount(bankAccountNo)");
    expect(action).toContain("savedFields: directFields, requestedFields: requestFields");
    expect(action).not.toMatch(/context:\s*\{[^}]*parsed\.value/);
    expect(action).toContain('source: "hr.self-info"');
  });
});
