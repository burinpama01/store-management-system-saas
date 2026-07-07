import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Printer } from "@/modules/stores/types";
import type { ReceiptData } from "@/modules/printing/types";
import type { EscPosReceiptInput } from "@/modules/printing/escpos";

vi.mock("@/modules/printing/print-router", () => ({
  printReceiptAuto: vi.fn().mockResolvedValue("pdf"),
}));

vi.mock("@/modules/printing/print-service", () => ({
  printService: {
    print: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@/modules/printing/network-print-client", () => ({
  enqueueReceiptPrintJob: vi.fn().mockResolvedValue({ hubOnline: true }),
}));

vi.mock("@/modules/printing/native-print-client", () => ({
  isNativePlatform: vi.fn().mockReturnValue(false),
  getNativeBluetoothPrinterName: vi.fn().mockReturnValue(null),
}));

import { printReceiptAuto } from "@/modules/printing/print-router";
import { printService } from "@/modules/printing/print-service";
import { enqueueReceiptPrintJob } from "@/modules/printing/network-print-client";
import { getNativeBluetoothPrinterName, isNativePlatform } from "@/modules/printing/native-print-client";
import {
  ReceiptPrintFallbackError,
  autoPrintReceipt,
  isHubReceiptPrinter,
  printReceiptWithFallback,
  selectConfiguredPrinter,
  selectDefaultPrinter,
  selectHubReceiptPrinter,
} from "@/modules/printing/receipt-printer";

const receipt: ReceiptData = {
  storeName: "Each Other",
  showTaxId: false,
  orderNumber: "R-1",
  items: [{ name: "Coffee", modifierNames: [], quantity: 1, unitPrice: 45, totalPrice: 45 }],
  subtotal: 45,
  discount: 0,
  total: 45,
  payments: [{ method: "cash", amount: 45 }],
  showQrPayment: false,
  paperWidth: "58mm",
  printedAt: "2026-06-19T00:00:00.000Z",
};

const escpos: EscPosReceiptInput = receipt;

function printer(id: string, isDefault: boolean, paperWidth: "58mm" | "80mm" = "80mm"): Printer {
  return {
    id,
    storeId: "store-1",
    organizationId: "org-1",
    name: id,
    type: "ip",
    isDefault,
    ipAddress: "192.168.1.50",
    port: 9100,
    paperWidth,
    createdAt: "2026-06-19T00:00:00.000Z",
    updatedAt: "2026-06-19T00:00:00.000Z",
  };
}

describe("printReceiptWithFallback", () => {
  beforeEach(() => {
    vi.mocked(printReceiptAuto).mockClear();
    vi.mocked(printService.print).mockClear();
    vi.mocked(printService.print).mockResolvedValue(undefined);
  });

  it("uses the configured default printer before automatic browser/device fallback", async () => {
    const defaultPrinter = printer("default-printer", true, "80mm");

    const result = await printReceiptWithFallback({
      printers: [printer("backup-printer", false), defaultPrinter],
      escpos,
      browser: receipt,
    });

    expect(result.channel).toBe("configured");
    expect(result.printer).toBe(defaultPrinter);
    expect(printService.print).toHaveBeenCalledWith(defaultPrinter, {
      ...receipt,
      paperWidth: "80mm",
    });
    expect(printReceiptAuto).not.toHaveBeenCalled();
  });

  it("uses a selected preferred printer before the configured default printer", async () => {
    const defaultPrinter = printer("default-printer", true, "80mm");
    const selectedPrinter = printer("selected-printer", false, "58mm");

    const result = await printReceiptWithFallback({
      printers: [defaultPrinter, selectedPrinter],
      preferredPrinterId: selectedPrinter.id,
      escpos,
      browser: receipt,
    });

    expect(result.channel).toBe("configured");
    expect(result.printer).toBe(selectedPrinter);
    expect(printService.print).toHaveBeenCalledWith(selectedPrinter, {
      ...receipt,
      paperWidth: "58mm",
    });
    expect(printReceiptAuto).not.toHaveBeenCalled();
  });

  it("falls back to automatic Bluetooth/USB/browser printing when no default printer exists", async () => {
    const result = await printReceiptWithFallback({
      printers: [printer("backup-printer", false)],
      escpos,
      browser: receipt,
    });

    expect(result.channel).toBe("pdf");
    expect(printService.print).not.toHaveBeenCalled();
    expect(printReceiptAuto).toHaveBeenCalledWith(escpos, receipt);
  });

  it("falls back to automatic printing and reports the configured printer error", async () => {
    const onConfiguredPrinterError = vi.fn();
    const defaultPrinter = printer("default-printer", true);
    const failure = new Error("offline");
    vi.mocked(printService.print).mockRejectedValueOnce(failure);

    const result = await printReceiptWithFallback({
      printers: [defaultPrinter],
      escpos,
      browser: receipt,
      onConfiguredPrinterError,
    });

    expect(result.channel).toBe("pdf");
    expect(result.fallbackFromPrinter).toBe(defaultPrinter);
    expect(result.configuredPrinterError).toBe(failure);
    expect(onConfiguredPrinterError).toHaveBeenCalledWith(failure, defaultPrinter);
    expect(printReceiptAuto).toHaveBeenCalledWith(escpos, receipt);
  });

  it("skips automatic Bluetooth fallback when a configured Bluetooth printer rejects a device mismatch", async () => {
    const defaultPrinter: Printer = {
      ...printer("bluetooth-default", true),
      type: "bluetooth",
      bluetoothDeviceId: "bt-expected",
      ipAddress: undefined,
      port: undefined,
    };
    const failure = Object.assign(new Error("เครื่องพิมพ์ Bluetooth ที่เชื่อมต่อไม่ตรงกับเครื่องพิมพ์ Bluetooth ที่ตั้งไว้"), {
      name: "BluetoothPrinterMismatchError",
    });
    vi.mocked(printService.print).mockRejectedValueOnce(failure);
    vi.mocked(printReceiptAuto).mockResolvedValueOnce("usb");

    const result = await printReceiptWithFallback({
      printers: [defaultPrinter],
      escpos,
      browser: receipt,
    });

    expect(result.channel).toBe("usb");
    expect(result.fallbackFromPrinter).toBe(defaultPrinter);
    expect(printReceiptAuto).toHaveBeenCalledWith(escpos, receipt, { skipBluetooth: true });
  });

  it("throws a combined error when configured printing and fallback printing both fail", async () => {
    const defaultPrinter = printer("default-printer", true);
    const configuredFailure = new Error("configured offline");
    const fallbackFailure = new Error("popup blocked");
    vi.mocked(printService.print).mockRejectedValueOnce(configuredFailure);
    vi.mocked(printReceiptAuto).mockRejectedValueOnce(fallbackFailure);

    const promise = printReceiptWithFallback({
      printers: [defaultPrinter],
      escpos,
      browser: receipt,
    });

    await expect(promise).rejects.toMatchObject({
      configuredPrinter: defaultPrinter,
      configuredPrinterError: configuredFailure,
      fallbackError: fallbackFailure,
    });
    await expect(promise).rejects.toBeInstanceOf(ReceiptPrintFallbackError);
  });
});

function btHubPrinter(id: string, isDefault: boolean, comPort = "COM5"): Printer {
  return {
    id,
    storeId: "store-1",
    organizationId: "org-1",
    name: id,
    type: "bluetooth",
    isDefault,
    hubBluetoothPort: comPort,
    paperWidth: "80mm",
    createdAt: "2026-06-19T00:00:00.000Z",
    updatedAt: "2026-06-19T00:00:00.000Z",
  };
}

describe("isHubReceiptPrinter", () => {
  it("recognizes LAN and Bluetooth-via-Hub printers, not direct BT/USB", () => {
    expect(isHubReceiptPrinter(printer("ip", true))).toBe(true);
    expect(isHubReceiptPrinter(btHubPrinter("bt-hub", true))).toBe(true);
    expect(isHubReceiptPrinter({ ...btHubPrinter("bt-direct", true), hubBluetoothPort: undefined })).toBe(false);
    expect(isHubReceiptPrinter({ ...printer("no-ip", true), ipAddress: undefined })).toBe(false);
  });
});

describe("autoPrintReceipt", () => {
  beforeEach(() => {
    vi.mocked(printReceiptAuto).mockClear();
    vi.mocked(enqueueReceiptPrintJob).mockClear();
    vi.mocked(enqueueReceiptPrintJob).mockResolvedValue({ hubOnline: true });
  });

  it("enqueues to the Hub for a Hub-capable default printer (iPad-safe)", async () => {
    const btHub = btHubPrinter("bt-hub", true);
    const result = await autoPrintReceipt({ printers: [btHub], escpos, browser: receipt });
    expect(result.printer).toBe(btHub);
    expect(enqueueReceiptPrintJob).toHaveBeenCalledWith(btHub.id, { ...receipt, paperWidth: "80mm" });
    expect(printReceiptAuto).not.toHaveBeenCalled();
  });

  it("surfaces hubOnline=false so callers can warn that the cashier PC Hub is offline", async () => {
    vi.mocked(enqueueReceiptPrintJob).mockResolvedValueOnce({ hubOnline: false });
    const result = await autoPrintReceipt({ printers: [btHubPrinter("bt-hub", true)], escpos, browser: receipt });
    expect(result.hubOnline).toBe(false);
  });

  it("falls back to browser printing when no Hub printer is configured", async () => {
    const result = await autoPrintReceipt({ printers: [], escpos, browser: receipt });
    expect(result.channel).toBe("pdf");
    expect(enqueueReceiptPrintJob).not.toHaveBeenCalled();
    expect(printReceiptAuto).toHaveBeenCalledWith(escpos, receipt);
  });

  it("selectHubReceiptPrinter ignores a direct Bluetooth default printer", () => {
    const direct = { ...btHubPrinter("bt-direct", true), hubBluetoothPort: undefined };
    expect(selectHubReceiptPrinter([direct])).toBeNull();
  });
});

describe("printReceiptWithFallback — Bluetooth via Hub", () => {
  beforeEach(() => {
    vi.mocked(printReceiptAuto).mockClear();
    vi.mocked(printService.print).mockClear();
    vi.mocked(enqueueReceiptPrintJob).mockClear();
    vi.mocked(enqueueReceiptPrintJob).mockResolvedValue({ hubOnline: true });
  });

  it("enqueues to the Hub instead of Web Bluetooth for a bt-hub configured printer", async () => {
    const btHub = btHubPrinter("bt-hub", true);
    const result = await printReceiptWithFallback({ printers: [btHub], escpos, browser: receipt });
    expect(result.channel).toBe("configured");
    expect(result.printer).toBe(btHub);
    expect(enqueueReceiptPrintJob).toHaveBeenCalledWith(btHub.id, { ...receipt, paperWidth: "80mm" });
    expect(printService.print).not.toHaveBeenCalled();
  });
});

describe("printReceiptWithFallback — native BLE (mobile app)", () => {
  beforeEach(() => {
    vi.mocked(printReceiptAuto).mockClear();
    vi.mocked(printService.print).mockClear();
    vi.mocked(enqueueReceiptPrintJob).mockClear();
    vi.mocked(printReceiptAuto).mockResolvedValue("native-bluetooth");
  });

  afterEach(() => {
    vi.mocked(isNativePlatform).mockReturnValue(false);
    vi.mocked(getNativeBluetoothPrinterName).mockReturnValue(null);
  });

  it("prints via native BLE first, skipping the configured printer, when a BLE printer is paired in the app", async () => {
    vi.mocked(isNativePlatform).mockReturnValue(true);
    vi.mocked(getNativeBluetoothPrinterName).mockReturnValue("PT-280");

    const result = await printReceiptWithFallback({
      printers: [printer("default-printer", true)],
      escpos,
      browser: receipt,
    });

    expect(result.channel).toBe("native-bluetooth");
    expect(printReceiptAuto).toHaveBeenCalledWith(escpos, receipt);
    // เครื่องพิมพ์หลัก (IP/Hub) ต้องไม่ถูกเรียก — ป้องกันอาการ "POS ปริ้นไม่ออก"
    expect(printService.print).not.toHaveBeenCalled();
    expect(enqueueReceiptPrintJob).not.toHaveBeenCalled();
  });

  it("autoPrintReceipt also prefers native BLE over the Hub printer in the app", async () => {
    vi.mocked(isNativePlatform).mockReturnValue(true);
    vi.mocked(getNativeBluetoothPrinterName).mockReturnValue("PT-280");

    const result = await autoPrintReceipt({
      printers: [btHubPrinter("bt-hub", true)],
      escpos,
      browser: receipt,
    });

    expect(result.channel).toBe("native-bluetooth");
    expect(printReceiptAuto).toHaveBeenCalledWith(escpos, receipt);
    expect(enqueueReceiptPrintJob).not.toHaveBeenCalled();
  });
});

describe("selectDefaultPrinter", () => {
  it("does not guess a printer when none is marked as default", () => {
    expect(selectDefaultPrinter([printer("first", false), printer("second", false)])).toBeNull();
  });

  it("prefers an explicitly selected printer over the default printer", () => {
    const defaultPrinter = printer("default-printer", true);
    const selectedPrinter = printer("selected-printer", false);

    expect(selectConfiguredPrinter([defaultPrinter, selectedPrinter], selectedPrinter.id)).toBe(selectedPrinter);
  });
});
