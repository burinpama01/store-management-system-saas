import { describe, expect, it, vi } from "vitest";
import type { Printer } from "@/modules/stores/types";
import type { ReceiptData } from "@/modules/printing/types";
import {
  DEFAULT_LOCAL_PRINT_BRIDGE_URL,
  sendNetworkPrintJob,
  shouldUseLocalPrintBridge,
} from "@/modules/printing/network-print-client";

const printer: Printer = {
  id: "printer-1",
  storeId: "store-1",
  organizationId: "org-1",
  name: "Counter WiFi",
  type: "ip",
  isDefault: true,
  ipAddress: "192.168.1.40",
  port: 9100,
  paperWidth: "80mm",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const receiptData: ReceiptData = {
  storeName: "each other II",
  showTaxId: false,
  orderNumber: "TEST-1",
  items: [{ name: "Coffee", quantity: 1, unitPrice: 80, totalPrice: 80, modifierNames: [] }],
  subtotal: 80,
  discount: 0,
  total: 80,
  payments: [{ method: "cash", amount: 80 }],
  paymentStatus: "paid",
  showQrPayment: false,
  paperWidth: "80mm",
  printedAt: "2026-01-01T00:00:00.000Z",
};

describe("network print client", () => {
  it("routes cloud-hosted WiFi printer jobs through the local print bridge", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true }),
    });

    await sendNetworkPrintJob(printer, {
      printerId: printer.id,
      receiptData,
      printJobBase64: "AQID",
    }, {
      fetcher,
      hostname: "store-os-manage.vercel.app",
    });

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(`${DEFAULT_LOCAL_PRINT_BRIDGE_URL}/print`, expect.objectContaining({
      method: "POST",
      headers: { "Content-Type": "application/json" },
    }));
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({
      host: "192.168.1.40",
      port: 9100,
      printJobBase64: "AQID",
    });
  });

  it("keeps local/self-hosted app servers on the existing server route", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true }),
    });

    await sendNetworkPrintJob(printer, {
      printerId: printer.id,
      receiptData,
      printJobBase64: "AQID",
    }, {
      fetcher,
      hostname: "localhost",
    });

    expect(fetcher).toHaveBeenCalledWith("/api/print/ip", expect.objectContaining({
      method: "POST",
    }));
  });

  it("explains that cloud WiFi printing needs the StoreOS Print Bridge", async () => {
    const fetcher = vi.fn().mockRejectedValue(new TypeError("fetch failed"));

    await expect(sendNetworkPrintJob(printer, {
      printerId: printer.id,
      receiptData,
      printJobBase64: "AQID",
    }, {
      fetcher,
      hostname: "store-os-manage.vercel.app",
    })).rejects.toThrow("StoreOS Print Bridge");
  });

  it("uses a local bridge for public hostnames only", () => {
    expect(shouldUseLocalPrintBridge("store-os-manage.vercel.app")).toBe(true);
    expect(shouldUseLocalPrintBridge("localhost")).toBe(false);
    expect(shouldUseLocalPrintBridge("127.0.0.1")).toBe(false);
    expect(shouldUseLocalPrintBridge("192.168.1.25")).toBe(false);
  });
});
