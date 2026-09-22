import { describe, expect, it, vi } from "vitest";
import { createNativeSpeechSynthesis, installNativeSpeechSynthesis } from "@/shared/notifications/native-speech-synthesis";
import { pickThaiVoice, speakAnnouncement } from "@/shared/notifications/announce";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function plugin(languages = ["th-TH", "en-US"]) {
  return {
    speak: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    getSupportedLanguages: vi.fn(async () => ({ languages })),
  };
}

describe("native speechSynthesis polyfill (Android app)", () => {
  it("speaks through the device TTS and fires onend", async () => {
    const p = plugin();
    const { synth, Utterance } = createNativeSpeechSynthesis(p);
    const u = new Utterance("เพิ่มลาเต้สองแก้วแล้ว");
    u.lang = "th-TH";
    u.rate = 1.1;
    const onend = vi.fn();
    u.onend = onend;
    synth.speak(u);
    await flush();
    expect(p.speak).toHaveBeenCalledWith({ text: "เพิ่มลาเต้สองแก้วแล้ว", lang: "th-TH", rate: 1.1, pitch: 1, volume: 1, queueStrategy: 0 });
    expect(onend).toHaveBeenCalledTimes(1);
  });

  it("exposes Thai voices only when the device supports Thai, so announce keeps its beep rule", async () => {
    const withThai = createNativeSpeechSynthesis(plugin());
    const listener = vi.fn();
    withThai.synth.addEventListener("voiceschanged", listener);
    await withThai.loadVoices();
    expect(listener).toHaveBeenCalled();
    expect(pickThaiVoice(withThai.synth.getVoices())?.lang).toBe("th-TH");

    const noThai = createNativeSpeechSynthesis(plugin(["en-US"]));
    await noThai.loadVoices();
    expect(speakAnnouncement("ออเดอร์ใหม่", { window: { speechSynthesis: noThai.synth, SpeechSynthesisUtterance: noThai.Utterance } })).toBe(false);
    const thai = { speechSynthesis: withThai.synth, SpeechSynthesisUtterance: withThai.Utterance };
    expect(speakAnnouncement("ออเดอร์ใหม่", { window: thai })).toBe(true);
  });

  it("cancel stops native speech and a cancelled utterance never reports onend", async () => {
    let finish: () => void = () => {};
    const p = { ...plugin(), speak: vi.fn(() => new Promise<void>((r) => { finish = r; })) };
    const { synth, Utterance } = createNativeSpeechSynthesis(p);
    const u = new Utterance("ข้อความ");
    u.onend = vi.fn();
    synth.speak(u);
    synth.cancel();
    finish();
    await flush();
    expect(p.stop).toHaveBeenCalled();
    expect(u.onend).not.toHaveBeenCalled();
  });

  it("installs only inside the native app and never over a real speechSynthesis", () => {
    expect(installNativeSpeechSynthesis({})).toBe(false);
    const real = { speak: vi.fn() };
    const withReal = { Capacitor: { isNativePlatform: () => true, Plugins: { TextToSpeech: plugin() } }, speechSynthesis: real };
    expect(installNativeSpeechSynthesis(withReal)).toBe(false);
    expect(withReal.speechSynthesis).toBe(real);
    const app: Record<string, unknown> = { Capacitor: { isNativePlatform: () => true, Plugins: { TextToSpeech: plugin() } } };
    expect(installNativeSpeechSynthesis(app)).toBe(true);
    expect(typeof app.SpeechSynthesisUtterance).toBe("function");
  });
});
