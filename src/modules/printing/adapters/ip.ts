import type { PrintAdapter, ReceiptData } from "../types";
import type { Printer } from "@/modules/stores/types";
import { buildReceiptPrinterBytes } from "../receipt-printer-bytes";

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.slice(i, i + chunkSize));
  }
  return btoa(binary);
}

// IP printing dispatches to a server-side route handler because TCP sockets
// are not available in browser context.
export const ipAdapter: PrintAdapter = {
  name: "ip",

  async isAvailable(): Promise<boolean> {
    return true; // Availability depends on server-side connectivity
  },

  async print(data: ReceiptData, printer: Printer): Promise<void> {
    if (!printer.id) throw new Error("ไม่ได้เลือกเครื่องพิมพ์จากการตั้งค่าร้าน");
    const printJobBase64 = bytesToBase64(buildReceiptPrinterBytes(data, data));

    const res = await fetch("/api/print/ip", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ receiptData: data, printerId: printer.id, printJobBase64 }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: string };
      throw new Error(body.error ?? `Print server error: ${res.status}`);
    }
  },
};
