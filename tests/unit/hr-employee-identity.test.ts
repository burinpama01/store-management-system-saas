import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  defaultEmploymentType,
  maskBankAccount,
  parseEmployeeIdentity,
  resolvePayslipIssuer,
  seniorityLabel,
} from "@/modules/hr/employee-identity";

const TODAY = "2026-11-06";
const parse = (fields: Record<string, string>) => parseEmployeeIdentity((k) => fields[k], { today: TODAY });

describe("ข้อมูลพนักงานสำหรับสลิป (แผน v4 · P1)", () => {
  it("รับค่าครบ ตัดช่องว่างเกิน และเก็บเลขบัญชีเป็นตัวเลขล้วน (R20 เก็บเต็ม)", () => {
    const r = parse({
      employeeCode: "EMP-001",
      fullName: "  สมชาย   ใจดี ",
      position: "พนักงานเสิร์ฟ",
      employmentType: "permanent",
      permanentSince: "2026-01-10",
      seniorityStartDate: "2025-12-01",
      bankName: "กสิกรไทย",
      bankAccountNo: "123-4-56789-0",
      bankAccountName: "สมชาย ใจดี",
    });
    expect(r.error).toBeNull();
    expect(r.value).toMatchObject({
      employeeCode: "EMP-001",
      fullName: "สมชาย ใจดี",
      employmentType: "permanent",
      permanentSince: "2026-01-10",
      seniorityStartDate: "2025-12-01",
      bankAccountNo: "1234567890",
    });
  });

  it("เลือกประจำแต่ไม่กรอกวันที่ = ประจำตั้งแต่วันนี้", () => {
    expect(parse({ employmentType: "permanent" }).value?.permanentSince).toBe(TODAY);
  });

  it("ไม่ใช่พนักงานประจำ = ไม่มีวันที่ประจำ (R8)", () => {
    expect(parse({ employmentType: "daily", permanentSince: "2026-01-01" }).value?.permanentSince).toBeUndefined();
  });

  it("ประเภทการจ้างไม่รู้จัก ถูกปฏิเสธ", () => {
    expect(parse({ employmentType: "contractor" }).error).toBe("ประเภทการจ้างไม่ถูกต้อง");
  });

  it("รหัสพนักงานยาวเกิน 30 ตัว ถูกปฏิเสธ (ไม่ตัดทิ้งเงียบ ๆ)", () => {
    expect(parse({ employeeCode: "A".repeat(31) }).error).not.toBeNull();
    expect(parse({ employeeCode: "A".repeat(30) }).error).toBeNull();
  });

  it("เลขบัญชีว่าง = ไม่เปลี่ยน; ติ๊กลบ = ลบ; กรอกเลขใหม่แล้วติ๊กลบ = ใช้เลขใหม่", () => {
    expect(parse({}).value?.clearBankAccount).toBe(false);
    expect(parse({ clearBankAccount: "on" }).value?.clearBankAccount).toBe(true);
    const both = parse({ clearBankAccount: "on", bankAccountNo: "1234567890" }).value;
    expect(both?.bankAccountNo).toBe("1234567890");
    expect(both?.clearBankAccount).toBe(false);
  });

  it("รหัสพนักงานห้ามมีช่องว่าง/อักขระพิเศษ แต่รับภาษาไทยได้", () => {
    expect(parse({ employeeCode: "EMP 01" }).error).not.toBeNull();
    expect(parse({ employeeCode: "EMP<1>" }).error).not.toBeNull();
    expect(parse({ employeeCode: "พนง-07" }).error).toBeNull();
  });

  it("วันที่ผิดรูปแบบหรือไม่มีจริง ถูกปฏิเสธ", () => {
    expect(parse({ seniorityStartDate: "2026-02-30" }).error).toBe("วันที่ไม่ถูกต้อง");
    expect(parse({ employmentEndDate: "06/11/2026" }).error).toBe("วันที่ไม่ถูกต้อง");
  });

  it("วันเริ่มงานห้ามเกินวันนี้ และวันออกงานห้ามก่อนวันเริ่มงาน", () => {
    expect(parse({ seniorityStartDate: "2026-12-01" }).error).toBe("วันเริ่มงานต้องไม่เกินวันนี้");
    expect(parse({ seniorityStartDate: "2026-05-01", employmentEndDate: "2026-04-30" }).error).toBe(
      "วันออกงานต้องไม่ก่อนวันเริ่มงาน",
    );
  });

  it("เลขบัญชีต้องเป็นตัวเลข 6–20 หลัก", () => {
    expect(parse({ bankAccountNo: "12345" }).error).not.toBeNull();
    expect(parse({ bankAccountNo: "12ab5678" }).error).not.toBeNull();
  });

  it("ค่าเริ่มต้นประเภทการจ้าง: เงินเดือน = ประจำ, รายวัน/ชั่วโมง = รายวัน", () => {
    expect(defaultEmploymentType("monthly")).toBe("permanent");
    expect(defaultEmploymentType("daily")).toBe("daily");
    expect(defaultEmploymentType("hourly")).toBe("daily");
  });

  it("ปิดเลขบัญชีเหลือ 4 หลักท้าย", () => {
    expect(maskBankAccount("1234567890")).toBe("••7890");
    expect(maskBankAccount("")).toBe("");
    expect(maskBankAccount(undefined)).toBe("");
  });

  it("อายุงานเป็นปี/เดือน นับเดือนเต็ม", () => {
    expect(seniorityLabel("2025-09-06", "2026-11-06")).toBe("1 ปี 2 เดือน");
    expect(seniorityLabel("2025-09-07", "2026-11-06")).toBe("1 ปี 1 เดือน");
    expect(seniorityLabel("2026-10-20", "2026-11-06")).toBe("ไม่ถึง 1 เดือน");
    expect(seniorityLabel(undefined, "2026-11-06")).toBe("");
  });

  it("ผู้ออกสลิป: ข้อมูล HR ก่อน แล้วจึงใบเสร็จ แล้วจึงชื่อร้าน", () => {
    expect(resolvePayslipIssuer({}, null, "ร้าน A")).toEqual({ name: "ร้าน A", address: undefined, taxId: undefined });
    expect(resolvePayslipIssuer({}, { storeName: "ร้าน A (ใบเสร็จ)", taxId: "1234567890123" }, "ร้าน A")).toMatchObject({
      name: "ร้าน A (ใบเสร็จ)",
      taxId: "1234567890123",
    });
    // ตั้งชื่อนิติบุคคลแล้ว ห้ามหยิบเลขภาษี/ที่อยู่ของใบเสร็จมาปน (อาจเป็นคนละนิติบุคคล)
    expect(
      resolvePayslipIssuer({ payslipLegalName: "บริษัท เอ จำกัด" }, { storeName: "ร้าน A", taxId: "1", address: "x" }, "ร้าน A"),
    ).toEqual({ name: "บริษัท เอ จำกัด", address: undefined, taxId: undefined });
    expect(
      resolvePayslipIssuer({ payslipLegalName: "บริษัท เอ จำกัด", payslipTaxId: "0105500000000" }, null, "ร้าน A"),
    ).toMatchObject({ taxId: "0105500000000" });
  });
});

