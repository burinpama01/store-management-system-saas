// U13 — adapter ของ Web Speech ต้อง "ถอดเปลี่ยนได้" และล้มแบบกู้คืนได้เสมอ
// ทดสอบด้วย fake SpeechRecognition ที่ฉีดผ่าน options.window (ไม่แตะเบราว์เซอร์จริง)
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createBrowserSpeechAdapter,
  mapSpeechErrorCode,
  VOICE_DEFAULT_TIMEOUT_MS,
  type SpeechRecognitionLike,
  type SpeechRecognitionResultEventLike,
  type SpeechRecognitionWindowLike,
} from "@/modules/voice-pos/speech-adapter";
import type { VoiceErrorCode, VoiceRecognitionState } from "@/modules/voice-pos/types";

class FakeRecognition implements SpeechRecognitionLike {
  static instances: FakeRecognition[] = [];

  lang = "";
  continuous = true;
  interimResults = false;
  maxAlternatives = 0;
  started = 0;
  stopped = 0;
  aborted = 0;
  startThrows = false;

  onstart: ((event: unknown) => void) | null = null;
  onresult: ((event: SpeechRecognitionResultEventLike) => void) | null = null;
  onerror: ((event: { error?: string }) => void) | null = null;
  onend: ((event: unknown) => void) | null = null;

  constructor() {
    FakeRecognition.instances.push(this);
  }

  start(): void {
    if (this.startThrows) throw new Error("start failed");
    this.started += 1;
    this.onstart?.({});
  }

  stop(): void {
    this.stopped += 1;
  }

  abort(): void {
    this.aborted += 1;
  }

  /** จำลองผลจาก engine (interim หรือ final) */
  emit(transcript: string, isFinal: boolean, confidence?: number): void {
    const alternative = { transcript, confidence };
    const item = { isFinal, length: 1, 0: alternative };
    this.onresult?.({ resultIndex: 0, results: { length: 1, 0: item } });
  }
}

function makeWindow(): SpeechRecognitionWindowLike {
  return { SpeechRecognition: FakeRecognition as unknown as new () => SpeechRecognitionLike };
}

function collector() {
  const states: VoiceRecognitionState[] = [];
  const finals: Array<{ transcript: string; confidence: number | null }> = [];
  const interims: string[] = [];
  const errors: VoiceErrorCode[] = [];
  return {
    states,
    finals,
    interims,
    errors,
    handlers: {
      onState: (s: VoiceRecognitionState) => states.push(s),
      onInterim: (t: string) => interims.push(t),
      onFinal: (transcript: string, confidence: number | null) => finals.push({ transcript, confidence }),
      onError: (code: VoiceErrorCode) => errors.push(code),
    },
  };
}

