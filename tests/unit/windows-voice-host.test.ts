import { describe, expect, it, vi } from "vitest";

import { STANDBY_CONTRACT_VERSION, STANDBY_MESSAGE_TYPES } from "@/modules/voice-pos/standby-contract";
import {
  createWindowsVoiceHost,
  type WindowsWebViewLike,
} from "@/modules/voice-pos/windows-host";

function fakeWebView() {
  const listeners = new Set<(event: { data: unknown }) => void>();
  const posted: unknown[] = [];
  const view: WindowsWebViewLike = {
    postMessage: (message) => posted.push(message),
    addEventListener: (_type, listener) => listeners.add(listener),
    removeEventListener: (_type, listener) => listeners.delete(listener),
  };
  return {
    view,
    posted,
    listenerCount: () => listeners.size,
    emit: (data: unknown) => listeners.forEach((listener) => listener({ data })),
  };
}

function wake(overrides: Record<string, unknown> = {}) {
  return {
    v: STANDBY_CONTRACT_VERSION,
    type: STANDBY_MESSAGE_TYPES.wakeDetected,
    seq: 1,
    sessionId: "abc123def456",
    at: new Date().toISOString(),
    phraseId: "sawatdee_os",
    confidence: 0.9,
    ...overrides,
  };
}

describe("windows voice host — การตรวจว่ามี Launcher อยู่ไหม", () => {
  it("ไม่มี chrome.webview = ใช้ไม่ได้ แต่ต้องไม่ error", () => {
    const host = createWindowsVoiceHost({ webview: null });

    expect(host.available).toBe(false);
    // ทุกเมธอดต้องเรียกได้เงียบ ๆ — เบราว์เซอร์ปกติคือกรณีที่พบบ่อยที่สุด
    expect(() => {
      const unsubscribe = host.subscribe(() => {});
      host.commandStarted("s1");
      host.commandExtended("s1");
      host.commandEnded("s1", "completed");
      unsubscribe();
      host.dispose();
    }).not.toThrow();
  });

  it("ของปลอมที่ขาดเมธอดถือว่าใช้ไม่ได้", () => {
    const broken = { postMessage: () => {} } as unknown as WindowsWebViewLike;

    expect(createWindowsVoiceHost({ webview: broken }).available).toBe(false);
  });

  it("มี chrome.webview ครบ = ใช้ได้", () => {
    const { view } = fakeWebView();

    expect(createWindowsVoiceHost({ webview: view }).available).toBe(true);
  });
});

