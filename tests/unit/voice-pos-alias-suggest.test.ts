// U22 — ตัวเสนอคำเรียกเมนูอัตโนมัติ: ต้อง deterministic และไม่เดามั่ว
import { describe, expect, it } from "vitest";
import { suggestAliasesForProduct, suggestVoiceAliases } from "@/modules/voice-pos/alias-suggest";

const texts = (name: string, id = "p1") =>
  suggestAliasesForProduct({ id, name }).map((s) => s.aliasText);

describe("suggestAliasesForProduct — แปลชื่ออังกฤษเป็นคำที่คนพูด", () => {
  it("เมนูคำเดียว", () => {
    expect(texts("Espresso")).toContain("เอสเพรสโซ");
    expect(texts("Mocha")).toContain("มอคค่า");
    expect(texts("Cocoa")).toContain("โกโก้");
  });

  it("เมนูหลายคำ ต่อกันตามลำดับที่พูดจริง", () => {
    expect(texts("Matcha latte")).toContain("มัจฉะลาเต้");
    expect(texts("Caramel latte")).toContain("คาราเมลลาเต้");
    expect(texts("Green tea")).toContain("ชาเขียว");
    expect(texts("THAI TEA")).toEqual(expect.arrayContaining(["ชาไทย"]));
  });

  it("มีคำพ้องก็เสนอให้เลือกได้", () => {
    expect(texts("Matcha latte")).toEqual(expect.arrayContaining(["มัจฉะลาเต้", "มัทฉะลาเต้"]));
  });

  it("คำอังกฤษที่ไม่มีในพจนานุกรม = ไม่เดา", () => {
    expect(texts("Yuzu Fizz")).toEqual([]);
  });

  it("ชื่อไทยล้วนที่พูดได้อยู่แล้ว ไม่ต้องเสนอคำซ้ำกับชื่อเมนู", () => {
    expect(texts("ลาเต้")).toEqual([]);
  });

  it("ตัดคำประกอบ/ราคา ออกเป็นคำเรียกสั้น", () => {
    expect(texts("ชุดหมูจุ่ม+ผัก 99")).toEqual(expect.arrayContaining(["หมูจุ่ม"]));
    expect(texts("สามชั้น จานเล็ก")).toEqual(expect.arrayContaining(["สามชั้น"]));
  });

  it("เสนอไม่เกิน 3 คำต่อเมนู", () => {
    expect(texts("Caramel Matcha latte").length).toBeLessThanOrEqual(3);
  });

  it("ผลลัพธ์คงที่ทุกครั้ง (deterministic)", () => {
    expect(texts("Matcha latte")).toEqual(texts("Matcha latte"));
  });
});

describe("suggestVoiceAliases — ทั้งเมนูของร้าน", () => {
  const CATALOG = [
    { id: "a", name: "Matcha latte" },
    { id: "b", name: "Espresso" },
    { id: "c", name: "ลาเต้" },
    { id: "d", name: "THAI TEA" },
  ];

  it("ข้ามคำที่ร้านบันทึกไว้แล้ว", () => {
    const all = suggestVoiceAliases(CATALOG);
    expect(all.map((s) => s.aliasText)).toContain("เอสเพรสโซ");

    const filtered = suggestVoiceAliases(CATALOG, ["เอสเพรสโซ"]);
    expect(filtered.map((s) => s.aliasText)).not.toContain("เอสเพรสโซ");
  });

  it("คำที่ชี้ไปได้หลายเมนู ต้องไม่ถูกเสนอ (กันกำกวม)", () => {
    const clashing = [
      { id: "x", name: "Matcha latte" },
      { id: "y", name: "Matcha Latte" },
    ];
    expect(suggestVoiceAliases(clashing)).toEqual([]);
  });

  it("ไม่เสนอคำที่ตรงกับชื่อเมนูอื่นอยู่แล้ว", () => {
    const catalog = [
      { id: "a", name: "Green tea" },
      { id: "b", name: "ชาเขียว" },
    ];
    expect(suggestVoiceAliases(catalog).map((s) => s.aliasText)).not.toContain("ชาเขียว");
  });

  it("ข้ามเมนูที่ปิดขาย", () => {
    expect(suggestVoiceAliases([{ id: "a", name: "Espresso", isActive: false }])).toEqual([]);
  });
});
