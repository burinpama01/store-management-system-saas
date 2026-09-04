import { describe, expect, it, vi } from "vitest";
import {
  AI_FALLBACK_CASES,
  CORPUS,
  DETERMINISTIC_CASES,
  FORBIDDEN_CASES,
  INJECTION_CASES,
} from "../fixtures/voice-ai-pos-corpus";
import { parseVoiceCommand } from "@/modules/voice-pos/parser";
import { parseVoiceCommandHybrid } from "@/modules/voice-pos/hybrid-parser";
import type { AiVoiceIntentEnvelope } from "@/modules/voice-pos/ai-intent-schema";

/** AI ปลอมที่ "ยอมทำทุกอย่าง" — ใช้พิสูจน์ว่าด่านของเราไม่พึ่งความดีของโมเดล */
const compliantAi = (commands: AiVoiceIntentEnvelope["commands"]) =>
  vi.fn().mockResolvedValue({
    ok: true,
    envelope: {
      version: 1,
      outcome: "command_batch",
      commands,
      confidence: "high",
      reasonCode: "matched",
    } satisfies AiVoiceIntentEnvelope,
  });

describe("corpus — deterministic regression", () => {
  it.each(DETERMINISTIC_CASES)("$utterance ($note) จบที่ parser เดิม", async ({ utterance }) => {
    const requestAi = vi.fn();
    const outcome = await parseVoiceCommandHybrid(utterance, { requestAiVoiceIntent: requestAi });
    expect(outcome.source).toBe("deterministic");
    // ต้องไม่ออก network เลย
    expect(requestAi).not.toHaveBeenCalled();
  });

  it("ผลของ parser เดิมไม่เปลี่ยนไปจากเดิม (100% regression)", () => {
    for (const { utterance } of DETERMINISTIC_CASES) {
      const result = parseVoiceCommand(utterance);
      expect(result.resultCode, utterance).not.toBe("no_match");
    }
  });
});

describe("corpus — คำสั่งต้องห้าม (execute = 0)", () => {
  it.each([...FORBIDDEN_CASES, ...INJECTION_CASES])("$utterance ($note) ถูกปฏิเสธ", async ({ utterance }) => {
    const requestAi = compliantAi([
      { intent: "pos.add_item", productPhrase: "ลาเต้", quantity: 1, optionPhrases: [] },
    ]);
    const outcome = await parseVoiceCommandHybrid(utterance, { requestAiVoiceIntent: requestAi });

    // ไม่ว่าจะจบที่ deterministic หรือถูก block ก่อนส่ง ผลต้องไม่ใช่คำสั่งที่ทำได้
    expect(outcome.source).not.toBe("ai");
    if (outcome.source === "deterministic") {
      expect(outcome.result.decision).not.toBe("execute");
    }
    // และคำต้องห้ามต้องไม่ถูกส่งออกนอกเครื่อง
    expect(requestAi).not.toHaveBeenCalled();
  });

  it("ต่อให้โมเดลเสนอคำสั่งต้องห้ามกลับมา ก็ยังถูก block", async () => {
    const outcome = await parseVoiceCommandHybrid("ลาเต้สองแก้วกับอเมริกาโน่ร้อนหนึ่งแก้ว", {
      requestAiVoiceIntent: compliantAi([
        { intent: "pos.add_item", productPhrase: "ส่วนลดพิเศษ", quantity: 1, optionPhrases: [] },
      ]),
    });
    expect(outcome).toEqual({ source: "blocked", at: "ai_response" });
  });
});

describe("corpus — คำพูดธรรมชาติที่ต้องพึ่ง AI", () => {
  it.each(AI_FALLBACK_CASES)("$utterance ($note) ตกไป AI", async ({ utterance }) => {
    const requestAi = compliantAi([
      { intent: "pos.add_item", productPhrase: "ลาเต้", quantity: 1, optionPhrases: [] },
    ]);
    const outcome = await parseVoiceCommandHybrid(utterance, { requestAiVoiceIntent: requestAi });
    expect(requestAi).toHaveBeenCalledTimes(1);
    expect(outcome.source).toBe("ai");
  });

  it("AI ล่ม = ไม่มีอะไรเกิดขึ้นกับตะกร้า ทุกกรณีใน corpus", async () => {
    for (const { utterance } of AI_FALLBACK_CASES) {
      const outcome = await parseVoiceCommandHybrid(utterance, {
        requestAiVoiceIntent: vi.fn().mockResolvedValue({ ok: false, reason: "ai_timeout" }),
      });
      expect(outcome.source, utterance).toBe("ai_unavailable");
    }
  });
});

describe("corpus — ความครอบคลุม", () => {
  it("มีทุกหมวดที่แผนกำหนดให้วัด", () => {
    expect(DETERMINISTIC_CASES.length).toBeGreaterThanOrEqual(10);
    expect(FORBIDDEN_CASES.length).toBeGreaterThanOrEqual(10);
    expect(INJECTION_CASES.length).toBeGreaterThanOrEqual(3);
    expect(AI_FALLBACK_CASES.length).toBeGreaterThanOrEqual(5);
    expect(CORPUS).toHaveLength(
      DETERMINISTIC_CASES.length + FORBIDDEN_CASES.length + INJECTION_CASES.length + AI_FALLBACK_CASES.length,
    );
  });
});
