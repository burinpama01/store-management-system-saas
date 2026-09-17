import { describe, expect, it } from "vitest";
import { parseRealtimeEvent } from "@/modules/ai-assistant/ui/live-webrtc";

// PR3-Live (M5) — แปลง event ดิบของ OpenAI Realtime เป็นสัญญาณของ live core (pure):
// รู้จัก = แปลงตรงรูป, ไม่รู้จัก/รูปทรงเพี้ยน = null (เมินเงียบ ๆ ไม่เดา)
// รูปทรงอ้างอิงจาก PoC จริง (artifacts/realtime-tool-poc.log — GA family, gpt-realtime-2.1-mini)

describe("parseRealtimeEvent", () => {
  it("maps the events the live core needs", () => {
    expect(parseRealtimeEvent({ type: "input_audio_buffer.speech_started" })).toEqual({ kind: "user_speech_started" });
    expect(parseRealtimeEvent({ type: "response.done" })).toEqual({ kind: "assistant_response_done" });
    expect(parseRealtimeEvent({ type: "error" })).toEqual({ kind: "error" });
  });

  it("extracts function_call items with the raw args text (core เป็นคน parse เสมอ)", () => {
    expect(
      parseRealtimeEvent({
        type: "response.output_item.done",
        item: { type: "function_call", call_id: "call_ABzDSbLENKV0tdW6", name: "pos.add_item", arguments: '{"productPhrase":"ลาเต้","quantity":2}' },
      }),
    ).toEqual({
      kind: "function_call",
      callId: "call_ABzDSbLENKV0tdW6",
      tool: "pos.add_item",
      argsText: '{"productPhrase":"ลาเต้","quantity":2}',
    });
  });

  it("ignores non-function items, session events, malformed payloads, and unknown types", () => {
    // session.created ไม่ใช้ทริกเกอร์ onOpen (onOpen มาจาก data channel เปิดจริง — กันข้อความซ้ำสองรอบ)
    expect(parseRealtimeEvent({ type: "session.created" })).toBeNull();
    expect(parseRealtimeEvent({ type: "response.output_item.done", item: { type: "message" } })).toBeNull();
    expect(parseRealtimeEvent({ type: "response.output_item.done" })).toBeNull();
    expect(parseRealtimeEvent({ type: "response.output_item.done", item: { type: "function_call" } })).toBeNull();
    expect(parseRealtimeEvent({ type: "rate_limits.updated" })).toBeNull();
    expect(parseRealtimeEvent("not an object")).toBeNull();
    expect(parseRealtimeEvent(null)).toBeNull();
    expect(parseRealtimeEvent(undefined)).toBeNull();
  });

  it("function_call ที่ arguments ไม่ใช่ string = ส่งค่าว่างให้ core fail closed แบบ typed (invalid_args)", () => {
    expect(
      parseRealtimeEvent({
        type: "response.output_item.done",
        item: { type: "function_call", call_id: "call_badargs1", name: "pos.add_item", arguments: 7 },
      }),
    ).toEqual({ kind: "function_call", callId: "call_badargs1", tool: "pos.add_item", argsText: "" });
  });
});