describe("migration P1: ฟิลด์พนักงาน + อายุงานอัตโนมัติ", () => {
  const sql = readFileSync(
    join(process.cwd(), "supabase/migrations/20261106120000_employee_payslip_profile_fields.sql"),
    "utf8",
  );

  it("เพิ่มคอลัมน์ข้อมูลพนักงานครบ", () => {
    for (const col of [
      "employee_code", "full_name", "position", "employment_type", "permanent_since",
      "seniority_start_date", "employment_end_date", "bank_name", "bank_account_no", "bank_account_name",
    ]) {
      expect(sql).toContain(`add column if not exists ${col}`);
    }
    expect(sql).toContain("check (employment_type in ('permanent', 'daily', 'part_time', 'temporary'))");
  });

  it("รหัสพนักงานไม่ซ้ำในสาขาเดียวกัน", () => {
    expect(sql).toContain("on employee_profiles (store_id, employee_code)");
  });

  it("รายวัน/รายชั่วโมงเดิมไม่ถูกนับเป็นพนักงานประจำ (R8)", () => {
    expect(sql).toMatch(/set employment_type = 'daily'\s+where pay_type in \('daily', 'hourly'\)/);
  });

  it("อายุงาน: backfill จากวันแรกที่ลงเวลาในสาขา + trigger ตอนลงเวลาครั้งแรก (R10, R12)", () => {
    expect(sql).toContain("select store_id, user_id, min(date) as d");
    expect(sql).toContain("after insert on attendance_records");
    expect(sql).toContain("before insert on employee_profiles");
    // trigger ไม่ทับวันที่ผู้จัดการตั้งเอง (R25) และต้องไม่ทำให้การลงเวลาล้ม (ชน end_after_start_check)
    expect(sql).toMatch(/and seniority_start_date is null\s+and \(employment_end_date is null or employment_end_date >= new\.date\);/);
    expect(sql.match(/^security definer$/gm)?.length).toBe(2);
    expect(sql.match(/set search_path = public/g)?.length).toBe(2);
  });

  it("ข้อมูลนิติบุคคลบนสลิปอยู่ที่ store_hr_settings", () => {
    expect(sql).toContain("add column if not exists payslip_legal_name text");
    expect(sql).toContain("add column if not exists payslip_tax_id text");
  });
});

describe("หน้า /staff ไม่ส่งเลขบัญชีเต็มไปที่ browser", () => {
  const page = readFileSync(join(process.cwd(), "src/app/(dashboard)/staff/page.tsx"), "utf8");
  const manager = readFileSync(join(process.cwd(), "src/app/(dashboard)/staff/StaffManager.tsx"), "utf8");

  it("ตัด bankAccountNo ออกก่อนส่ง props ให้ client component", () => {
    expect(page).toContain("profiles.map(({ bankAccountNo, ...p }) => ({");
    expect(page).toContain("profiles={clientProfiles}");
  });

  it("ฟอร์มไม่อ่าน bankAccountNo เต็ม", () => {
    expect(manager).not.toContain("profile?.bankAccountNo");
    expect(manager).not.toContain("profile.bankAccountNo");
  });
});
