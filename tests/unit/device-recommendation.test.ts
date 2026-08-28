import { describe, expect, it } from "vitest";
import { detectDeviceCapabilities, type DeviceInput } from "@/modules/devices/capability";
import { recommendPrintChannels } from "@/modules/devices/device-recommendation";
import { detectBrowser, detectOs } from "@/modules/devices/browser-capability";

const input = (over: Partial<DeviceInput> = {}): DeviceInput => ({
  width: 820,
  os: "ios",
  browser: "safari",
  storeOsApp: false,
  webBluetoothApi: false,
  webUsbApi: false,
  nativeBleApi: false,
  hubOnline: true,
  ...over,
});

describe("device capability contract (plan RED example)", () => {
  it("iOS Safari with Hub online recommends the Hub — never USB/BLE", () => {
    expect(
      detectDeviceCapabilities({
        width: 820,
        os: "ios",
        browser: "safari",
        storeOsApp: false,
        webBluetoothApi: false,
        webUsbApi: false,
        nativeBleApi: false,
        hubOnline: true,
      }).recommendedPrint,
    ).toBe("hub");
  });
});

describe("recommendPrintChannels — deterministic matrix", () => {
  it("returns exactly one primary whenever any channel is available", () => {
    const r = recommendPrintChannels(detectDeviceCapabilities(input()), { hasNetworkPrinter: false });
    expect(r.primary).not.toBeNull();
    expect(r.primary?.role).toBe("primary");
    expect(r.fallbacks.filter((f) => f.role !== "fallback")).toHaveLength(0);
  });

  it("hub online → primary hub with a deep link to the Print Hub page", () => {
    const r = recommendPrintChannels(detectDeviceCapabilities(input({ hubOnline: true })), { hasNetworkPrinter: true });
    expect(r.primary?.id).toBe("hub");
    expect(r.primary?.href).toBe("/settings/print-hub");
  });

  it("hub offline + Windows Chrome with WebUSB → primary usb", () => {
    const r = recommendPrintChannels(
      detectDeviceCapabilities(input({ os: "windows", browser: "chromium", webUsbApi: true, hubOnline: false })),
      { hasNetworkPrinter: false },
    );
    expect(r.primary?.id).toBe("usb");
  });

  it("hub offline + Android StoreOS app with native BLE → primary native-ble", () => {
    const r = recommendPrintChannels(
      detectDeviceCapabilities(input({ os: "android", browser: "chromium", storeOsApp: true, nativeBleApi: true, hubOnline: false })),
      { hasNetworkPrinter: false },
    );
    expect(r.primary?.id).toBe("native-ble");
  });

  it("iOS Safari never offers USB/Web Bluetooth/native BLE as usable — unavailable with a reason", () => {
    const r = recommendPrintChannels(detectDeviceCapabilities(input({ hubOnline: false })), { hasNetworkPrinter: false });
    for (const id of ["usb", "web-bluetooth", "native-ble"] as const) {
      const opt = r.unavailable.find((o) => o.id === id);
      expect(opt, id).toBeDefined();
      expect(opt?.reason.length).toBeGreaterThan(0);
    }
    expect(r.primary?.id).toBe("browser");
  });

  it("hub unknown → primary is the best non-hub channel and Hub is listed as unverified", () => {
    const r = recommendPrintChannels(
      detectDeviceCapabilities(input({ os: "windows", browser: "chromium", webUsbApi: true, hubOnline: null })),
      { hasNetworkPrinter: false },
    );
    expect(r.primary?.id).toBe("usb");
    expect(r.unknown.find((o) => o.id === "hub")).toBeDefined();
  });

  it("hub offline → hub stays an actionable fallback (install/start), never primary", () => {
    const r = recommendPrintChannels(
      detectDeviceCapabilities(input({ os: "windows", browser: "chromium", webUsbApi: true, hubOnline: false })),
      { hasNetworkPrinter: false },
    );
    expect(r.primary?.id).not.toBe("hub");
    expect(r.fallbacks.find((o) => o.id === "hub")).toBeDefined();
  });

  it("IP is offered only when a network printer is configured, and never as ready/primary from browser APIs", () => {
    const caps = detectDeviceCapabilities(input({ os: "windows", browser: "chromium", webUsbApi: false, hubOnline: false }));
    const without = recommendPrintChannels(caps, { hasNetworkPrinter: false });
    expect(without.unavailable.find((o) => o.id === "ip")).toBeDefined();

    const withPrinter = recommendPrintChannels(caps, { hasNetworkPrinter: true });
    const ip = withPrinter.fallbacks.find((o) => o.id === "ip");
    expect(ip).toBeDefined();
    expect(ip?.reason).toContain("ทดสอบ");
    expect(withPrinter.primary?.id).not.toBe("ip");
  });

  it("messages are human-readable Thai for every option", () => {
    const r = recommendPrintChannels(detectDeviceCapabilities(input()), { hasNetworkPrinter: true });
    for (const opt of [r.primary, ...r.fallbacks, ...r.unavailable, ...r.unknown].filter(Boolean)) {
      expect(opt!.title.length).toBeGreaterThan(0);
      expect(opt!.reason.length).toBeGreaterThan(0);
    }
  });
});

describe("browser adapter UA helpers (pure)", () => {
  it("detects iPad both via iPad UA and the iPadOS Mac-UA-with-touch quirk", () => {
    expect(detectOs("Mozilla/5.0 (iPad; CPU OS 16_6 like Mac OS X) AppleWebKit/605.1.15", 0)).toBe("ios");
    expect(
      detectOs(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
        5,
      ),
    ).toBe("ios");
    expect(detectOs("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0", 0)).toBe("windows");
    expect(detectOs("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/126.0.0.0 Mobile", 0)).toBe("android");
    expect(
      detectOs("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15", 0),
    ).toBe("macos");
  });

  it("detects browser families without misdetecting Safari inside Chrome UAs", () => {
    const chrome = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
    expect(detectBrowser(chrome)).toBe("chromium");
    expect(detectBrowser(chrome.replace("Chrome/126.0.0.0", "Edg/126.0.0.0"))).toBe("chromium");
    expect(detectBrowser("Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0")).toBe("firefox");
    expect(
      detectBrowser("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15"),
    ).toBe("safari");
  });
});