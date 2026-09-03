// U23 — เสียงตอบรับ: ต้องเล่นได้ ปิดได้ และห้ามพูดคำพูดดิบของผู้ใช้
import { describe, expect, it, vi } from "vitest";
import {
  createBrowserVoiceFeedback,
  type SpeechUtteranceLike,
  type VoiceFeedbackWindowLike,
} from "@/modules/voice-pos/feedback";
import {
  readVoiceFeedbackPreference,
  VOICE_FEEDBACK_DEFAULT,
  VOICE_FEEDBACK_STORAGE_KEY,
  writeVoiceFeedbackPreference,
} from "@/modules/voice-pos/feedback-preference";

function fakeWindow() {
  const spoken: SpeechUtteranceLike[] = [];
  const tones: number[] = [];
  let cancelled = 0;

  class FakeUtterance implements SpeechUtteranceLike {
    lang = "";
    rate = 1;
    volume = 1;
    constructor(public text: string) {}
  }

  const win: VoiceFeedbackWindowLike = {
    speechSynthesis: {
      speak: (utterance) => spoken.push(utterance),
      cancel: () => {
        cancelled += 1;
      },
    },
    SpeechSynthesisUtterance: FakeUtterance as unknown as new (text: string) => SpeechUtteranceLike,
    AudioContext: class {
      currentTime = 0;
      destination = {};
      createOscillator() {
        return {
          type: "",
          frequency: { value: 0 },
          connect: () => {},
          start: () => {},
          stop: () => {},
        } as never;
      }
      createGain() {
        return { gain: { value: 0 }, connect: () => {} } as never;
      }
    } as never,
  };
  return { win, spoken, tones, cancelledCount: () => cancelled };
}

describe("createBrowserVoiceFeedback", () => {
  it("อ่านข้อความผลลัพธ์เป็นเสียงไทย", () => {
    const { win, spoken } = fakeWindow();
    const feedback = createBrowserVoiceFeedback({ window: win });

    feedback.speak("เพิ่ม ลาเต้ 2 รายการแล้ว");

    expect(spoken).toHaveLength(1);
    expect(spoken[0].text).toBe("เพิ่ม ลาเต้ 2 รายการแล้ว");
    expect(spoken[0].lang).toBe("th-TH");
  });

  it("ปิดเสียงแล้วต้องไม่พูดและไม่มีเสียงเตือน", () => {
    const { win, spoken } = fakeWindow();
    const feedback = createBrowserVoiceFeedback({ window: win, muted: true });

    feedback.cue("success");
    feedback.speak("เพิ่ม ลาเต้ แล้ว");

    expect(spoken).toEqual([]);
  });

  it("ข้อความว่างไม่พูด", () => {
    const { win, spoken } = fakeWindow();
    createBrowserVoiceFeedback({ window: win }).speak("   ");
    expect(spoken).toEqual([]);
  });

  it("พูดใหม่ต้องยกเลิกเสียงเดิมก่อน (ไม่พูดทับกัน)", () => {
    const { win, cancelledCount } = fakeWindow();
    const feedback = createBrowserVoiceFeedback({ window: win });
    feedback.speak("หนึ่ง");
    feedback.speak("สอง");
    expect(cancelledCount()).toBe(2);
  });

  it("เบราว์เซอร์ไม่รองรับ = ไม่พังและไม่ทำอะไร", () => {
    const feedback = createBrowserVoiceFeedback({ window: {} });
    expect(() => {
      feedback.cue("listening");
      feedback.speak("ทดสอบ");
      feedback.stop();
    }).not.toThrow();
  });

  it("เสียงพังไม่ทำให้คำสั่งหลักพัง", () => {
    const win: VoiceFeedbackWindowLike = {
      speechSynthesis: {
        speak: () => {
          throw new Error("synth ล่ม");
        },
        cancel: () => {},
      },
      SpeechSynthesisUtterance: class {
        lang = "";
        rate = 1;
        volume = 1;
        constructor(public text: string) {}
      } as unknown as new (text: string) => SpeechUtteranceLike,
    };
    expect(() => createBrowserVoiceFeedback({ window: win }).speak("ทดสอบ")).not.toThrow();
  });
});

describe("ตัวเลือกเปิด/ปิดเสียงต่อเครื่อง", () => {
  it("ค่าเริ่มต้นคือเปิดเสียง", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    });
    expect(readVoiceFeedbackPreference()).toBe(VOICE_FEEDBACK_DEFAULT);

    writeVoiceFeedbackPreference(false);
    expect(store.get(VOICE_FEEDBACK_STORAGE_KEY)).toBe("0");
    expect(readVoiceFeedbackPreference()).toBe(false);

    writeVoiceFeedbackPreference(true);
    expect(store.get(VOICE_FEEDBACK_STORAGE_KEY)).toBe("1");
    expect(readVoiceFeedbackPreference()).toBe(true);
    vi.unstubAllGlobals();
  });

  it("storage ถูกบล็อก (โหมดส่วนตัว) ต้องไม่พังและใช้ค่าเริ่มต้น", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    });
    expect(readVoiceFeedbackPreference()).toBe(VOICE_FEEDBACK_DEFAULT);
    expect(() => writeVoiceFeedbackPreference(false)).not.toThrow();
    vi.unstubAllGlobals();
  });
});
