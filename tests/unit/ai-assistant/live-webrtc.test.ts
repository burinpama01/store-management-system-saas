import { describe, expect, it } from "vitest";
import { createRemoteAudioSink, parseRealtimeEvent } from "@/modules/ai-assistant/ui/live-webrtc";

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

// PR3-Live (fix) — เสียงตอบของผู้ช่วยมาเป็น remote track ของ WebRTC ซึ่งไม่ดังเอง
// ถ้าไม่มี element เสียงถือ stream ไว้ ระบบจะทำงานถูกทุกอย่างแต่ผู้ใช้ไม่ได้ยินอะไรเลย
describe("createRemoteAudioSink", () => {
  function fakeElement() {
    const calls = { play: 0, pause: 0, remove: 0 };
    const element = {
      autoplay: false,
      srcObject: null as MediaStream | null,
      play: () => {
        calls.play += 1;
        return Promise.resolve();
      },
      pause: () => {
        calls.pause += 1;
      },
      remove: () => {
        calls.remove += 1;
      },
    };
    return { element, calls };
  }

  it("ต่อ stream เข้า element แล้วสั่งเล่นทันที (สร้าง element ครั้งเดียว)", () => {
    const { element, calls } = fakeElement();
    let created = 0;
    const sink = createRemoteAudioSink(() => {
      created += 1;
      return element;
    });
    const stream = { id: "remote" } as unknown as MediaStream;

    sink.attach(stream);
    sink.attach(stream); // event ซ้ำของ provider ต้องไม่สร้าง element ใหม่และไม่สั่งเล่นซ้ำ

    expect(created).toBe(1);
    expect(element.srcObject).toBe(stream);
    expect(calls.play).toBe(1);
  });

  it("play ที่ถูกปฏิเสธ (autoplay policy) ต้องไม่ทำให้เซสชันล้ม", () => {
    const { element } = fakeElement();
    element.play = () => Promise.reject(new Error("NotAllowedError"));

    const sink = createRemoteAudioSink(() => element);

    expect(() => sink.attach({ id: "remote" } as unknown as MediaStream)).not.toThrow();
  });

  it("close ถอดเสียงออกทุกทางและปลอดภัยเมื่อเรียกซ้ำ/ยังไม่เคย attach", () => {
    const { element, calls } = fakeElement();
    const sink = createRemoteAudioSink(() => element);
    sink.attach({ id: "remote" } as unknown as MediaStream);

    sink.close();
    sink.close();

    expect(calls.pause).toBe(1);
    expect(calls.remove).toBe(1);
    expect(element.srcObject).toBeNull();
    // ปิดแล้ว attach ซ้ำต้องไม่ปลุกเสียงกลับมา (เซสชันจบแล้ว)
    sink.attach({ id: "again" } as unknown as MediaStream);
    expect(element.srcObject).toBeNull();

    expect(() => createRemoteAudioSink(() => element).close()).not.toThrow();
  });
});
