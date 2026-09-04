import { describe, expect, it } from "vitest";
import {
  AI_VOICE_MAX_COMMANDS,
  AiVoiceIntentEnvelopeSchema,
  normalizeAiCommandQuantity,
  parseAiVoiceEnvelope,
  type AiVoiceCommand,
} from "@/modules/voice-pos/ai-intent-schema";

const command = (over: Partial<AiVoiceCommand> = {}): AiVoiceCommand => ({
  intent: "pos.add_item",
  productPhrase: "ลาเต้",
  quantity: 2,
  optionPhrases: [],
  ...over,
});

const envelope = (over: Record<string, unknown> = {}) => ({
  version: 1,
  outcome: "command_batch",
  commands: [command()],
  confidence: "high",
  reasonCode: "matched",
  ...over,
});

describe("AI voice intent envelope", () => {
  it("รับ envelope ที่ถูกต้อง", () => {
    const parsed = parseAiVoiceEnvelope(envelope());
    expect(parsed.ok).toBe(true);
  });

  it("ปฏิเสธ id ที่โมเดลส่งมาเอง และ intent นอก allowlist", () => {
    // โมเดลห้ามเป็นคนเลือกสินค้า — id ต้องมาจาก resolver ของระบบเท่านั้น
    expect(() =>
      AiVoiceIntentEnvelopeSchema.parse(
        envelope({ commands: [{ ...command(), productId: "p1" }] }),
      ),
    ).toThrow();

    expect(() =>
      AiVoiceIntentEnvelopeSchema.parse(
        envelope({ commands: [{ intent: "payment", productPhrase: "x", quantity: 1, optionPhrases: [] }] }),
      ),
    ).toThrow();
  });

  it("ปฏิเสธคีย์แปลกปลอมที่ระดับ envelope", () => {
    expect(parseAiVoiceEnvelope(envelope({ note: "hello" })).ok).toBe(false);
  });

  it("ปฏิเสธจำนวนนอกช่วง 1–99 และจำนวนที่ไม่ใช่จำนวนเต็ม", () => {
    for (const quantity of [0, 100, 2.5, -1]) {
      expect(parseAiVoiceEnvelope(envelope({ commands: [command({ quantity })] })).ok).toBe(false);
    }
  });

  it("ปฏิเสธ batch ที่ยาวเกินเพดาน", () => {
    const tooMany = Array.from({ length: AI_VOICE_MAX_COMMANDS + 1 }, () => command());
    expect(parseAiVoiceEnvelope(envelope({ commands: tooMany })).ok).toBe(false);
  });

  it("ปฏิเสธวลีที่ยาวเกิน 120 ตัวอักษร และตัวเลือกเกิน 8 รายการ", () => {
    expect(parseAiVoiceEnvelope(envelope({ commands: [command({ productPhrase: "ก".repeat(121) })] })).ok).toBe(false);
    expect(
      parseAiVoiceEnvelope(envelope({ commands: [command({ optionPhrases: Array.from({ length: 9 }, () => "ร้อน") })] })).ok,
    ).toBe(false);
  });

  it("outcome ที่ไม่ใช่ command_batch ห้ามแนบคำสั่ง และ command_batch ห้ามว่าง", () => {
    expect(parseAiVoiceEnvelope(envelope({ outcome: "unknown", reasonCode: "unsupported" })).ok).toBe(false);
    expect(parseAiVoiceEnvelope(envelope({ outcome: "command_batch", commands: [] })).ok).toBe(false);
    expect(
      parseAiVoiceEnvelope(envelope({ outcome: "clarification", commands: [], reasonCode: "ambiguous" })).ok,
    ).toBe(true);
  });

  it("คำสั่งที่ต้องมีสินค้าแต่ไม่มีวลีสินค้า = ปฏิเสธ", () => {
    expect(parseAiVoiceEnvelope(envelope({ commands: [command({ productPhrase: null })] })).ok).toBe(false);
    // clear_search ไม่ต้องมีสินค้า แต่ห้ามแนบตัวเลือก
    expect(
      parseAiVoiceEnvelope(
        envelope({ commands: [command({ intent: "pos.clear_search", productPhrase: null, quantity: null })] }),
      ).ok,
    ).toBe(true);
    expect(
      parseAiVoiceEnvelope(
        envelope({
          commands: [command({ intent: "pos.clear_search", productPhrase: null, quantity: null, optionPhrases: ["ร้อน"] })],
        }),
      ).ok,
    ).toBe(false);
  });

  it("จำนวน null: add/set ต้องถาม ส่วน increase/decrease คือทีละ 1", () => {
    expect(normalizeAiCommandQuantity(command({ quantity: null }))).toBeNull();
    expect(normalizeAiCommandQuantity(command({ intent: "pos.set_quantity", quantity: null }))).toBeNull();
    expect(normalizeAiCommandQuantity(command({ intent: "pos.increase_item", quantity: null }))).toBe(1);
    expect(normalizeAiCommandQuantity(command({ intent: "pos.decrease_item", quantity: null }))).toBe(1);
    expect(normalizeAiCommandQuantity(command({ intent: "pos.increase_item", quantity: 3 }))).toBe(3);
  });
});
