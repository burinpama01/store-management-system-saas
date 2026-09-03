// U13 — parser ของ voice POS ต้อง deterministic และ "ไม่รู้จัก = ไม่ทำ" เสมอ
// เกณฑ์จากแผน: ชุดวลีไทย 30 วลี ต้องได้ intent ถูกอย่างน้อย 29 วลี และ forbidden execute = 0
import { describe, expect, it } from "vitest";
import {
  normalizeThaiTranscript,
  parseVoiceCommand,
  VOICE_MAX_QUANTITY,
  matchesVoiceChoicePhrase,
  normalizeVoiceChoicePhrase,
} from "@/modules/voice-pos/parser";
import { buildVoiceTelemetry, type VoiceIntentType } from "@/modules/voice-pos/types";

describe("normalizeThaiTranscript", () => {
  it("ตัดช่องว่างเกิน แปลงเลขไทย และตัดคำลงท้ายสุภาพ", () => {
    expect(normalizeThaiTranscript("  เพิ่ม ลาเต้  ๒ แก้ว ครับ ")).toBe("เพิ่ม ลาเต้ 2 แก้ว");
    expect(normalizeThaiTranscript("เปิดรายงานนะครับ")).toBe("เปิดรายงาน");
  });

  it("แปลงคำจำนวนเฉพาะตำแหน่งที่เป็นจำนวนจริง (ห้ามทำลายชื่อสินค้า)", () => {
    expect(normalizeThaiTranscript("เพิ่มลาเต้สองแก้ว")).toBe("เพิ่มลาเต้ 2 แก้ว");
    expect(normalizeThaiTranscript("ตั้งจำนวนลาเต้เป็นสาม")).toBe("ตั้งจำนวนลาเต้เป็น 3");
    // "สาม" อยู่กลางชื่อสินค้า ต้องไม่ถูกแปลง
    expect(normalizeThaiTranscript("เพิ่มหมูสามชั้น")).toBe("เพิ่มหมูสามชั้น");
  });

  it("ข้อความว่างคืนค่าว่าง ไม่ throw", () => {
    expect(normalizeThaiTranscript("   ")).toBe("");
  });
});

describe("parseVoiceCommand — allowlist matrix (30 วลี)", () => {
  const cases: ReadonlyArray<readonly [string, VoiceIntentType]> = [
    // Tier A · navigate (8)
    ["เปิดรายงาน", "navigate"],
    ["เปิดหน้าสต๊อก", "navigate"],
    ["ไปที่ครัว", "navigate"],
    ["ไปหน้าโต๊ะ", "navigate"],
    ["แสดงคิวครัว", "navigate"],
    ["เปิดตั้งค่า", "navigate"],
    ["ไปที่หน้าขาย", "navigate"],
    ["เปิดขอเพลง", "navigate"],
    // Tier B · add item (10)
    ["เพิ่มลาเต้", "pos.add_item"],
    ["เพิ่มลาเต้ 2 แก้ว", "pos.add_item"],
    ["เพิ่มลาเต้สองแก้ว", "pos.add_item"],
    ["เพิ่มข้าวผัด 3 จาน", "pos.add_item"],
    ["เพิ่มน้ำเปล่า ๔ ขวด", "pos.add_item"],
    ["ใส่ชาเย็น 2", "pos.add_item"],
    ["สั่งอเมริกาโน่", "pos.add_item"],
    ["เพิ่มหมูสามชั้น", "pos.add_item"],
    ["เพิ่มโค้ก 1 กระป๋อง", "pos.add_item"],
    ["เพิ่มลาเต้ 2 แก้ว ครับ", "pos.add_item"],
    // Tier B · set quantity (6)
    ["ตั้งจำนวนลาเต้เป็น 3", "pos.set_quantity"],
    ["ตั้งจำนวนลาเต้เป็นสาม", "pos.set_quantity"],
    ["ตั้งจำนวน ข้าวผัด เป็น 2", "pos.set_quantity"],
    ["เปลี่ยนจำนวนชาเย็นเป็น 5", "pos.set_quantity"],
    ["แก้จำนวนโค้กเป็น 1", "pos.set_quantity"],
    ["ตั้งจำนวนน้ำเปล่าเป็น 10 ขวด", "pos.set_quantity"],
    // Tier D · forbidden (6) → ต้องเป็น unknown เสมอ
    ["ชำระเงิน", "unknown"],
    ["เช็คบิลโต๊ะ 5", "unknown"],
    ["ล้างตะกร้า", "unknown"],
    ["ให้ส่วนลด 50 บาท", "unknown"],
    ["ยกเลิกรายการนี้", "unknown"],
    ["เปิดกะ", "unknown"],
  ];

  it("จับ intent ถูกอย่างน้อย 29 จาก 30 วลี", () => {
    expect(cases).toHaveLength(30);
    const wrong = cases.filter(([phrase, expected]) => parseVoiceCommand(phrase).intent.type !== expected);
    expect(wrong.map(([phrase]) => phrase)).toEqual([]);
  });

  it("วลีต้องห้ามต้องไม่ execute แม้แต่วลีเดียว", () => {
    const forbidden = cases.filter(([, expected]) => expected === "unknown");
    for (const [phrase] of forbidden) {
      const result = parseVoiceCommand(phrase);
      expect(result.decision).toBe("block");
      expect(result.tier).toBe("D");
      expect(result.resultCode).toBe("forbidden_command");
    }
  });
});

