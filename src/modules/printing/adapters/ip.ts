import type { PrintAdapter, ReceiptData } from "../types";
import type { Printer } from "@/modules/stores/types";

// IP printing dispatches to a server-side route handler because TCP sockets
// are not available in browser context.
export const ipAdapter: PrintAdapter = {
  name: "ip",

  async isAvailable(): Promise<boolean> {
    return true; // Availability depends on server-side connectivity
  },

  async print(data: ReceiptData, printer: Printer): Promise<void> {
    if (!printer.id) throw new Error("ไม่ได้เลือกเครื่องพิมพ์จากการตั้งค่าร้าน");

    const res = await fetch("/api/print/ip", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ receiptData: data, printerId: printer.id }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: string };
      throw new Error(body.error ?? `Print server error: ${res.status}`);
    }
  },
};
