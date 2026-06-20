import { beforeEach, describe, expect, it, vi } from "vitest";
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

import { printReceiptAuto } from "@/modules/printing/print-router";
import { printService } from "@/modules/printing/print-service";
import { ReceiptPrintFallbackError, printReceiptWithFallback, selectDefaultPrinter } from "@/modules/printing/receipt-printer";

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

describe("selectDefaultPrinter", () => {
  it("does not guess a printer when none is marked as default", () => {
    expect(selectDefaultPrinter([printer("first", false), printer("second", false)])).toBeNull();
  });
});
