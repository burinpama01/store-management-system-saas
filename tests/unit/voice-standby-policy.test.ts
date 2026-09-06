import { describe, expect, it } from "vitest";

import { decideStandbyAction, readVoiceUndoReply } from "@/modules/voice-pos/standby-policy";
import type { VoiceIntent, VoiceParseResult, VoiceSafetyTier } from "@/modules/voice-pos/types";

function build(
  intent: VoiceIntent,
  tier: VoiceSafetyTier,
  decision: VoiceParseResult["decision"] = "execute",
  resultCode: VoiceParseResult["resultCode"] = "matched",
): VoiceParseResult {
  return { intent, tier, decision, confidence: 0.9, confidenceBucket: "high", resultCode };
}

const navigate = build({ type: "navigate", query: "รายงาน" }, "A");
const addItem = build({ type: "pos.add_item", productPhrase: "กาแฟเย็น", quantity: 2 }, "B");
const setQuantity = build({ type: "pos.set_quantity", productPhrase: "ชาเย็น", quantity: 3 }, "B");
const increase = build({ type: "pos.increase_item", productPhrase: "ชาเย็น", delta: 1 }, "B");
const decrease = build({ type: "pos.decrease_item", productPhrase: "ชาเย็น", delta: 1 }, "B");
const remove = build({ type: "pos.remove_item", productPhrase: "ชาเย็น" }, "B");
const clearSearch = build({ type: "pos.clear_search" }, "A");
const chooseOption = build({ type: "pos.choose_option", optionPhrase: "เล็ก" }, "A");
const confirmSelection = build({ type: "pos.confirm_selection" }, "B");

const CART_COMMANDS = [
  ["เพิ่มสินค้า", addItem],
  ["ตั้งจำนวน", setQuantity],
  ["เพิ่มจำนวน", increase],
  ["ลดจำนวน", decrease],
  ["เอาออก", remove],
  ["ยืนยันตัวเลือก", confirmSelection],
] as const;

const NON_CART_COMMANDS = [
  ["เปิดหน้า", navigate],
  ["ล้างคำค้น", clearSearch],
  ["เลือกตัวเลือก", chooseOption],
] as const;

describe("decideStandbyAction — ที่มาของไมค์ไม่เปลี่ยนคำตอบอีกแล้ว", () => {
  // การ์ดยืนยัน 8 วินาทีถูกถอดออก: engine ใหม่ (Vosk) วัดได้ว่าปลุกผิดเอง 0 ครั้ง
  // และของเดิมใช้จริงไม่ได้เพราะนาฬิกาเดินระหว่างที่ระบบยังพูดข้อเสนออยู่
  it.each([...CART_COMMANDS, ...NON_CART_COMMANDS])(
    "%s ทำได้เลยทั้งกดปุ่มเองและคำปลุก",
    (_name, result) => {
      expect(decideStandbyAction(result, "push_to_talk")).toEqual({ action: "execute", result });
      expect(decideStandbyAction(result, "windows_standby")).toEqual({ action: "execute", result });
    },
  );
});

describe("decideStandbyAction — คำสั่งที่ห้ามอยู่แล้ว (ไม่มีอะไรผ่อนลง)", () => {
  it.each(["push_to_talk", "windows_standby"] as const)("คำสั่งต้องห้าม ถูกปฏิเสธจากทาง %s", (origin) => {
    const forbidden = build({ type: "unknown" }, "D", "block", "forbidden_command");

    expect(decideStandbyAction(forbidden, origin)).toEqual({
      action: "block",
      reason: "forbidden_command",
    });
  });

  it("จำนวนไม่ถูกต้องยังคงถูกปฏิเสธ ไม่ใช่ลงมือทำ", () => {
    const invalid = build({ type: "unknown" }, "C", "preview", "invalid_quantity");

    expect(decideStandbyAction(invalid, "windows_standby")).toEqual({
      action: "block",
      reason: "invalid_quantity",
    });
  });

  it("ความมั่นใจต่ำถูกปฏิเสธ — ฟังไม่ชัดแล้วลงมือคือสิ่งที่ห้ามที่สุด", () => {
    const lowConfidence = build(
      { type: "pos.add_item", productPhrase: "กาแฟเย็น", quantity: 2 },
      "B",
      "preview",
      "low_confidence",
    );

    expect(decideStandbyAction(lowConfidence, "windows_standby")).toEqual({
      action: "block",
      reason: "low_confidence",
    });
  });

  it("tier D ที่หลุดมาเป็น execute ก็ยังต้องถูกปฏิเสธ (กันสองชั้นไม่ตรงกัน)", () => {
    const mismatched = build({ type: "pos.add_item", productPhrase: "x", quantity: 1 }, "D");

    expect(decideStandbyAction(mismatched, "push_to_talk")).toEqual({
      action: "block",
      reason: "forbidden_command",
    });
  });
});

describe("สั่งย้อนกลับด้วยเสียง", () => {
  it.each(["ยกเลิก", "ย้อนกลับ", "ย้อน", "ไม่เอา", "ไม่ใช่", "ยกเลิกครับ"])(
    "“%s” คือการย้อนกลับ",
    (phrase) => {
      expect(readVoiceUndoReply(phrase)).toBe("undo");
    },
  );

  it.each([
    "ยกเลิกโต๊ะ 3 ให้หน่อย",
    "ไม่เอาแล้วเดี๋ยวมาใหม่",
    "เพิ่มกาแฟเย็นสองแก้ว",
    "",
    "ยืนยัน",
  ])("“%s” ไม่นับเป็นคำสั่งย้อนกลับ", (phrase) => {
    // เดาความหมายไม่ได้: บทสนทนาในร้านจะย้อนตะกร้าของอีกคนได้
    expect(readVoiceUndoReply(phrase)).toBe("none");
  });

  it("เว้นวรรคเกินมาไม่ทำให้สั่งย้อนกลับไม่ผ่าน", () => {
    expect(readVoiceUndoReply("  ย้อน กลับ  ")).toBe("undo");
  });
});
