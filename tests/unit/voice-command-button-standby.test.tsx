// @vitest-environment jsdom
// W5 — ปุ่มเสียงเมื่อถูกปลุกจาก StoreOS Launcher (Windows)
// ⚠️ ต้องมี header jsdom ทุกครั้ง — static-import @testing-library/* บน node env คือ hang จน timeout
import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import "../setup/react";

import { VoiceCommandButton } from "@/shared/components/VoiceCommandButton";
import type {
  VoiceSpeechAdapter,
  VoiceSpeechHandlers,
} from "@/modules/voice-pos/speech-adapter";
import type { StandbyBridgeEvent, VoiceHostHealth } from "@/modules/voice-pos/standby-contract";
import type { WindowsVoiceHostAdapter } from "@/modules/voice-pos/windows-host";

function createFakeAdapter(supported = true) {
  let handlers: VoiceSpeechHandlers | null = null;
  let active = false;
  let starts = 0;

  const adapter: VoiceSpeechAdapter = {
    isSupported: () => supported,
    start: (h) => {
      starts += 1;
      handlers = h;
      if (!supported) {
        h.onError("unsupported_browser");
        return { isActive: () => false, stop: () => {}, cancel: () => {} };
      }
      active = true;
      h.onState?.("listening");
      return {
        isActive: () => active,
        stop: () => {},
        cancel: () => {
          active = false;
        },
      };
    },
  };

  return {
    adapter,
    get starts() {
      return starts;
    },
    finish(transcript: string) {
      handlers?.onFinal(transcript, 0.9);
    },
    fail(code: Parameters<VoiceSpeechHandlers["onError"]>[0]) {
      handlers?.onError(code);
    },
  };
}

/** host ปลอมที่ยิงคำปลุกได้จากเทสต์ */
function createFakeHost(available = true) {
  const listeners = new Set<(event: StandbyBridgeEvent) => void>();
  const healthListeners = new Set<(health: VoiceHostHealth) => void>();
  const calls: string[] = [];

  const host: WindowsVoiceHostAdapter = {
    available,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    subscribeHealth: (listener) => {
      healthListeners.add(listener);
      return () => healthListeners.delete(listener);
    },
    requestHealth: () => calls.push("requestHealth"),
    commandStarted: (sessionId) => calls.push(`started:${sessionId}`),
    commandExtended: (sessionId) => calls.push(`extended:${sessionId}`),
    commandEnded: (sessionId, outcome) => calls.push(`ended:${sessionId}:${outcome}`),
    dispose: () => listeners.clear(),
  };

  return {
    host,
    calls,
    listenerCount: () => listeners.size,
    emitHealth: (health: VoiceHostHealth) => healthListeners.forEach((listener) => listener(health)),
    wake: (sessionId = "sess000001") =>
      listeners.forEach((listener) =>
        listener({ kind: "start-listening", sessionId, phraseId: "sawatdee_os" }),
      ),
    fallback: (reason = "watchdog_timeout") =>
      listeners.forEach((listener) =>
        listener({ kind: "show-push-to-talk", sessionId: "sess000001", reason }),
      ),
  };
}

const silentFeedback = { cue: vi.fn(), speak: vi.fn(), stop: vi.fn() };

