import { describe, expect, it } from "vitest";

import {
  STANDBY_PROPOSAL_WINDOW_MS,
  decideStandbyAction,
  describeProposal,
  isProposalValid,
  readStandbyVoiceReply,
  type StandbyProposal,
} from "@/modules/voice-pos/standby-policy";
import type { VoiceIntent, VoiceParseResult, VoiceSafetyTier } from "@/modules/voice-pos/types";

const NOW = 1_000_000;

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

describe("decideStandbyAction — กดปุ่มพูดเอง (ต้องเหมือนเดิมทุกประการ)", () => {
  it.each([
    ["เปิดหน้า", navigate],
    ["เพิ่มสินค้า", addItem],
    ["ตั้งจำนวน", setQuantity],
    ["เพิ่มจำนวน", increase],
    ["ลดจำนวน", decrease],
    ["เอาออก", remove],
    ["ล้างคำค้น", clearSearch],
    ["เลือกตัวเลือก", chooseOption],
    ["ยืนยันตัวเลือก", confirmSelection],
  ])("%s ทำได้เลยโดยไม่ต้องยืนยัน", (_name, result) => {
    expect(decideStandbyAction(result, "push_to_talk", NOW)).toEqual({ action: "execute", result });
  });
});

describe("decideStandbyAction — เปิดไมค์ด้วยคำปลุก", () => {
  it.each([
    ["เปิดหน้า", navigate],
    ["ล้างคำค้น", clearSearch],
    ["เลือกตัวเลือก", chooseOption],
  ])("%s ไม่แตะตะกร้า จึงทำได้เลย", (_name, result) => {
    expect(decideStandbyAction(result, "windows_standby", NOW)).toEqual({ action: "execute", result });
  });

  it.each([
    ["เพิ่มสินค้า", addItem],
    ["ตั้งจำนวน", setQuantity],
    ["เพิ่มจำนวน", increase],
    ["ลดจำนวน", decrease],
    ["เอาออก", remove],
    ["ยืนยันตัวเลือก", confirmSelection],
  ])("%s แตะตะกร้า จึงต้องยืนยันก่อน", (_name, result) => {
    // เสียงลูกค้าหรือทีวีที่ลอยเข้าไมค์ต้องไม่ขึ้นบิลเอง
    expect(decideStandbyAction(result, "windows_standby", NOW)).toEqual({
      action: "confirm",
      result,
      expiresAt: NOW + STANDBY_PROPOSAL_WINDOW_MS,
    });
  });
});

describe("decideStandbyAction — คำสั่งที่ห้ามอยู่แล้ว", () => {
  it.each(["push_to_talk", "windows_standby"] as const)("คำสั่งต้องห้าม ถูกปฏิเสธจากทาง %s", (origin) => {
    const forbidden = build({ type: "unknown" }, "D", "block", "forbidden_command");

    expect(decideStandbyAction(forbidden, origin, NOW)).toEqual({
      action: "block",
      reason: "forbidden_command",
    });
  });

  it("จำนวนไม่ถูกต้องยังคงถูกปฏิเสธ ไม่ใช่กลายเป็นข้อเสนอให้กดยืนยัน", () => {
    const invalid = build({ type: "unknown" }, "C", "preview", "invalid_quantity");

    expect(decideStandbyAction(invalid, "windows_standby", NOW)).toEqual({
      action: "block",
      reason: "invalid_quantity",
    });
  });

  it("ความมั่นใจต่ำถูกปฏิเสธ ไม่ใช่ให้ยืนยัน — เดาผิดแล้วให้กดยืนยันคือกับดัก", () => {
    const lowConfidence = build(
      { type: "pos.add_item", productPhrase: "กาแฟเย็น", quantity: 2 },
      "B",
      "preview",
      "low_confidence",
    );

    expect(decideStandbyAction(lowConfidence, "windows_standby", NOW)).toEqual({
      action: "block",
      reason: "low_confidence",
    });
  });

  it("tier D ที่หลุดมาเป็น execute ก็ยังต้องถูกปฏิเสธ (กันสองชั้นไม่ตรงกัน)", () => {
    const mismatched = build({ type: "pos.add_item", productPhrase: "x", quantity: 1 }, "D");

    expect(decideStandbyAction(mismatched, "push_to_talk", NOW)).toEqual({
      action: "block",
      reason: "forbidden_command",
    });
  });
});

describe("อายุของข้อเสนอ", () => {
  const proposal: StandbyProposal = {
    result: addItem,
    expiresAt: NOW + STANDBY_PROPOSAL_WINDOW_MS,
    sessionId: "sess1",
    label: "เพิ่ม กาแฟเย็น 2",
  };

  it("ยังไม่หมดอายุ = ใช้ได้", () => {
    expect(isProposalValid(proposal, NOW + 7_999)).toBe(true);
  });

  it("หมดอายุแล้ว = ใช้ไม่ได้", () => {
    expect(isProposalValid(proposal, NOW + STANDBY_PROPOSAL_WINDOW_MS)).toBe(false);
  });

  it("ไม่มีข้อเสนอ = ใช้ไม่ได้", () => {
    expect(isProposalValid(null, NOW)).toBe(false);
  });
});

describe("ยืนยันด้วยเสียง", () => {
  it.each(["ยืนยัน", "ตกลง", "ใช่", "เอาเลย", "ยืนยันครับ", "ตกลงค่ะ"])("“%s” คือการยืนยัน", (phrase) => {
    expect(readStandbyVoiceReply(phrase)).toBe("confirm");
  });

  it.each(["ยกเลิก", "ไม่ใช่", "ไม่เอา"])("“%s” คือการยกเลิก", (phrase) => {
    expect(readStandbyVoiceReply(phrase)).toBe("cancel");
  });

  it.each([
    "ตกลงว่าจะไปไหนดี",
    "ยืนยันการโอนเงินให้ด้วย",
    "เพิ่มกาแฟเย็นสองแก้ว",
    "",
    "ใช่ไหม",
  ])("“%s” ไม่นับเป็นคำตอบ — ต้องไม่ทำอะไรกับข้อเสนอ", (phrase) => {
    expect(readStandbyVoiceReply(phrase)).toBe("none");
  });

  it("เว้นวรรคเกินมาไม่ทำให้ยืนยันไม่ผ่าน", () => {
    expect(readStandbyVoiceReply("  ยืน ยัน  ")).toBe("confirm");
  });
});

describe("ป้ายของข้อเสนอ", () => {
  it.each([
    [addItem, "เพิ่ม กาแฟเย็น 2"],
    [setQuantity, "ตั้งจำนวน ชาเย็น เป็น 3"],
    [increase, "เพิ่ม ชาเย็น อีก 1"],
    [decrease, "ลด ชาเย็น ลง 1"],
    [remove, "เอา ชาเย็น ออก"],
    [confirmSelection, "ยืนยันตัวเลือกที่เลือกไว้"],
  ])("บอกได้ว่าจะทำอะไรกับอะไร", (result, expected) => {
    expect(describeProposal(result)).toBe(expected);
  });
});
