import { describe, it, expect } from "vitest";
import {
  generateHubToken,
  hashHubToken,
  verifyHubToken,
  summarizeHubStatus,
  validatePrintTarget,
  validatePrintPayloadBase64,
  validateHubBluetoothPort,
  HUB_OFFLINE_THRESHOLD_MS,
  MAX_PRINT_JOB_BYTES,
} from "@/modules/printing/print-hub";

describe("print hub tokens", () => {
  it("generates distinct high-entropy tokens", () => {
    const a = generateHubToken();
    const b = generateHubToken();
    expect(a).not.toEqual(b);
    expect(a.length).toBeGreaterThanOrEqual(40);
  });

  it("hashes deterministically", () => {
    expect(hashHubToken("secret")).toEqual(hashHubToken("secret"));
    expect(hashHubToken("secret")).not.toEqual(hashHubToken("other"));
  });

  it("verifies a matching token and rejects mismatches", () => {
    const token = generateHubToken();
    const hash = hashHubToken(token);
    expect(verifyHubToken(token, hash)).toBe(true);
    expect(verifyHubToken("wrong", hash)).toBe(false);
  });

  it("rejects empty or missing token/hash", () => {
    expect(verifyHubToken("", hashHubToken("x"))).toBe(false);
    expect(verifyHubToken("x", null)).toBe(false);
    expect(verifyHubToken("x", undefined)).toBe(false);
    expect(verifyHubToken("x", "")).toBe(false);
  });
});

describe("summarizeHubStatus", () => {
  const now = new Date("2026-06-25T12:00:00.000Z");

  it("reports offline when never seen", () => {
    expect(summarizeHubStatus(null, now)).toEqual({ online: false, lastSeen: null, secondsAgo: null });
  });

  it("reports online within the threshold", () => {
    const recent = new Date(now.getTime() - 10_000).toISOString();
    const result = summarizeHubStatus(recent, now);
    expect(result.online).toBe(true);
    expect(result.secondsAgo).toBe(10);
  });

  it("reports offline past the threshold", () => {
    const stale = new Date(now.getTime() - (HUB_OFFLINE_THRESHOLD_MS + 5_000)).toISOString();
    expect(summarizeHubStatus(stale, now).online).toBe(false);
  });

  it("treats a future heartbeat and invalid date as offline", () => {
    const future = new Date(now.getTime() + 30_000).toISOString();
    expect(summarizeHubStatus(future, now).online).toBe(false);
    expect(summarizeHubStatus("not-a-date", now)).toEqual({ online: false, lastSeen: null, secondsAgo: null });
  });
});

describe("validatePrintTarget", () => {
  it("accepts private LAN printers and defaults the port", () => {
    expect(validatePrintTarget({ host: "192.168.1.50" })).toEqual({ target: { host: "192.168.1.50", port: 9100 } });
    expect(validatePrintTarget({ host: "10.0.0.5", port: 9101 }).target).toEqual({ host: "10.0.0.5", port: 9101 });
  });

  it("rejects public, loopback, and malformed hosts", () => {
    expect(validatePrintTarget({ host: "8.8.8.8" }).error).toBeTruthy();
    expect(validatePrintTarget({ host: "127.0.0.1" }).error).toBeTruthy();
    expect(validatePrintTarget({ host: "not-an-ip" }).error).toBeTruthy();
    expect(validatePrintTarget({ host: "" }).error).toBeTruthy();
  });

  it("rejects out-of-range ports", () => {
    expect(validatePrintTarget({ host: "192.168.1.50", port: 0 }).error).toBeTruthy();
    expect(validatePrintTarget({ host: "192.168.1.50", port: 70000 }).error).toBeTruthy();
  });
});

describe("validateHubBluetoothPort", () => {
  it("accepts and normalizes valid COM ports", () => {
    expect(validateHubBluetoothPort("com5")).toEqual({ device: "COM5" });
    expect(validateHubBluetoothPort(" COM12 ")).toEqual({ device: "COM12" });
    expect(validateHubBluetoothPort("COM999")).toEqual({ device: "COM999" });
  });

  it("rejects empty, malformed, and unsafe values", () => {
    expect(validateHubBluetoothPort("").error).toBeTruthy();
    expect(validateHubBluetoothPort("COM0").error).toBeTruthy();
    expect(validateHubBluetoothPort("LPT1").error).toBeTruthy();
    expect(validateHubBluetoothPort("COM5; rm -rf /").error).toBeTruthy();
    expect(validateHubBluetoothPort(undefined).error).toBeTruthy();
  });
});

describe("validatePrintPayloadBase64", () => {
  it("accepts a well-formed base64 payload", () => {
    const payload = Buffer.from("hello").toString("base64");
    expect(validatePrintPayloadBase64(payload)).toEqual({ payload });
  });

  it("rejects empty, non-string, and non-base64 input", () => {
    expect(validatePrintPayloadBase64("").error).toBeTruthy();
    expect(validatePrintPayloadBase64(undefined).error).toBeTruthy();
    expect(validatePrintPayloadBase64("not base64!!").error).toBeTruthy();
  });

  it("rejects payloads over the size limit", () => {
    const tooBig = "A".repeat(Math.ceil((MAX_PRINT_JOB_BYTES + 1024) * 4 / 3) + 8);
    expect(validatePrintPayloadBase64(tooBig).error).toBeTruthy();
  });
});
