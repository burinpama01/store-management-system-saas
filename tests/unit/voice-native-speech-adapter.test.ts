import { describe, expect, it, vi } from "vitest";
import {
  createNativeSpeechAdapter,
  getNativeSpeechPlugin,
  mapNativeSpeechError,
  type NativeSpeechPluginLike,
} from "@/modules/voice-pos/native-speech-adapter";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function plugin(overrides: Partial<NativeSpeechPluginLike> = {}): NativeSpeechPluginLike {
  return {
    requestPermissions: vi.fn(async () => ({ speechRecognition: "granted" })),
    start: vi.fn(async () => ({ status: "success", matches: ["เพิ่มลาเต้ สองแก้ว"] })),
    stop: vi.fn(async () => {}),
    ...overrides,
  };
}

function handlers() {
  return { onState: vi.fn(), onFinal: vi.fn(), onError: vi.fn() };
}

describe("native speech adapter (Android app)", () => {
  it("delivers the final transcript in Thai and returns to idle", async () => {
    const p = plugin();
    const h = handlers();
    createNativeSpeechAdapter(p, { locale: "th-TH", timeoutMs: 0 }).start(h);
    await flush();
    expect(p.start).toHaveBeenCalledWith({ language: "th-TH", maxResults: 1, partialResults: false, popup: false });
    expect(h.onFinal).toHaveBeenCalledWith("เพิ่มลาเต้ สองแก้ว", null);
    expect(h.onState.mock.calls.map((c) => c[0])).toEqual(["requesting", "listening", "resolving", "success", "idle"]);
  });

  it("maps a denied microphone permission and never starts listening", async () => {
    const p = plugin({ requestPermissions: vi.fn(async () => ({ speechRecognition: "denied" })) });
    const h = handlers();
    createNativeSpeechAdapter(p, { locale: "th-TH", timeoutMs: 0 }).start(h);
    await flush();
    expect(p.start).not.toHaveBeenCalled();
    expect(h.onError).toHaveBeenCalledWith("permission_denied");
    expect(h.onState).toHaveBeenLastCalledWith("idle");
  });

  it("maps engine errors and empty results to recoverable codes", async () => {
    const h = handlers();
    createNativeSpeechAdapter(plugin({ start: vi.fn(async () => { throw new Error("No match"); }) }), { locale: "th-TH", timeoutMs: 0 }).start(h);
    await flush();
    expect(h.onError).toHaveBeenCalledWith("no_speech");

    const h2 = handlers();
    createNativeSpeechAdapter(plugin({ start: vi.fn(async () => ({ matches: [] })) }), { locale: "th-TH", timeoutMs: 0 }).start(h2);
    await flush();
    expect(h2.onError).toHaveBeenCalledWith("no_speech");
    expect(mapNativeSpeechError("Network timeout")).toBe("network");
    expect(mapNativeSpeechError("Missing permission")).toBe("permission_denied");
  });

  it("keeps one active session and cancel drops the result", async () => {
    let resolveStart: (v: { matches: string[] }) => void = () => {};
    const p = plugin({ start: vi.fn(() => new Promise<{ matches: string[] }>((r) => { resolveStart = r; })) });
    const adapter = createNativeSpeechAdapter(p, { locale: "th-TH", timeoutMs: 0 });
    const h = handlers();
    const session = adapter.start(h);
    expect(adapter.start(handlers())).toBe(session);
    await flush();
    session.cancel();
    resolveStart({ matches: ["ข้อความ"] });
    await flush();
    expect(p.stop).toHaveBeenCalled();
    expect(h.onFinal).not.toHaveBeenCalled();
    expect(h.onState).toHaveBeenLastCalledWith("idle");
  });

  it("is only picked up inside the native app", () => {
    const p = plugin();
    expect(getNativeSpeechPlugin({ Capacitor: { isNativePlatform: () => true, Plugins: { SpeechRecognition: p } } })).toBe(p);
    expect(getNativeSpeechPlugin({ Capacitor: { isNativePlatform: () => false, Plugins: { SpeechRecognition: p } } })).toBeNull();
    expect(getNativeSpeechPlugin({})).toBeNull();
  });
});
