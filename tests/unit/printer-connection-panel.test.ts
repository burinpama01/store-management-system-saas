import { describe, expect, it } from "vitest";
import { resolvePrinterConnectionState } from "@/modules/printing/PrinterConnectionPanel";

describe("PrinterConnectionPanel connection state", () => {
  it("does not mark a remembered printer as ready after refresh", () => {
    const state = resolvePrinterConnectionState({
      bluetoothName: "BT Printer",
      usbName: null,
      bluetoothConnected: false,
      usbConnected: false,
    });

    expect(state.connectedDevice).toBeNull();
    expect(state.rememberedDevice).toEqual({ kind: "Bluetooth (จำไว้)", name: "BT Printer" });
  });

  it("marks a live Bluetooth session as ready when the panel remounts", () => {
    const state = resolvePrinterConnectionState({
      bluetoothName: "BT Printer",
      usbName: null,
      bluetoothConnected: true,
      usbConnected: false,
    });

    expect(state.connectedDevice).toEqual({ kind: "Bluetooth", name: "BT Printer" });
    expect(state.rememberedDevice).toBeNull();
  });

  it("marks a live USB session as ready when only USB is connected", () => {
    const state = resolvePrinterConnectionState({
      bluetoothName: null,
      usbName: "USB Printer",
      bluetoothConnected: false,
      usbConnected: true,
    });

    expect(state.connectedDevice).toEqual({ kind: "USB", name: "USB Printer" });
    expect(state.rememberedDevice).toBeNull();
  });
});
