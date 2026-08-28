import { describe, expect, it } from "vitest";
import { classifyFormFactor, detectDeviceCapabilities } from "@/modules/devices/capability";

describe("device capability contract (F0 · Task 1)", () => {
  it("classifies form factor at the single 768/1280 breakpoints", () => {
    expect(classifyFormFactor(320)).toBe("mobile");
    expect(classifyFormFactor(767)).toBe("mobile");
    expect(classifyFormFactor(768)).toBe("tablet");
    expect(classifyFormFactor(820)).toBe("tablet");
    expect(classifyFormFactor(1024)).toBe("tablet");
    expect(classifyFormFactor(1279)).toBe("tablet");
    expect(classifyFormFactor(1280)).toBe("desktop");
    expect(classifyFormFactor(1440)).toBe("desktop");
  });

  it("rejects non-finite or non-positive widths (fail closed)", () => {
    for (const width of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        detectDeviceCapabilities({
          width,
          os: "windows",
          browser: "chromium",
          storeOsApp: false,
          webBluetoothApi: false,
          webUsbApi: false,
          nativeBleApi: false,
          hubOnline: null,
        }),
      ).toThrow(RangeError);
    }
  });

  it("iPad Safari with hub online is a tablet browser that must use the hub", () => {
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
      }),
    ).toMatchObject({
      formFactor: "tablet",
      runtime: "browser",
      webBluetooth: false,
      webUsb: false,
      nativeBle: false,
      printHub: "online",
      recommendedPrint: "hub",
    });
  });

  it("iPad Safari reports an offline hub as offline without inventing USB/BLE", () => {
    expect(
      detectDeviceCapabilities({
        width: 768,
        os: "ios",
        browser: "safari",
        storeOsApp: false,
        webBluetoothApi: false,
        webUsbApi: false,
        nativeBleApi: false,
        hubOnline: false,
      }),
    ).toMatchObject({
      formFactor: "tablet",
      runtime: "browser",
      webBluetooth: false,
      webUsb: false,
      nativeBle: false,
      printHub: "offline",
      recommendedPrint: "browser",
    });
  });

  it("Windows Chrome desktop with WebUSB prefers USB over Bluetooth", () => {
    expect(
      detectDeviceCapabilities({
        width: 1440,
        os: "windows",
        browser: "chromium",
        storeOsApp: false,
        webBluetoothApi: true,
        webUsbApi: true,
        nativeBleApi: false,
        hubOnline: false,
      }),
    ).toMatchObject({
      formFactor: "desktop",
      runtime: "browser",
      webBluetooth: true,
      webUsb: true,
      nativeBle: false,
      printHub: "offline",
      recommendedPrint: "usb",
    });
  });

  it("Windows Firefox does not inherit Chromium-only WebUSB/WebBluetooth APIs", () => {
    expect(
      detectDeviceCapabilities({
        width: 1280,
        os: "windows",
        browser: "firefox",
        storeOsApp: false,
        webBluetoothApi: true,
        webUsbApi: true,
        nativeBleApi: false,
        hubOnline: false,
      }),
    ).toMatchObject({
      formFactor: "desktop",
      runtime: "browser",
      webBluetooth: false,
      webUsb: false,
      nativeBle: false,
      printHub: "offline",
      recommendedPrint: "browser",
    });
  });

  it("Android StoreOS app with native BLE prefers native BLE when the hub is unknown", () => {
    expect(
      detectDeviceCapabilities({
        width: 390,
        os: "android",
        browser: "chromium",
        storeOsApp: true,
        webBluetoothApi: false,
        webUsbApi: false,
        nativeBleApi: true,
        hubOnline: null,
      }),
    ).toMatchObject({
      formFactor: "mobile",
      runtime: "storeos-app",
      webBluetooth: false,
      webUsb: false,
      nativeBle: true,
      printHub: "unknown",
      recommendedPrint: "native-ble",
    });
  });

  it("Android browser with WebBluetooth uses web Bluetooth when the hub is offline", () => {
    expect(
      detectDeviceCapabilities({
        width: 414,
        os: "android",
        browser: "chromium",
        storeOsApp: false,
        webBluetoothApi: true,
        webUsbApi: false,
        nativeBleApi: false,
        hubOnline: false,
      }),
    ).toMatchObject({
      formFactor: "mobile",
      runtime: "browser",
      webBluetooth: true,
      webUsb: false,
      nativeBle: false,
      printHub: "offline",
      recommendedPrint: "web-bluetooth",
    });
  });

  it("fail closed on contradictory capability claims (iOS native BLE, non-Windows USB)", () => {
    expect(
      detectDeviceCapabilities({
        width: 1024,
        os: "ios",
        browser: "safari",
        storeOsApp: true,
        webBluetoothApi: true,
        webUsbApi: true,
        nativeBleApi: true,
        hubOnline: false,
      }),
    ).toMatchObject({
      formFactor: "tablet",
      runtime: "storeos-app",
      webBluetooth: false,
      webUsb: false,
      nativeBle: false,
      recommendedPrint: "browser",
    });
  });

  it("online hub outranks every local channel in the recommendation", () => {
    expect(
      detectDeviceCapabilities({
        width: 800,
        os: "android",
        browser: "chromium",
        storeOsApp: true,
        webBluetoothApi: true,
        webUsbApi: true,
        nativeBleApi: true,
        hubOnline: true,
      }),
    ).toMatchObject({
      formFactor: "tablet",
      runtime: "storeos-app",
      nativeBle: true,
      webUsb: false,
      webBluetooth: true,
      recommendedPrint: "hub",
    });
  });
});
