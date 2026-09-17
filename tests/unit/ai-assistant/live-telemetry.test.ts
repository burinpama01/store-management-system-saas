import { describe, expect, it, vi } from "vitest";
import {
  LIVE_DIAGNOSTICS_GLOBAL,
  createLiveTelemetry,
  emitLiveTelemetry,
  noopLiveTelemetry,
  setSharedLiveTelemetry,
} from "@/modules/ai-assistant/ui/live-telemetry";
import {
  LIVE_TELEMETRY_EVENTS,
  isForbiddenTelemetryKey,
  isLiveTelemetryEventName,
} from "@/modules/ai-assistant/live-telemetry-events";
import { wakeRouteTelemetry } from "@/modules/voice-pos/wake-routing";

// PR3-Live (diagnostics) — ตัวส่ง event ฝั่งเบราว์เซอร์
// หัวใจ: ต้องไม่ทำให้ AI Live พังไม่ว่าอะไรจะเกิดขึ้น และต้องไม่ส่งอะไรขึ้น server เมื่อปิดโหมด

describe("createLiveTelemetry", () => {
  it("ส่งเป็นชุดไปที่ปลายทางเดียว และ event หน้าตาตรงกับที่ emit", () => {
    const sent: string[] = [];
    const telemetry = createLiveTelemetry({
      enabled: true,
      flushIntervalMs: 0,
      send: (body) => sent.push(body),
      now: () => 1_700_000_000_000,
    });

    telemetry.emit({ event: "live.requested", stage: "session", result: "started" });
    telemetry.emit({ event: "mic.claimed", stage: "mic", result: "success", sessionId: "sess-1234abcd" });

    expect(sent).toHaveLength(2);
    expect(JSON.parse(sent[0])).toEqual({
      events: [{ event: "live.requested", stage: "session", result: "started" }],
    });
    expect(JSON.parse(sent[1])).toEqual({
      events: [{ event: "mic.claimed", stage: "mic", result: "success", sessionId: "sess-1234abcd" }],
    });
  });

  it("โหมดวินิจฉัยปิด = ไม่ส่งอะไรขึ้น server แต่ยังจดไว้ในเครื่องให้เปิด DevTools ดูได้", () => {
    const sent: string[] = [];
    const telemetry = createLiveTelemetry({ enabled: false, flushIntervalMs: 0, send: (body) => sent.push(body) });

    telemetry.emit({ event: "audio.play_blocked", stage: "audio", result: "blocked", reason: "autoplay_blocked" });

    expect(sent).toHaveLength(0);
    expect(telemetry.recent()).toHaveLength(1);
    expect(telemetry.recent()[0]).toMatchObject({ event: "audio.play_blocked", reason: "autoplay_blocked" });
    expect(telemetry.recent()[0].at).toEqual(expect.any(String));
  });

  it("buffer มีเพดาน — ของเก่าถูกทิ้ง ไม่โตไม่จำกัดในเซสชันยาว", () => {
    const telemetry = createLiveTelemetry({ enabled: false, flushIntervalMs: 0, bufferSize: 3 });

    for (let i = 0; i < 10; i += 1) {
      telemetry.emit({ event: "webrtc.ice_state_changed", stage: "webrtc", result: "success", reason: `s${i}` });
    }

    expect(telemetry.recent()).toHaveLength(3);
    expect(telemetry.recent().map((entry) => entry.reason)).toEqual(["s7", "s8", "s9"]);
  });

  it("ส่งไม่สำเร็จต้องไม่โยนออกไปหาเส้นทางหลัก (telemetry ห้ามทำให้ POS พัง)", () => {
    const telemetry = createLiveTelemetry({
      enabled: true,
      flushIntervalMs: 0,
      send: () => {
        throw new Error("network down");
      },
    });

    expect(() => telemetry.emit({ event: "live.stopped", stage: "stop", result: "ended", reason: "user" })).not.toThrow();
    expect(telemetry.recent()).toHaveLength(1);
  });

  it("รวม event ที่ค้างเป็นชุดเดียวเมื่อ flush ตามรอบเวลา", () => {
    vi.useFakeTimers();
    try {
      const sent: string[] = [];
      const telemetry = createLiveTelemetry({ enabled: true, flushIntervalMs: 2_000, send: (body) => sent.push(body) });

      telemetry.emit({ event: "wake.detected", stage: "wake", result: "success" });
      telemetry.emit({ event: "wake.route_live", stage: "wake", result: "success" });
      expect(sent).toHaveLength(0);

      vi.advanceTimersByTime(2_000);

      expect(sent).toHaveLength(1);
      expect(JSON.parse(sent[0]).events).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("ตัวกลางของหน้า (shared telemetry)", () => {
  it("ยังไม่ถูกตั้งค่า = noop, ตั้งแล้วส่งเข้าตัวที่ตั้งไว้, ถอนแล้วกลับเป็น noop", () => {
    expect(() => emitLiveTelemetry({ event: "wake.detected", stage: "wake", result: "success" })).not.toThrow();

    const telemetry = createLiveTelemetry({ enabled: false, flushIntervalMs: 0 });
    const unset = setSharedLiveTelemetry(telemetry);
    emitLiveTelemetry({ event: "wake.detected", stage: "wake", result: "success" });
    expect(telemetry.recent()).toHaveLength(1);

    unset();
    emitLiveTelemetry({ event: "wake.route_busy", stage: "wake", result: "blocked" });
    expect(telemetry.recent()).toHaveLength(1);
    expect(noopLiveTelemetry.recent()).toHaveLength(0);
  });

  it("เขียน buffer ไว้ที่ global ของหน้าต่างให้เปิด DevTools ดูได้", () => {
    const store: Record<string, unknown> = {};
    vi.stubGlobal("window", store);
    try {
      const telemetry = createLiveTelemetry({ enabled: false, flushIntervalMs: 0 });
      telemetry.emit({ event: "live.requested", stage: "session", result: "started" });

      expect(Array.isArray(store[LIVE_DIAGNOSTICS_GLOBAL])).toBe(true);
      expect((store[LIVE_DIAGNOSTICS_GLOBAL] as unknown[])).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("taxonomy กลาง", () => {
  it("ชื่อ event เป็น allowlist ปิด", () => {
    expect(isLiveTelemetryEventName("live.session_created")).toBe(true);
    expect(isLiveTelemetryEventName("live.something_new")).toBe(false);
    expect(isLiveTelemetryEventName(123)).toBe(false);
    // ทุกชื่อในรายการต้องเป็น dot notation (ค้นใน /system/logs ได้ด้วย prefix ของ stage)
    for (const name of LIVE_TELEMETRY_EVENTS) expect(name).toMatch(/^[a-z]+\.[a-z_]+$/);
  });

  it("คีย์ต้องห้ามถูกจับได้แม้เปลี่ยนตัวพิมพ์/ขีดล่าง", () => {
    for (const key of ["sessionToken", "Session_Token", "ephemeralToken", "apiKey", "authorization", "transcript", "rawAudio", "args"]) {
      expect(isForbiddenTelemetryKey(key)).toBe(true);
    }
    for (const key of ["tool", "httpStatus", "cartVersionBefore", "itemCount", "model"]) {
      expect(isForbiddenTelemetryKey(key)).toBe(false);
    }
  });

  it("ผลการส่งคำปลุกแปลงเป็น event ที่ถูกต้องทุกทาง", () => {
    expect(wakeRouteTelemetry("started")).toEqual({ event: "wake.route_live", stage: "wake", result: "success" });
    expect(wakeRouteTelemetry("busy")).toEqual({
      event: "wake.route_busy", stage: "wake", result: "blocked", reason: "live_already_active",
    });
    expect(wakeRouteTelemetry("unavailable")).toEqual({
      event: "wake.route_unavailable", stage: "wake", result: "blocked", reason: "live_not_enabled",
    });
  });
});
