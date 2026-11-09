import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { applySelfInfo, changedFields, lockedFields, parseSelfInfoForm } from "@/modules/hr/self-info";

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

  it("log เก็บชื่อช่องที่เปลี่ยนเท่านั้น", () => {
    expect(changedFields({ storeId: "s", userId: "u", phone: "0812345678" }, { phone: "0812345678", nickname: "บี", address: null })).toEqual([
      "nickname",
    ]);
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

  it("สลิป/ปิดงวดใช้ค่าที่พนักงานกรอกเมื่อร้านยังไม่ตั้ง", () => {
    expect(payroll).toContain('db.from("employee_self_info")');
    expect(payroll).toContain("applySelfInfo(p, selfByUser.get(p.userId))");
    expect(payslip).toContain("applySelfInfo(p, selfInfo.get(p.userId))");
  });

  it("เลขบัญชีเต็มไม่ไปถึง browser และ log ไม่เก็บค่าจริง", () => {
    expect(staffPage).toContain("bankAccountMasked: maskBankAccount(bankAccountNo)");
    expect(action).toContain("changedFields: fields");
    expect(action).not.toMatch(/context:\s*\{[^}]*parsed\.value/);
    expect(action).toContain('source: "hr.self-info"');
  });
});