describe("windows voice host — รับคำปลุก", () => {
  it("คำปลุกที่ถูกต้องถึงผู้ฟัง", () => {
    const web = fakeWebView();
    const host = createWindowsVoiceHost({ webview: web.view });
    const seen: unknown[] = [];
    host.subscribe((event) => seen.push(event));

    web.emit(wake());

    expect(seen).toEqual([
      { kind: "start-listening", sessionId: "abc123def456", phraseId: "sawatdee_os" },
    ]);
  });

  it("ข้อความรูปทรงผิดถูกทิ้งเงียบ", () => {
    const web = fakeWebView();
    const host = createWindowsVoiceHost({ webview: web.view });
    const listener = vi.fn();
    host.subscribe(listener);

    web.emit({ v: 99, type: "wake.detected" });
    web.emit("ปลุกหน่อย");
    web.emit(null);
    // รหัสคำปลุกที่รูปทรงผิด (ไม่ใช่ "รหัสที่ไม่รู้จัก" ซึ่งต้องผ่านได้)
    web.emit(wake({ phraseId: "อักขระแปลก!" }));

    expect(listener).not.toHaveBeenCalled();
  });

  it("ข้อความเดิมที่ถูกส่งซ้ำถูกทิ้ง", () => {
    const web = fakeWebView();
    const host = createWindowsVoiceHost({ webview: web.view });
    const listener = vi.fn();
    host.subscribe(listener);

    web.emit(wake({ seq: 4 }));
    web.emit(wake({ seq: 4, sessionId: "zzz999zzz999" }));
    web.emit(wake({ seq: 2, sessionId: "zzz999zzz999" }));

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("ปลุกซ้อนระหว่างที่ยังฟังอยู่ถูกทิ้ง", () => {
    const web = fakeWebView();
    const host = createWindowsVoiceHost({ webview: web.view });
    const listener = vi.fn();
    host.subscribe(listener);

    web.emit(wake({ seq: 1 }));
    web.emit(wake({ seq: 2, sessionId: "second000001" }));

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("เว็บเปิดไมค์เองไม่ได้ ต้องบอกให้ผู้ใช้แตะ ไม่ใช่เงียบ", () => {
    const web = fakeWebView();
    const host = createWindowsVoiceHost({ webview: web.view, canStartListening: () => false });
    const seen: unknown[] = [];
    host.subscribe((event) => seen.push(event));

    web.emit(wake());

    expect(seen).toEqual([
      { kind: "show-push-to-talk", sessionId: "abc123def456", reason: "user_activation_required" },
    ]);
    // และต้องไม่แอบบอก host ว่าเริ่มฟังแล้ว
    expect(web.posted).toHaveLength(0);
  });

  it("host แจ้ง fallback แล้วผู้ฟังต้องรู้", () => {
    const web = fakeWebView();
    const host = createWindowsVoiceHost({ webview: web.view });
    const seen: unknown[] = [];
    host.subscribe((event) => seen.push(event));

    web.emit({
      v: STANDBY_CONTRACT_VERSION,
      type: STANDBY_MESSAGE_TYPES.wakeFallback,
      seq: 1,
      sessionId: "abc123def456",
      at: new Date().toISOString(),
      reason: "watchdog_timeout",
    });

    expect(seen).toEqual([
      { kind: "show-push-to-talk", sessionId: "abc123def456", reason: "watchdog_timeout" },
    ]);
  });
});

describe("windows voice host — รายงานกลับ", () => {
  it("ส่งสถานะครบสามจังหวะพร้อมลำดับที่เดินหน้า", () => {
    const web = fakeWebView();
    const host = createWindowsVoiceHost({ webview: web.view });
    host.subscribe(() => {});
    web.emit(wake());

    host.commandStarted("abc123def456");
    host.commandExtended("abc123def456");
    host.commandEnded("abc123def456", "completed");

    expect(web.posted).toEqual([
      { v: 1, type: STANDBY_MESSAGE_TYPES.sessionStarted, seq: 1, sessionId: "abc123def456" },
      { v: 1, type: STANDBY_MESSAGE_TYPES.sessionExtended, seq: 2, sessionId: "abc123def456" },
      {
        v: 1,
        type: STANDBY_MESSAGE_TYPES.sessionEnded,
        seq: 3,
        sessionId: "abc123def456",
        reason: "completed",
      },
    ]);
  });

  it("รายงานว่าเปิดไมค์เองไม่ได้ ทำให้ host คืนไมค์กลับไปฟังคำปลุกต่อ", () => {
    const web = fakeWebView();
    const host = createWindowsVoiceHost({ webview: web.view });
    web.emit(wake());

    host.commandEnded("abc123def456", "tap_required");

    expect(web.posted).toHaveLength(1);
    expect(web.posted[0]).toMatchObject({
      type: STANDBY_MESSAGE_TYPES.sessionEnded,
      reason: "tap_required",
    });
  });

  it("รอบที่ไม่ได้ถืออยู่ต้องไม่ถูกรายงาน", () => {
    const web = fakeWebView();
    const host = createWindowsVoiceHost({ webview: web.view });
    web.emit(wake());

    host.commandStarted("othersession");

    expect(web.posted).toHaveLength(0);
  });
});

describe("windows voice host — เก็บกวาด", () => {
  it("เลิกรับแล้วต้องไม่ได้รับอีก", () => {
    const web = fakeWebView();
    const host = createWindowsVoiceHost({ webview: web.view });
    const listener = vi.fn();
    const unsubscribe = host.subscribe(listener);

    unsubscribe();
    web.emit(wake());

    expect(listener).not.toHaveBeenCalled();
  });

  it("dispose ถอดตัวรับออกจาก webview จริง", () => {
    const web = fakeWebView();
    const host = createWindowsVoiceHost({ webview: web.view });
    host.subscribe(() => {});

    expect(web.listenerCount()).toBe(1);
    host.dispose();

    expect(web.listenerCount()).toBe(0);
  });

  it("dispose แล้วต้องไม่ส่งอะไรออกไปอีก", () => {
    const web = fakeWebView();
    const host = createWindowsVoiceHost({ webview: web.view });
    web.emit(wake());

    host.dispose();
    host.commandStarted("abc123def456");

    expect(web.posted).toHaveLength(0);
  });

  it("dispose ซ้ำได้", () => {
    const web = fakeWebView();
    const host = createWindowsVoiceHost({ webview: web.view });

    expect(() => {
      host.dispose();
      host.dispose();
    }).not.toThrow();
  });
});
