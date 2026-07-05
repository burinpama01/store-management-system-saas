import { afterEach, describe, expect, it, vi } from "vitest";
import { isNativePlatform } from "@/modules/printing/native-print-client";
import { CHANNEL_LABELS } from "@/modules/printing/print-router";

describe("native print client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("isNativePlatform is false without Capacitor bridge", () => {
    vi.stubGlobal("window", {});
    expect(isNativePlatform()).toBe(false);
  });

  it("isNativePlatform is false when Capacitor reports web", () => {
    vi.stubGlobal("window", { Capacitor: { isNativePlatform: () => false } });
    expect(isNativePlatform()).toBe(false);
  });

  it("isNativePlatform is true inside the native app", () => {
    vi.stubGlobal("window", { Capacitor: { isNativePlatform: () => true } });
    expect(isNativePlatform()).toBe(true);
  });

  it("print router exposes the native bluetooth channel label", () => {
    expect(CHANNEL_LABELS["native-bluetooth"]).toContain("แอป");
  });
});