beforeEach(() => {
  FakeRecognition.instances = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe("mapSpeechErrorCode", () => {
  it("map ค่าที่รู้จัก และค่าที่ไม่รู้จักเป็น service_error", () => {
    expect(mapSpeechErrorCode("not-allowed")).toBe("permission_denied");
    expect(mapSpeechErrorCode("service-not-allowed")).toBe("permission_denied");
    expect(mapSpeechErrorCode("no-speech")).toBe("no_speech");
    expect(mapSpeechErrorCode("network")).toBe("network");
    expect(mapSpeechErrorCode("aborted")).toBe("aborted");
    expect(mapSpeechErrorCode("something-new")).toBe("service_error");
    expect(mapSpeechErrorCode(undefined)).toBe("service_error");
  });
});

describe("createBrowserSpeechAdapter — capability detection", () => {
  it("ไม่มี SpeechRecognition = ไม่รองรับ และ start คืน error ที่กู้คืนได้", () => {
    const adapter = createBrowserSpeechAdapter({ window: {} });
    expect(adapter.isSupported()).toBe(false);

    const c = collector();
    const session = adapter.start(c.handlers);
    expect(c.errors).toEqual(["unsupported_browser"]);
    expect(session.isActive()).toBe(false);
    expect(FakeRecognition.instances).toHaveLength(0);
  });

  it("รองรับ webkitSpeechRecognition ด้วย", () => {
    const adapter = createBrowserSpeechAdapter({
      window: { webkitSpeechRecognition: FakeRecognition as unknown as new () => SpeechRecognitionLike },
    });
    expect(adapter.isSupported()).toBe(true);
  });
});

describe("createBrowserSpeechAdapter — push-to-talk session", () => {
  it("ตั้งค่า th-TH, continuous=false, interimResults=true ต่อ 1 session", () => {
    const adapter = createBrowserSpeechAdapter({ window: makeWindow() });
    const c = collector();
    adapter.start(c.handlers);

    const rec = FakeRecognition.instances[0];
    expect(rec.lang).toBe("th-TH");
    expect(rec.continuous).toBe(false);
    expect(rec.interimResults).toBe(true);
    expect(rec.started).toBe(1);
    expect(c.states).toEqual(["requesting", "listening"]);
  });

  it("ส่งเฉพาะ final transcript เข้า onFinal — interim ไปช่องแสดงผลเท่านั้น", () => {
    const adapter = createBrowserSpeechAdapter({ window: makeWindow() });
    const c = collector();
    adapter.start(c.handlers);
    const rec = FakeRecognition.instances[0];

    rec.emit("เพิ่มลา", false);
    expect(c.finals).toHaveLength(0);
    expect(c.interims).toEqual(["เพิ่มลา"]);

    rec.emit("เพิ่มลาเต้ 2 แก้ว", true, 0.9);
    expect(c.finals).toEqual([{ transcript: "เพิ่มลาเต้ 2 แก้ว", confidence: 0.9 }]);
    expect(c.states).toEqual(["requesting", "listening", "resolving", "success", "idle"]);
  });

  it("confidence ที่ engine ไม่ส่งมา = null (ไม่เดาค่าแทน)", () => {
    const adapter = createBrowserSpeechAdapter({ window: makeWindow() });
    const c = collector();
    adapter.start(c.handlers);
    FakeRecognition.instances[0].emit("เปิดรายงาน", true);
    expect(c.finals).toEqual([{ transcript: "เปิดรายงาน", confidence: null }]);
  });

  it("มี active session ได้ครั้งละ 1 — กดซ้ำระหว่างฟังไม่เปิด recognition ใหม่", () => {
    const adapter = createBrowserSpeechAdapter({ window: makeWindow() });
    const c = collector();
    const first = adapter.start(c.handlers);
    const second = adapter.start(c.handlers);

    expect(second).toBe(first);
    expect(FakeRecognition.instances).toHaveLength(1);
  });

  it("จบ session แล้วเริ่มใหม่ได้ (recognition ตัวใหม่)", () => {
    const adapter = createBrowserSpeechAdapter({ window: makeWindow() });
    const c = collector();
    adapter.start(c.handlers);
    FakeRecognition.instances[0].emit("เปิดรายงาน", true, 0.9);

    adapter.start(c.handlers);
    expect(FakeRecognition.instances).toHaveLength(2);
  });

  it("cancel = abort และไม่มี final ส่งกลับ", () => {
    const adapter = createBrowserSpeechAdapter({ window: makeWindow() });
    const c = collector();
    const session = adapter.start(c.handlers);
    session.cancel();

    expect(FakeRecognition.instances[0].aborted).toBe(1);
    expect(session.isActive()).toBe(false);
    expect(c.finals).toHaveLength(0);
    expect(c.states.at(-1)).toBe("idle");
  });

  it("stop ขอให้ engine สรุปผล โดยยังไม่ปิด session เอง", () => {
    const adapter = createBrowserSpeechAdapter({ window: makeWindow() });
    const c = collector();
    const session = adapter.start(c.handlers);
    session.stop();

    expect(FakeRecognition.instances[0].stopped).toBe(1);
    expect(session.isActive()).toBe(true);
  });
});

describe("createBrowserSpeechAdapter — สถานะที่กู้คืนได้", () => {
  it("ปฏิเสธไมโครโฟน → permission_denied และกลับ idle", () => {
    const adapter = createBrowserSpeechAdapter({ window: makeWindow() });
    const c = collector();
    const session = adapter.start(c.handlers);
    FakeRecognition.instances[0].onerror?.({ error: "not-allowed" });

    expect(c.errors).toEqual(["permission_denied"]);
    expect(session.isActive()).toBe(false);
    expect(c.states.at(-1)).toBe("idle");
  });

  it("ออฟไลน์ → network", () => {
    const adapter = createBrowserSpeechAdapter({ window: makeWindow() });
    const c = collector();
    adapter.start(c.handlers);
    FakeRecognition.instances[0].onerror?.({ error: "network" });
    expect(c.errors).toEqual(["network"]);
  });

  it("จบโดยไม่มีผล (abort จากภายนอก) → aborted ครั้งเดียว", () => {
    const adapter = createBrowserSpeechAdapter({ window: makeWindow() });
    const c = collector();
    adapter.start(c.handlers);
    const rec = FakeRecognition.instances[0];
    rec.onend?.({});
    rec.onend?.({});

    expect(c.errors).toEqual(["aborted"]);
  });

  it("ได้ final แล้ว onend ตามมา ต้องไม่รายงาน error", () => {
    const adapter = createBrowserSpeechAdapter({ window: makeWindow() });
    const c = collector();
    adapter.start(c.handlers);
    const rec = FakeRecognition.instances[0];
    rec.emit("เปิดรายงาน", true, 0.9);
    rec.onend?.({});

    expect(c.errors).toEqual([]);
  });

  it("ฟังนานเกินกำหนด → abort + timeout", () => {
    vi.useFakeTimers();
    const adapter = createBrowserSpeechAdapter({ window: makeWindow() });
    const c = collector();
    const session = adapter.start(c.handlers);

    vi.advanceTimersByTime(VOICE_DEFAULT_TIMEOUT_MS + 1);

    expect(FakeRecognition.instances[0].aborted).toBe(1);
    expect(c.errors).toEqual(["timeout"]);
    expect(session.isActive()).toBe(false);
  });

  it("ได้ final ทันเวลา → ไม่มี timeout ยิงตามมา", () => {
    vi.useFakeTimers();
    const adapter = createBrowserSpeechAdapter({ window: makeWindow() });
    const c = collector();
    adapter.start(c.handlers);
    FakeRecognition.instances[0].emit("เปิดรายงาน", true, 0.9);

    vi.advanceTimersByTime(VOICE_DEFAULT_TIMEOUT_MS * 2);
    expect(c.errors).toEqual([]);
  });

  it("engine โยน exception ตอน start → service_error ไม่ throw ออกมา", () => {
    const adapter = createBrowserSpeechAdapter({
      window: {
        SpeechRecognition: class extends FakeRecognition {
          constructor() {
            super();
            this.startThrows = true;
          }
        } as unknown as new () => SpeechRecognitionLike,
      },
    });
    const c = collector();
    const session = adapter.start(c.handlers);

    expect(c.errors).toEqual(["service_error"]);
    expect(session.isActive()).toBe(false);
  });
});