describe("VoiceCommandButton — ถูกปลุกจาก Launcher", () => {
  it("คำปลุกเปิดไมค์ให้เองและรายงานกลับว่าเริ่มฟังแล้ว", () => {
    const speech = createFakeAdapter();
    const host = createFakeHost();
    render(
      <VoiceCommandButton adapter={speech.adapter} standbyHost={host.host} feedback={silentFeedback} />,
    );

    act(() => host.wake());

    expect(speech.starts).toBe(1);
    expect(host.calls).toEqual(["started:sess000001"]);
  });

  it("พูดจบแล้วคืนไมค์ให้ Launcher เสมอ", async () => {
    const speech = createFakeAdapter();
    const host = createFakeHost();
    render(
      <VoiceCommandButton adapter={speech.adapter} standbyHost={host.host} feedback={silentFeedback} />,
    );
    act(() => host.wake());

    await act(async () => {
      speech.finish("เพิ่มกาแฟเย็นสองแก้ว");
    });

    expect(host.calls).toEqual(["started:sess000001", "ended:sess000001:completed"]);
  });

  it("ยังคุยต่อในรอบเดิม = ขอต่อเวลา ไม่ใช่คืนไมค์", async () => {
    const speech = createFakeAdapter();
    const host = createFakeHost();
    render(
      <VoiceCommandButton
        adapter={speech.adapter}
        standbyHost={host.host}
        feedback={silentFeedback}
        onResult={() => ({ message: "ยังต้องเลือกขนาด", listenAgain: true })}
      />,
    );
    act(() => host.wake());

    await act(async () => {
      speech.finish("เพิ่มกาแฟเย็น");
    });

    expect(host.calls).toEqual(["started:sess000001", "extended:sess000001"]);
  });

  it("เบราว์เซอร์ไม่ให้เปิดไมค์เอง ต้องบอกให้แตะปุ่ม และคืนไมค์ทันที", async () => {
    const speech = createFakeAdapter();
    const host = createFakeHost();
    render(
      <VoiceCommandButton adapter={speech.adapter} standbyHost={host.host} feedback={silentFeedback} />,
    );
    act(() => host.wake());

    await act(async () => {
      speech.fail("permission_denied");
    });

    expect(host.calls).toEqual(["started:sess000001", "ended:sess000001:tap_required"]);
  });

  it("ปุ่มถูกปิดอยู่ = คืนไมค์ทันที ไม่ปล่อยให้ Launcher รอจนหมดเวลา", () => {
    const speech = createFakeAdapter();
    const host = createFakeHost();
    render(
      <VoiceCommandButton
        adapter={speech.adapter}
        standbyHost={host.host}
        feedback={silentFeedback}
        disabled
      />,
    );

    act(() => host.wake());

    expect(speech.starts).toBe(0);
    expect(host.calls).toEqual(["ended:sess000001:tap_required"]);
    expect(screen.getByText("ตรวจพบคำปลุก — แตะปุ่มไมค์เพื่อพูด")).toBeTruthy();
  });

  it("เบราว์เซอร์ไม่รองรับเสียง = ไม่พยายามเปิดไมค์", () => {
    const speech = createFakeAdapter(false);
    const host = createFakeHost();
    render(
      <VoiceCommandButton adapter={speech.adapter} standbyHost={host.host} feedback={silentFeedback} />,
    );

    act(() => host.wake());

    expect(speech.starts).toBe(0);
    expect(host.calls).toEqual(["ended:sess000001:tap_required"]);
  });

  it("host บอกให้กดพูดเอง = แสดงข้อความ ไม่แอบเปิดไมค์", () => {
    const speech = createFakeAdapter();
    const host = createFakeHost();
    render(
      <VoiceCommandButton adapter={speech.adapter} standbyHost={host.host} feedback={silentFeedback} />,
    );

    act(() => host.fallback());

    expect(speech.starts).toBe(0);
    expect(screen.getByText("ตรวจพบคำปลุก — แตะปุ่มไมค์เพื่อพูด")).toBeTruthy();
  });

  it("ไม่มี Launcher = ปุ่มทำงานแบบกดพูดเหมือนเดิม และไม่ subscribe อะไรเลย", () => {
    const speech = createFakeAdapter();
    const host = createFakeHost(false);
    render(
      <VoiceCommandButton adapter={speech.adapter} standbyHost={host.host} feedback={silentFeedback} />,
    );

    expect(host.listenerCount()).toBe(0);
    expect(screen.getByTestId("voice-mic")).toBeTruthy();
  });

  it("แถบสถานะขึ้นเมื่อมี Launcher และหายเมื่อไม่มี", () => {
    const speech = createFakeAdapter();
    const withHost = createFakeHost();
    const view = render(
      <VoiceCommandButton adapter={speech.adapter} standbyHost={withHost.host} feedback={silentFeedback} />,
    );
    expect(screen.getByTestId("voice-standby-status").textContent).toContain("พร้อมรับคำปลุก");

    view.unmount();
    render(<VoiceCommandButton adapter={speech.adapter} feedback={silentFeedback} />);

    expect(screen.queryByTestId("voice-standby-status")).toBeNull();
  });

  it("พักคำปลุกแล้วคำปลุกต้องไม่เปิดไมค์ และสถานะต้องเปลี่ยน", () => {
    const speech = createFakeAdapter();
    const host = createFakeHost();
    render(
      <VoiceCommandButton adapter={speech.adapter} standbyHost={host.host} feedback={silentFeedback} />,
    );

    act(() => {
      screen.getByTestId("voice-standby-toggle").click();
    });
    act(() => host.wake());

    expect(speech.starts).toBe(0);
    expect(host.calls).toEqual(["ended:sess000001:tap_required"]);
    expect(screen.getByTestId("voice-standby-status").textContent).toContain("สแตนด์บายปิด");
  });

  it("ระหว่างฟังคำสั่ง สถานะต้องเป็น “กำลังฟัง” ไม่ใช่ “พร้อมรับคำปลุก”", () => {
    const speech = createFakeAdapter();
    const host = createFakeHost();
    render(
      <VoiceCommandButton adapter={speech.adapter} standbyHost={host.host} feedback={silentFeedback} />,
    );

    act(() => host.wake());

    expect(screen.getByTestId("voice-standby-status").textContent).toContain("กำลังฟังคำสั่ง");
  });

  it("ถอดคอมโพเนนต์ออกแล้วต้องเลิกรับคำปลุก", () => {
    const speech = createFakeAdapter();
    const host = createFakeHost();
    const view = render(
      <VoiceCommandButton adapter={speech.adapter} standbyHost={host.host} feedback={silentFeedback} />,
    );

    expect(host.listenerCount()).toBe(1);
    view.unmount();

    expect(host.listenerCount()).toBe(0);
  });
});