describe("parseVoiceCommand — slots และความปลอดภัย", () => {
  it("add_item: ไม่ระบุจำนวน = 1 และตัดหน่วยนับออกจากชื่อสินค้า", () => {
    const one = parseVoiceCommand("เพิ่มลาเต้");
    expect(one.intent).toEqual({ type: "pos.add_item", productPhrase: "ลาเต้", quantity: 1 });
    expect(one.decision).toBe("execute");

    const two = parseVoiceCommand("เพิ่มลาเต้ 2 แก้ว");
    expect(two.intent).toEqual({ type: "pos.add_item", productPhrase: "ลาเต้", quantity: 2 });
  });

  it("ตัดหน่วยนับทั่วไปท้ายประโยคออกจากชื่อสินค้า", () => {
    const result = parseVoiceCommand("เพิ่มโค้ก 1 กระป๋อง");
    expect(result.intent).toEqual({ type: "pos.add_item", productPhrase: "โค้ก", quantity: 1 });
  });

  it("set_quantity: คืน slot ครบและ execute ได้", () => {
    const result = parseVoiceCommand("ตั้งจำนวนข้าวผัดเป็น 4");
    expect(result.intent).toEqual({ type: "pos.set_quantity", productPhrase: "ข้าวผัด", quantity: 4 });
    expect(result.decision).toBe("execute");
    expect(result.tier).toBe("B");
  });

  it("navigate: คืน query ดิบให้ U14 ไป match กับ visible command list", () => {
    const result = parseVoiceCommand("เปิดรายงานยอดขาย");
    expect(result.intent).toEqual({ type: "navigate", query: "รายงานยอดขาย" });
    expect(result.tier).toBe("A");
  });

  it("จำนวนนอกช่วง 1–99 ต้องไม่ execute", () => {
    for (const phrase of ["เพิ่มลาเต้ 0", `เพิ่มลาเต้ ${VOICE_MAX_QUANTITY + 1}`, "ตั้งจำนวนลาเต้เป็น 0"]) {
      const result = parseVoiceCommand(phrase);
      expect(result.decision).not.toBe("execute");
      expect(result.resultCode).toBe("invalid_quantity");
      expect(result.intent.type).toBe("unknown");
    }
  });

  it("คำสั่งที่ไม่รู้จักและข้อความว่าง ต้อง block เสมอ", () => {
    const unknown = parseVoiceCommand("อากาศวันนี้เป็นยังไง");
    expect(unknown.intent.type).toBe("unknown");
    expect(unknown.decision).toBe("block");
    expect(unknown.resultCode).toBe("no_match");

    const empty = parseVoiceCommand("   ");
    expect(empty.decision).toBe("block");
    expect(empty.resultCode).toBe("empty_transcript");
  });

  it("ความมั่นใจจาก engine ต่ำ = ลดชั้นเป็น preview ไม่ execute", () => {
    const low = parseVoiceCommand("เพิ่มลาเต้ 2", { recognitionConfidence: 0.2 });
    expect(low.confidenceBucket).toBe("low");
    expect(low.decision).toBe("preview");
    expect(low.resultCode).toBe("low_confidence");

    const high = parseVoiceCommand("เพิ่มลาเต้ 2", { recognitionConfidence: 0.95 });
    expect(high.confidenceBucket).toBe("high");
    expect(high.decision).toBe("execute");
  });

  it("parser เป็น pure — เรียกซ้ำได้ผลเดิม", () => {
    const a = parseVoiceCommand("เพิ่มลาเต้ 2 แก้ว");
    const b = parseVoiceCommand("เพิ่มลาเต้ 2 แก้ว");
    expect(a).toEqual(b);
  });
});

