// U13 — parser ของ voice POS ต้อง deterministic และ "ไม่รู้จัก = ไม่ทำ" เสมอ
// เกณฑ์จากแผน: ชุดวลีไทย 30 วลี ต้องได้ intent ถูกอย่างน้อย 29 วลี และ forbidden execute = 0
import { describe, expect, it } from "vitest";
import {
  normalizeThaiTranscript,
  parseVoiceCommand,
  VOICE_MAX_QUANTITY,
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
