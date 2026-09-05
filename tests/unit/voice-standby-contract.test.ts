import { describe, expect, it, vi } from "vitest";

import {
  STANDBY_CONTRACT_VERSION,
  STANDBY_MESSAGE_TYPES,
  StandbyBridge,
  parseStandbyMessage,
  type StandbyOutboundMessage,
} from "@/modules/voice-pos/standby-contract";

function wakeMessage(overrides: Record<string, unknown> = {}) {
  return {
    v: STANDBY_CONTRACT_VERSION,
    type: STANDBY_MESSAGE_TYPES.wakeDetected,
    seq: 1,
    sessionId: "abc123def456",
    at: "2026-09-06T10:00:00+07:00",
    phraseId: "sawatdee_os",
    confidence: 0.91,
    ...overrides,
  };
}

describe("standby contract — ข้อความจาก native host", () => {
  it("รับข้อความที่ถูกรูปทรง", () => {
    const parsed = parseStandbyMessage(wakeMessage());

    expect(parsed).not.toBeNull();
    expect(parsed!.phraseId).toBe("sawatdee_os");
    expect(parsed!.confidence).toBe(0.91);
  });

  it("ทิ้งข้อความคนละเวอร์ชันของสัญญา", () => {
    expect(parseStandbyMessage(wakeMessage({ v: 2 }))).toBeNull();
  });

  it("ทิ้ง wake ที่ไม่มีรหัสคำปลุกที่รู้จัก", () => {
    expect(parseStandbyMessage(wakeMessage({ phraseId: "open_cash_drawer" }))).toBeNull();
    expect(parseStandbyMessage(wakeMessage({ phraseId: undefined }))).toBeNull();
  });

  it("ตัดฟิลด์แปลกปลอมทิ้งทั้งหมด — native สั่งงานผ่านสัญญานี้ไม่ได้", () => {
    const parsed = parseStandbyMessage(
      wakeMessage({
        intent: { action: "checkout", amount: 999 },
        transcript: "ชำระเงินหนึ่งพันบาท",
        command: "void_last_order",
      }),
    );

    expect(parsed).not.toBeNull();
    expect(Object.keys(parsed!).sort()).toEqual(
      ["at", "confidence", "phraseId", "reason", "seq", "sessionId", "type", "v"].sort(),
    );
  });

  it("ทิ้งข้อความที่ sessionId หรือเวลาใช้ไม่ได้", () => {
    expect(parseStandbyMessage(wakeMessage({ sessionId: "x" }))).toBeNull();
    expect(parseStandbyMessage(wakeMessage({ at: "เมื่อกี้" }))).toBeNull();
    expect(parseStandbyMessage(null)).toBeNull();
    expect(parseStandbyMessage("wake.detected")).toBeNull();
  });

  it("ความมั่นใจนอกช่วง 0-1 ถือว่าไม่มีค่า ไม่ใช่ค่าที่เชื่อได้", () => {
    expect(parseStandbyMessage(wakeMessage({ confidence: 12 }))!.confidence).toBeNull();
  });
});

describe("StandbyBridge — ฝั่งเว็บ", () => {
  function setup(canStart = true) {
    const sent: StandbyOutboundMessage[] = [];
    const bridge = new StandbyBridge({
      send: (message) => sent.push(message),
      canStartListening: () => canStart,
    });
    return { bridge, sent };
  }

  it("ได้ยินคำปลุกแล้วสั่งให้เริ่มฟัง", () => {
    const { bridge } = setup();

    const event = bridge.handle(wakeMessage());

    expect(event).toEqual({ kind: "start-listening", sessionId: "abc123def456", phraseId: "sawatdee_os" });
  });

  it("เบราว์เซอร์ไม่ยอมให้เปิดไมค์เอง ต้องให้ผู้ใช้แตะ ไม่ใช่แอบเปิด", () => {
    const { bridge, sent } = setup(false);

    const event = bridge.handle(wakeMessage());

    expect(event).toEqual({
      kind: "show-push-to-talk",
      sessionId: "abc123def456",
      reason: "user_activation_required",
    });
    expect(sent).toHaveLength(0);
  });

  it("ข้อความซ้ำหรือย้อนหลังถูกทิ้ง", () => {
    const { bridge } = setup();
    bridge.handle(wakeMessage({ seq: 5 }));

    expect(bridge.handle(wakeMessage({ seq: 5, sessionId: "zzz999zzz999" }))).toEqual({
      kind: "ignored",
      reason: "stale_seq",
    });
    expect(bridge.handle(wakeMessage({ seq: 3, sessionId: "zzz999zzz999" }))).toEqual({
      kind: "ignored",
      reason: "stale_seq",
    });
  });

  it("ปลุกซ้อนระหว่างที่ยังฟังอยู่ถูกทิ้ง", () => {
    const { bridge } = setup();
    bridge.handle(wakeMessage({ seq: 1 }));

    expect(bridge.handle(wakeMessage({ seq: 2, sessionId: "second000001" }))).toEqual({
      kind: "ignored",
      reason: "already_listening",
    });
  });

  it("รายงาน lifecycle กลับ native ครบสามจังหวะ", () => {
    const { bridge, sent } = setup();
    bridge.handle(wakeMessage());

    bridge.notifyListeningStarted("abc123def456");
    bridge.notifyTurnContinued("abc123def456");
    bridge.notifyListeningEnded("abc123def456");

    expect(sent.map((m) => m.type)).toEqual([
      STANDBY_MESSAGE_TYPES.sessionStarted,
      STANDBY_MESSAGE_TYPES.sessionExtended,
      STANDBY_MESSAGE_TYPES.sessionEnded,
    ]);
    expect(sent.map((m) => m.seq)).toEqual([1, 2, 3]);
    expect(sent.at(-1)!.reason).toBe("completed");
  });

  it("ไม่รายงาน lifecycle ของ session ที่ไม่ได้ถืออยู่", () => {
    const { bridge, sent } = setup();
    bridge.handle(wakeMessage());

    bridge.notifyListeningStarted("othersession");

    expect(sent).toHaveLength(0);
  });

  it("จบรอบแล้วปลุกใหม่ได้", () => {
    const { bridge } = setup();
    bridge.handle(wakeMessage({ seq: 1 }));
    bridge.notifyListeningEnded("abc123def456");

    expect(bridge.handle(wakeMessage({ seq: 2, sessionId: "second000001" }))).toMatchObject({
      kind: "start-listening",
    });
  });

  it("native แจ้ง fallback แล้วเว็บต้องปลดสถานะฟังและโชว์ปุ่มกดพูด", () => {
    const { bridge } = setup();
    bridge.handle(wakeMessage({ seq: 1 }));

    const event = bridge.handle({
      v: STANDBY_CONTRACT_VERSION,
      type: STANDBY_MESSAGE_TYPES.wakeFallback,
      seq: 2,
      sessionId: "abc123def456",
      at: "2026-09-06T10:00:02+07:00",
      reason: "watchdog_timeout",
    });

    expect(event).toEqual({
      kind: "show-push-to-talk",
      sessionId: "abc123def456",
      reason: "watchdog_timeout",
    });
    expect(bridge.listeningSessionId).toBeNull();
  });

  it("ไม่เรียกฟังก์ชันเปิดไมค์เองเมื่อข้อความใช้ไม่ได้", () => {
    const canStart = vi.fn(() => true);
    const bridge = new StandbyBridge({ send: () => {}, canStartListening: canStart });

    bridge.handle({ v: 1, type: "wake.detected", seq: 1 });

    expect(canStart).not.toHaveBeenCalled();
  });
});
