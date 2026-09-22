// ตัวแปลคำสั่งหลังร้าน
//
// เทสที่สำคัญที่สุดคือ **เส้นแบ่งกับหน้าขาย**: "เพิ่มเมนูลาเต้" = เพิ่มรายการเข้าระบบ
// ส่วน "เพิ่มลาเต้ 2 แก้ว" = คำสั่งตะกร้าที่ต้องไปสั่งที่ POS
// ก่อนมีไฟล์นี้ ทุกอย่างถูกส่งเข้า orchestrator ของหน้าขาย แล้วล้มเป็น "เซสชันหมดอายุ"

import { describe, it, expect } from "vitest";
import { parseBackOfficeCommand } from "@/modules/ai-assistant/back-office-intent";

describe("แปลคำสั่งหลังร้าน", () => {
  it("เพิ่มเมนูใหม่เข้าระบบ ไม่ใช่เพิ่มลงตะกร้า", () => {
    expect(parseBackOfficeCommand("เพิ่มเมนูอาหารต้ม")).toEqual({
      kind: "tool", tool: "catalog.create_product", args: { name: "อาหารต้ม" },
    });
    expect(parseBackOfficeCommand("สร้างเมนูใหม่ ชาเย็น ราคา 45")).toEqual({
      kind: "tool", tool: "catalog.create_product", args: { name: "ชาเย็น", price: 45 },
    });
  });

  it("คำสั่งตะกร้าถูกตีกลับพร้อมบอกให้ไปสั่งที่ POS", () => {
    for (const text of ["เพิ่มลาเต้ 2 แก้ว", "คิดเงิน", "เช็คบิล", "ข้าวผัด 3 จาน"]) {
      const parsed = parseBackOfficeCommand(text);
      expect(parsed.kind, `"${text}" ควรถูกตีกลับ`).toBe("pos_command");
      if (parsed.kind === "pos_command") expect(parsed.hint).toContain("POS");
    }
  });

  it("ลงรายจ่ายจากประโยคที่คนพูดจริง", () => {
    expect(parseBackOfficeCommand("ลงค่าน้ำแข็ง 450")).toEqual({
      kind: "tool", tool: "accounting.create_transaction",
      args: { type: "expense", amount: 450, note: "ค่าน้ำแข็ง" },
    });
    expect(parseBackOfficeCommand("บันทึกรายจ่าย ค่าไฟ 3,200 บาท")).toEqual({
      kind: "tool", tool: "accounting.create_transaction",
      args: { type: "expense", amount: 3200, note: "ค่าไฟ" },
    });
  });

  it("แยกรายรับออกจากรายจ่าย", () => {
    expect(parseBackOfficeCommand("รายรับอื่น 500 ค่าจัดเลี้ยง 500")).toMatchObject({
      tool: "accounting.create_transaction", args: { type: "income" },
    });
    expect(parseBackOfficeCommand("ลงรายรับ ค่าเช่าที่ 1200")).toEqual({
      kind: "tool", tool: "accounting.create_transaction",
      args: { type: "income", amount: 1200, note: "ค่าเช่าที่" },
    });
  });

  it("แก้ราคา", () => {
    expect(parseBackOfficeCommand("แก้ราคาอเมริกาโน่เย็นเป็น 60")).toEqual({
      kind: "tool", tool: "catalog.update_price", args: { product: "อเมริกาโน่เย็น", price: 60 },
    });
    expect(parseBackOfficeCommand("เปลี่ยนราคา ลาเต้ 55 บาท")).toEqual({
      kind: "tool", tool: "catalog.update_price", args: { product: "ลาเต้", price: 55 },
    });
  });

  it("ของหมด / กลับมามีขาย / ซ่อน / แสดง", () => {
    expect(parseBackOfficeCommand("อเมริกาโน่เย็นหมดวันนี้")).toEqual({
      kind: "tool", tool: "catalog.set_availability", args: { product: "อเมริกาโน่เย็น", state: "out_of_stock" },
    });
    expect(parseBackOfficeCommand("ข้าวผัดมีขายแล้ว")).toMatchObject({ args: { state: "back_in_stock" } });
    expect(parseBackOfficeCommand("ซ่อนเมนูโกโก้")).toMatchObject({ args: { product: "โกโก้", state: "hide" } });
    expect(parseBackOfficeCommand("เปิดขายโกโก้")).toMatchObject({ args: { product: "โกโก้", state: "show" } });
  });

  it("เปิด-ปิด QR ทั้งร้าน", () => {
    expect(parseBackOfficeCommand("เปิด QR ทุกเมนู")).toEqual({
      kind: "tool", tool: "qr.bulk_set_visibility", args: { scope: "all", visible: true },
    });
    expect(parseBackOfficeCommand("ปิดคิวอาร์ทั้งหมด")).toMatchObject({ args: { visible: false } });
  });

  it("ปรับสต็อก", () => {
    expect(parseBackOfficeCommand("ปรับสต็อกข้าวผัดเป็น 25")).toEqual({
      kind: "tool", tool: "stock.adjust", args: { product: "ข้าวผัด", quantity: 25 },
    });
    expect(parseBackOfficeCommand("สต็อกข้าวผัดเหลือ 0")).toMatchObject({ args: { quantity: 0 } });
  });

  it("ตัดคำลงท้ายที่ไม่ใช่ชื่อสินค้าออก", () => {
    expect(parseBackOfficeCommand("แก้ราคาลาเต้เป็น 60 บาท")).toMatchObject({ args: { product: "ลาเต้" } });
    expect(parseBackOfficeCommand("เพิ่มเมนูชาเย็นหน่อย")).toMatchObject({ args: { name: "ชาเย็น" } });
  });

  it("แปลไม่ได้ = ตอบว่าไม่รองรับ ไม่ใช่เดาไปทำอย่างอื่น", () => {
    for (const text of ["", "   ", "วันนี้อากาศดี", "ทำอะไรได้บ้าง"]) {
      expect(parseBackOfficeCommand(text).kind, `"${text}"`).toBe("unsupported");
    }
  });
});
