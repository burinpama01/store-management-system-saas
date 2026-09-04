import { describe, expect, it, vi } from "vitest";
import {
  AI_UNAVAILABLE_MESSAGE,
  parseVoiceCommandHybrid,
  validateAiProposalAgainstAllowlist,
} from "@/modules/voice-pos/hybrid-parser";
import { createVoiceRequestId, requestAiVoiceIntent } from "@/modules/voice-pos/ai-intent-client";
import type { AiVoiceIntentEnvelope } from "@/modules/voice-pos/ai-intent-schema";

const envelope = (over: Partial<AiVoiceIntentEnvelope> = {}): AiVoiceIntentEnvelope => ({
  version: 1,
  outcome: "command_batch",
  commands: [{ intent: "pos.add_item", productPhrase: "ลาเต้", quantity: 2, optionPhrases: [] }],
  confidence: "high",
  reasonCode: "matched",
  ...over,
} as AiVoiceIntentEnvelope);

describe("hybrid routing — deterministic ก่อนเสมอ", () => {
  it("คำสั่งที่ parser เดิมเข้าใจต้องไม่ออก network", async () => {
    const requestAi = vi.fn();
    const outcome = await parseVoiceCommandHybrid("เพิ่มลาเต้ 2 แก้ว", { requestAiVoiceIntent: requestAi });
    expect(outcome.source).toBe("deterministic");
    expect(requestAi).not.toHaveBeenCalled();
  });

  it("คำต้องห้ามไม่ถูกส่งออกนอกเครื่อง", async () => {
    const requestAi = vi.fn();
    const outcome = await parseVoiceCommandHybrid("ขอส่วนลดห้าสิบบาทให้ลูกค้าคนนี้ทีนะ", {
      requestAiVoiceIntent: requestAi,
    });
    expect(outcome.source).toMatch(/deterministic|blocked/);
    expect(requestAi).not.toHaveBeenCalled();
  });

  it("ข้อความว่างไม่เรียก AI", async () => {
    const requestAi = vi.fn();
    await parseVoiceCommandHybrid("   ", { requestAiVoiceIntent: requestAi });
    expect(requestAi).not.toHaveBeenCalled();
  });

  it("ไม่มี client (AI ปิด) = ตกกลับ deterministic ไม่พัง", async () => {
    const outcome = await parseVoiceCommandHybrid("ลาเต้สองแก้วกับอเมริกาโน่ร้อนหนึ่งแก้ว");
    expect(outcome.source).toBe("deterministic");
  });

  it("no_match ที่ไม่ใช่คำต้องห้าม จึงจะเรียก AI", async () => {
    const requestAi = vi.fn().mockResolvedValue({ ok: true, envelope: envelope() });
    const outcome = await parseVoiceCommandHybrid("ลาเต้สองแก้วกับอเมริกาโน่ร้อนหนึ่งแก้ว", {
      requestAiVoiceIntent: requestAi,
    });
    expect(requestAi).toHaveBeenCalledTimes(1);
    expect(outcome.source).toBe("ai");
  });

  it("AI ล้มเหลวทุกชนิด = ไม่มีคำสั่งให้ทำ", async () => {
    for (const reason of ["ai_timeout", "network", "quota_denied", "invalid_response"]) {
      const outcome = await parseVoiceCommandHybrid("ลาเต้สองแก้วกับอเมริกาโน่ร้อนหนึ่งแก้ว", {
        requestAiVoiceIntent: vi.fn().mockResolvedValue({ ok: false, reason }),
      });
      expect(outcome).toEqual({ source: "ai_unavailable", reason });
    }
    expect(AI_UNAVAILABLE_MESSAGE).toContain("ใช้ปุ่ม");
  });
});

describe("ด่านหลังรับคำตอบจาก AI", () => {
  it("วลีที่ AI เสนอต้องผ่าน denylist เดียวกัน", () => {
    const outcome = validateAiProposalAgainstAllowlist(
      envelope({ commands: [{ intent: "pos.add_item", productPhrase: "ส่วนลด 50 บาท", quantity: 1, optionPhrases: [] }] }),
    );
    expect(outcome).toEqual({ source: "blocked", at: "ai_response" });
  });

  it("ตัวเลือกที่เป็นคำต้องห้ามก็ถูก block", () => {
    const outcome = validateAiProposalAgainstAllowlist(
      envelope({
        commands: [{ intent: "pos.add_item", productPhrase: "ลาเต้", quantity: 1, optionPhrases: ["คูปอง"] }],
      }),
    );
    expect(outcome).toEqual({ source: "blocked", at: "ai_response" });
  });

  it("outcome blocked จากโมเดล = block", () => {
    expect(validateAiProposalAgainstAllowlist(envelope({ outcome: "blocked", commands: [], reasonCode: "forbidden" })))
      .toEqual({ source: "blocked", at: "ai_response" });
  });

  it("clarification/unknown = ไม่มีคำสั่งให้ทำ แต่ไม่ใช่ error", () => {
    const outcome = validateAiProposalAgainstAllowlist(
      envelope({ outcome: "clarification", commands: [], reasonCode: "ambiguous" }),
    );
    expect(outcome.source).toBe("ai_no_command");
  });
});

describe("ai intent client", () => {
  const okResponse = (body: unknown, status = 200) =>
    vi.fn().mockResolvedValue({ ok: status < 400, status, json: async () => body } as unknown as Response);

  it("ส่ง origin/locale/requestId และอ่าน envelope กลับมา", async () => {
    const fetchImpl = okResponse({ ok: true, intent: envelope() });
    const result = await requestAiVoiceIntent({
      transcript: "ขอลาเต้",
      requestId: "voice-abc12345",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.ok).toBe(true);
    const body = JSON.parse((fetchImpl.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toMatchObject({ requestId: "voice-abc12345", origin: "push_to_talk", locale: "th-TH" });
  });

  it("คำตอบที่ไม่ผ่าน schema ถูกปฏิเสธแม้ API บอกว่า ok", async () => {
    const fetchImpl = okResponse({ ok: true, intent: { version: 1, outcome: "command_batch" } });
    const result = await requestAiVoiceIntent({
      transcript: "ขอลาเต้",
      requestId: "voice-abc12345",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result).toEqual({ ok: false, reason: "invalid_response" });
  });

  it("สถานะ error ส่ง reason ของ server กลับมา", async () => {
    const fetchImpl = okResponse({ ok: false, reason: "quota_denied" }, 429);
    const result = await requestAiVoiceIntent({
      transcript: "ขอลาเต้",
      requestId: "voice-abc12345",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result).toEqual({ ok: false, reason: "quota_denied" });
  });

  it("ยกเลิกระหว่างทางไม่ถือเป็นความผิดพลาดที่ต้องแจ้งผู้ใช้", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(Object.assign(new Error("abort"), { name: "AbortError" }));
    const result = await requestAiVoiceIntent({
      transcript: "ขอลาเต้",
      requestId: "voice-abc12345",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result).toEqual({ ok: false, reason: "aborted" });
  });

  it("requestId ไม่ซ้ำกันในแต่ละรอบพูด", () => {
    expect(createVoiceRequestId()).not.toBe(createVoiceRequestId());
    expect(createVoiceRequestId().length).toBeLessThanOrEqual(64);
    expect(createVoiceRequestId().length).toBeGreaterThanOrEqual(8);
  });
});
