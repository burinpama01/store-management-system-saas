import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * เครื่องร้าน 2026-09-05: ตั้งค่า USB ครบ Hub ออนไลน์ เห็น POS-80C แต่ใบเสร็จทุกใบ
 * ยังวิ่งไปเครื่องพิมพ์ WiFi ตัวเก่า (192.168.1.42) แล้ว Connection timed out
 * เพราะฟอร์ม USB ในหน้า Print Hub ไม่เคยส่ง isDefault ไปที่ action เลย
 * (action รองรับอยู่แล้ว) เครื่องพิมพ์ USB จึงไม่มีทางกลายเป็นเครื่องที่ใบเสร็จออกจริง
 */
const manager = readFileSync(
  join(process.cwd(), "src/app/(dashboard)/settings/print-hub/PrintHubManager.tsx"),
  "utf8",
);
const action = readFileSync(
  join(process.cwd(), "src/app/(dashboard)/settings/receipt/actions.ts"),
  "utf8",
);

describe("ตั้งเครื่องพิมพ์ USB เป็นเครื่องพิมพ์ใบเสร็จหลัก", () => {
  it("ฟอร์มส่ง isDefault ไปทั้งสองทาง (เลือกจากรายการ และโหมดตรวจจับอัตโนมัติ)", () => {
    const occurrences = manager.match(/name="isDefault" value="on"/g) ?? [];
    expect(occurrences.length).toBe(2);
  });

  it("ค่าที่ส่งต้องตรงกับที่ action อ่าน", () => {
    // action เช็คแบบตรงตัว — ส่ง value อื่นเท่ากับไม่ได้ส่ง
    expect(action).toContain('formData.get("isDefault") === "on"');
  });

  it("บอกผู้ใช้ว่าตอนนี้ใบเสร็จออกที่เครื่องไหน", () => {
    expect(manager).toContain("currentDefault");
    expect(manager).toContain("ตอนนี้ใบเสร็จถูกส่งไปที่");
  });
});
