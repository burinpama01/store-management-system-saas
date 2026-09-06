// @vitest-environment jsdom
// W8 — สถานะของเครื่องบนหน้าตั้งค่า + คำแนะนำวิธีแก้
// ⚠️ ต้องมี header jsdom ทุกครั้ง — static-import @testing-library/* บน node env คือ hang จน timeout
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import "../setup/react";

import {
  STANDBY_CONTRACT_VERSION,
  STANDBY_MESSAGE_TYPES,
  VOICE_HOST_FAULT_CODES,
  parseHostHealth,
  type VoiceHostHealth,
} from "@/modules/voice-pos/standby-contract";
import { describeHostFault } from "@/modules/voice-pos/host-repair";
import { VoiceStandbyDiagnostics } from "@/shared/components/VoiceStandbyDiagnostics";
import type { WindowsVoiceHostAdapter } from "@/modules/voice-pos/windows-host";

function healthMessage(overrides: Record<string, unknown> = {}) {
  return {
    v: STANDBY_CONTRACT_VERSION,
    type: STANDBY_MESSAGE_TYPES.health,
    seq: 1,
    at: new Date().toISOString(),
    state: "standby",
    hostVersion: "0.2.4",
    recognizer: "MS-1033-80-DESK",
    recognizerCulture: "en-US",
    microphone: "ไมโครโฟนเริ่มต้นของ Windows",
    faultCode: null,
    pronunciationGrammar: true,
    ...overrides,
  };
}

describe("parseHostHealth", () => {
  it("อ่านสถานะปกติได้ครบ", () => {
    const health = parseHostHealth(healthMessage());

    expect(health).toMatchObject({
      state: "standby",
      hostVersion: "0.2.4",
      recognizer: "MS-1033-80-DESK",
      recognizerCulture: "en-US",
      faultCode: null,
    });
  });

  it.each([
    ["คนละเวอร์ชันสัญญา", { v: 2 }],
    ["ชนิดข้อความอื่น", { type: "wake.detected" }],
    ["สถานะที่ไม่รู้จัก", { state: "exploded" }],
  ])("ทิ้งข้อความที่ %s", (_name, overrides) => {
    expect(parseHostHealth(healthMessage(overrides))).toBeNull();
  });

  it("รหัสปัญหาที่ไม่รู้จักถือว่าไม่มีปัญหาระบุ ไม่ใช่เอาข้อความดิบมาแสดง", () => {
    const health = parseHostHealth(healthMessage({ faultCode: "System.IO.FileNotFoundException at C:\\x" }));

    expect(health!.faultCode).toBeNull();
  });

  it("ข้อความยาวผิดปกติถูกตัด ไม่ให้ทำ layout พัง", () => {
    const health = parseHostHealth(healthMessage({ recognizer: "ก".repeat(500) }));

    expect(health!.recognizer!.length).toBe(120);
  });
});

describe("คำแนะนำวิธีแก้", () => {
  it.each(VOICE_HOST_FAULT_CODES)("รหัส %s ต้องมีคำแนะนำที่ทำตามได้", (code) => {
    const guide = describeHostFault(code);

    expect(guide).not.toBeNull();
    expect(guide!.steps.length).toBeGreaterThan(0);
    // ทุกกรณีต้องบอกว่ายังขายของต่อได้ — ฟีเจอร์เสียงพังต้องไม่ทำให้ร้านหยุด
    expect(guide!.fallback.length).toBeGreaterThan(0);
  });

  it("ไม่มีปัญหา = ไม่มีคำแนะนำ", () => {
    expect(describeHostFault(null)).toBeNull();
  });
});

