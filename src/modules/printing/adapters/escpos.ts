import type { PrintAdapter, ReceiptData } from "../types";
import type { Printer } from "@/modules/stores/types";
import { bytesToBase64 } from "../print-job-base64";
import { buildReceiptPrinterBytes } from "../receipt-printer-bytes";

export const escposAdapter: PrintAdapter = {
  name: "escpos",

  async isAvailable(): Promise<boolean> {
    return true;
  },

  async print(data: ReceiptData, printer: Printer): Promise<void> {
    if (!printer.id) {
      throw new Error("ESC/POS ต้องเลือกเครื่องพิมพ์จากการตั้งค่าร้าน");
    }
    const printJobBase64 = bytesToBase64(buildReceiptPrinterBytes(data, data));

    const res = await fetch("/api/print/ip", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ receiptData: data, printerId: printer.id, printJobBase64 }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: string };
      throw new Error(body.error ?? `ESC/POS print server error: ${res.status}`);
    }
  },
};