describe("buildVoiceTelemetry — privacy contract", () => {
  it("มีเฉพาะ intent/result/locale/bucket/time และไม่มีคำพูดของผู้ใช้", () => {
    const result = parseVoiceCommand("เพิ่มลาเต้ 2 แก้ว");
    const event = buildVoiceTelemetry(result, "th-TH", new Date("2026-09-03T00:00:00.000Z"));
    expect(Object.keys(event).sort()).toEqual(["at", "confidenceBucket", "intentType", "locale", "resultCode"]);
    expect(JSON.stringify(event)).not.toContain("ลาเต้");
    expect(event.at).toBe("2026-09-03T00:00:00.000Z");
  });
});

// U15 — คำสั่งตะกร้าเพิ่มเติม (เพิ่มอีก/ลด/ลบ/ล้างการค้นหา)
describe("parseVoiceCommand — คำสั่งตะกร้า U15", () => {
  it("เพิ่มอีก N <สินค้า> และ <สินค้า> อีก N", () => {
    expect(parseVoiceCommand("เพิ่มอีก 2 ลาเต้").intent).toEqual({
      type: "pos.increase_item",
      productPhrase: "ลาเต้",
      delta: 2,
    });
    expect(parseVoiceCommand("ลาเต้อีก 1").intent).toEqual({
      type: "pos.increase_item",
      productPhrase: "ลาเต้",
      delta: 1,
    });
  });

  it("ลด <สินค้า> [จำนวน] — ไม่ระบุ = 1", () => {
    expect(parseVoiceCommand("ลดลาเต้ 2").intent).toEqual({
      type: "pos.decrease_item",
      productPhrase: "ลาเต้",
      delta: 2,
    });
    expect(parseVoiceCommand("ลดลาเต้").intent).toEqual({
      type: "pos.decrease_item",
      productPhrase: "ลาเต้",
      delta: 1,
    });
  });

  it("ลบ/เอาออก เป็น Tier B แล้ว (ย้อนกลับได้) ไม่ใช่คำต้องห้าม", () => {
    const removed = parseVoiceCommand("ลบลาเต้");
    expect(removed.intent).toEqual({ type: "pos.remove_item", productPhrase: "ลาเต้" });
    expect(removed.tier).toBe("B");
    expect(parseVoiceCommand("เอาลาเต้ออก").intent).toEqual({
      type: "pos.remove_item",
      productPhrase: "ลาเต้",
    });
  });

  it("ล้างการค้นหาได้ แต่ล้างตะกร้ายังต้องห้าม", () => {
    expect(parseVoiceCommand("ล้างการค้นหา").intent).toEqual({ type: "pos.clear_search" });
    const clearCart = parseVoiceCommand("ล้างตะกร้า");
    expect(clearCart.intent.type).toBe("unknown");
    expect(clearCart.resultCode).toBe("forbidden_command");
  });

  it("คำสั่งการเงินยังต้องห้ามทั้งหมดหลังเพิ่ม intent ใหม่", () => {
    for (const phrase of ["ชำระเงิน", "เช็คบิลโต๊ะ 5", "คืนเงิน", "ให้ส่วนลด 50 บาท", "ยกเลิกรายการนี้"]) {
      const result = parseVoiceCommand(phrase);
      expect(result.decision, phrase).toBe("block");
      expect(result.intent.type, phrase).toBe("unknown");
    }
  });
});