function createFakeHost(available = true) {
  const listeners = new Set<(health: VoiceHostHealth) => void>();
  let requests = 0;
  const host: WindowsVoiceHostAdapter = {
    available,
    subscribe: () => () => {},
    subscribeHealth: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    requestHealth: () => {
      requests += 1;
    },
    commandStarted: () => {},
    commandExtended: () => {},
    commandEnded: () => {},
    dispose: () => listeners.clear(),
  };
  return {
    host,
    get requests() {
      return requests;
    },
    emit: (raw: Record<string, unknown> = {}) => {
      const health = parseHostHealth(healthMessage(raw));
      listeners.forEach((listener) => listener(health!));
    },
  };
}

describe("VoiceStandbyDiagnostics", () => {
  it("เบราว์เซอร์ปกติ = ไม่แสดงการ์ดเปล่า", () => {
    const fake = createFakeHost(false);
    const { container } = render(<VoiceStandbyDiagnostics host={fake.host} />);

    expect(container.firstChild).toBeNull();
  });

  it("เปิดหน้ามาแล้วขอสถานะทันที", () => {
    const fake = createFakeHost();
    render(<VoiceStandbyDiagnostics host={fake.host} />);

    expect(fake.requests).toBe(1);
  });

  it("แสดงเวอร์ชัน ชุดรู้จำเสียง และไมโครโฟน", () => {
    const fake = createFakeHost();
    render(<VoiceStandbyDiagnostics host={fake.host} />);

    act(() => fake.emit());

    const card = screen.getByTestId("voice-standby-diagnostics");
    expect(card.textContent).toContain("0.2.4");
    expect(card.textContent).toContain("MS-1033-80-DESK");
    expect(card.textContent).toContain("ไมโครโฟนเริ่มต้นของ Windows");
    expect(card.textContent).toContain("พร้อมรับคำปลุก");
  });

  it("มีปัญหา = แสดงวิธีแก้เป็นขั้นตอน ไม่ใช่ข้อความ error", () => {
    const fake = createFakeHost();
    render(<VoiceStandbyDiagnostics host={fake.host} />);

    act(() => fake.emit({ state: "degraded", faultCode: "microphone_denied", microphone: null }));

    const repair = screen.getByTestId("voice-standby-repair");
    expect(repair.textContent).toContain("Windows ไม่อนุญาตให้โปรแกรมใช้ไมโครโฟน");
    expect(repair.textContent).toContain("ยังกดปุ่มไมค์เพื่อพูดคำสั่งได้ตามปกติ");
  });

  it("กด “ตรวจอีกครั้ง” แล้วขอสถานะใหม่", () => {
    const fake = createFakeHost();
    render(<VoiceStandbyDiagnostics host={fake.host} />);

    fireEvent.click(screen.getByTestId("voice-standby-recheck"));

    expect(fake.requests).toBe(2);
    expect(screen.getByTestId("voice-standby-recheck").textContent).toBe("กำลังตรวจ…");
  });

  it("ได้สถานะใหม่แล้วปุ่มกลับมาพร้อมกดอีกครั้ง", () => {
    const fake = createFakeHost();
    render(<VoiceStandbyDiagnostics host={fake.host} />);
    fireEvent.click(screen.getByTestId("voice-standby-recheck"));

    act(() => fake.emit());

    expect(screen.getByTestId("voice-standby-recheck").textContent).toBe("ตรวจอีกครั้ง");
  });

  it("บอกชัดว่าเป็นค่าเฉพาะเครื่องนี้ ไม่กระทบเครื่องอื่น", () => {
    const fake = createFakeHost();
    render(<VoiceStandbyDiagnostics host={fake.host} />);

    expect(screen.getByTestId("voice-standby-diagnostics").textContent).toContain("เฉพาะของเครื่องนี้");
  });

  it("เลิกรับสถานะเมื่อถอดคอมโพเนนต์", () => {
    const fake = createFakeHost();
    const unsubscribe = vi.fn();
    const host = { ...fake.host, subscribeHealth: () => unsubscribe };
    const view = render(<VoiceStandbyDiagnostics host={host} />);

    view.unmount();

    expect(unsubscribe).toHaveBeenCalled();
  });
});