// U21 — คำศัพท์ที่แต่ละร้านเรียกไม่เหมือนกัน (ตะกร้า = ออเดอร์) + เลือกตัวเลือกด้วยเสียง
describe("parseVoiceCommand — คำศัพท์ร้าน U21", () => {
  it('"ลงตะกร้า" กับ "ลงออเดอร์" ให้ผลเหมือนกันทุกประการ', () => {
    const basket = parseVoiceCommand("เพิ่มลาเต้ลงตะกร้า");
    const order = parseVoiceCommand("เพิ่มลาเต้ลงออเดอร์");
    expect(basket.intent).toEqual({ type: "pos.add_item", productPhrase: "ลาเต้", quantity: 1 });
    expect(order.intent).toEqual(basket.intent);
    expect(parseVoiceCommand("เพิ่มลาเต้ลงออร์เดอร์").intent).toEqual(basket.intent);
  });

  it('ตัดคำว่า "เมนู" นำหน้าชื่อสินค้าออก', () => {
    expect(parseVoiceCommand("เพิ่มเมนูลาเต้ลงตะกร้า").intent).toEqual({
      type: "pos.add_item",
      productPhrase: "ลาเต้",
      quantity: 1,
    });
    expect(parseVoiceCommand("เพิ่มเมนูลาเต้ 2 แก้ว").intent).toEqual({
      type: "pos.add_item",
      productPhrase: "ลาเต้",
      quantity: 2,
    });
  });

  it("คำเติมท้ายอยู่หลังหน่วยนับก็ยังตัดออกได้", () => {
    expect(parseVoiceCommand("เพิ่มลาเต้ 2 แก้วลงออเดอร์").intent).toEqual({
      type: "pos.add_item",
      productPhrase: "ลาเต้",
      quantity: 2,
    });
  });

  it('"เลือก…" เป็น intent เลือกตัวเลือก แต่ "เอา…ออก" ยังเป็นลบรายการ', () => {
    expect(parseVoiceCommand("เลือกเล็ก").intent).toEqual({ type: "pos.choose_option", optionPhrase: "เล็ก" });
    expect(parseVoiceCommand("ขอหวานน้อย").intent).toEqual({
      type: "pos.choose_option",
      optionPhrase: "หวานน้อย",
    });
    expect(parseVoiceCommand("เอาลาเต้ออก").intent).toEqual({
      type: "pos.remove_item",
      productPhrase: "ลาเต้",
    });
  });

  it('"ยืนยัน/ตกลง" เป็น intent ยืนยันตัวเลือก', () => {
    for (const phrase of ["ยืนยัน", "ตกลง", "โอเค"]) {
      expect(parseVoiceCommand(phrase).intent, phrase).toEqual({ type: "pos.confirm_selection" });
    }
  });

  it("คำสั่งการเงินยังต้องห้ามเหมือนเดิมหลังเพิ่มคำศัพท์", () => {
    for (const phrase of ["ชำระเงิน", "เช็คบิล", "ล้างตะกร้า", "คืนเงิน", "ยกเลิกออเดอร์"]) {
      const result = parseVoiceCommand(phrase);
      expect(result.decision, phrase).toBe("block");
      expect(result.intent.type, phrase).toBe("unknown");
    }
  });
});

describe("จับคู่คำพูดกับชื่อตัวเลือก (เปลี่ยนทับค่าเริ่มต้นด้วยเสียง)", () => {
  it("พูดเปอร์เซ็นต์เป็นคำ → ตรงกับชื่อตัวเลือกที่เป็นสัญลักษณ์ %", () => {
    // ค่าเริ่มต้นความหวานคือ 100% แคชเชียร์ต้องพูดทับเป็น 0% ได้
    expect(matchesVoiceChoicePhrase("0%", "ศูนย์เปอร์เซ็นต์")).toBe(true);
    expect(matchesVoiceChoicePhrase("0%", "0 เปอร์เซ็นต์")).toBe(true);
    expect(matchesVoiceChoicePhrase("0%", "๐%")).toBe(true);
    expect(matchesVoiceChoicePhrase("25%", "ยี่สิบห้าเปอร์เซ็นต์")).toBe(true);
    expect(matchesVoiceChoicePhrase("100%", "หนึ่งร้อยเปอร์เซ็นต์")).toBe(true);
    expect(matchesVoiceChoicePhrase("150%", "ร้อยห้าสิบเปอร์เซ็นต์")).toBe(true);
  });

  it("เลขไทยแบบประกอบคำต้องได้ค่าที่ถูก ไม่ใช่ต่อเลขกันดื้อ ๆ", () => {
    // แทนที่ทีละคำจะได้ "205" จาก "ยี่สิบห้า" แล้วพาไปเลือกตัวเลือกผิดเงียบ ๆ
    expect(normalizeVoiceChoicePhrase("ยี่สิบห้า")).toBe("25");
    expect(normalizeVoiceChoicePhrase("สิบห้า")).toBe("15");
    expect(normalizeVoiceChoicePhrase("เจ็ดสิบห้า")).toBe("75");
    expect(normalizeVoiceChoicePhrase("หนึ่งร้อย")).toBe("100");
    expect(normalizeVoiceChoicePhrase("ร้อยห้าสิบ")).toBe("150");
    expect(normalizeVoiceChoicePhrase("ศูนย์")).toBe("0");
  });

  it("พูดชื่อกลุ่มนำหน้าค่าได้ — \"เลือกหวาน 0%\" ต้องเลือก 0% ไม่ใช่ไม่ตรงเลย", () => {
    expect(matchesVoiceChoicePhrase("0%", "หวานศูนย์เปอร์เซ็นต์")).toBe(true);
    expect(matchesVoiceChoicePhrase("0%", "ความหวาน 0%")).toBe(true);
    expect(matchesVoiceChoicePhrase("25%", "หวานยี่สิบห้าเปอร์เซ็นต์")).toBe(true);
    // ตัวเลขติดกันไม่นับเป็นชื่อกลุ่มนำหน้า
    expect(matchesVoiceChoicePhrase("50%", "150%")).toBe(false);
  });

  it("ตัวเลือกที่เป็นตัวเลขล้วนต้องตรงเป๊ะ — 0% ห้ามไปตรงกับ 100%", () => {
    // "100%".includes("0%") เป็นจริง ถ้าปล่อยให้จับคู่บางส่วน พูดว่าไม่หวานจะได้หวานสุด
    expect(matchesVoiceChoicePhrase("100%", "0%")).toBe(false);
    expect(matchesVoiceChoicePhrase("150%", "50%")).toBe(false);
    expect(matchesVoiceChoicePhrase("25%", "5%")).toBe(false);
  });

  it("ไม่จับคู่ข้ามค่า — 0% ต้องไม่ตรงกับ 100%", () => {
    expect(matchesVoiceChoicePhrase("100%", "ศูนย์เปอร์เซ็นต์")).toBe(false);
    expect(matchesVoiceChoicePhrase("0%", "ห้าสิบเปอร์เซ็นต์")).toBe(false);
  });

  it("ชื่อที่มีวงเล็บ/ช่องว่างกำกับยังจับคู่ได้", () => {
    expect(matchesVoiceChoicePhrase("คั่วเข้ม (+0)", "คั่วเข้ม")).toBe(true);
    expect(matchesVoiceChoicePhrase("เย็น +5", "เย็น")).toBe(true);
  });

  it("คำว่างไม่จับคู่กับอะไรเลย (กันเลือกมั่วเมื่อฟังไม่ได้ความ)", () => {
    expect(matchesVoiceChoicePhrase("ร้อน", "")).toBe(false);
    expect(matchesVoiceChoicePhrase("ร้อน", "   ")).toBe(false);
  });

  it("normalize แล้วนำไป normalize ซ้ำได้ผลเดิม (ผู้เรียกส่งค่าที่แปลงแล้วมาได้)", () => {
    const once = normalizeVoiceChoicePhrase("ศูนย์เปอร์เซ็นต์");
    expect(once).toBe("0%");
    expect(normalizeVoiceChoicePhrase(once)).toBe(once);
  });
});
