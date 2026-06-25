import type { PrintAdapter, ReceiptData } from "../types";
import type { Printer } from "@/modules/stores/types";
import { bytesToBase64 } from "../print-job-base64";
import { buildReceiptPrinterBytes } from "../receipt-printer-bytes";
import { sendNetworkPrintJob } from "../network-print-client";

// Browser TCP is unavailable, so public hosts use the local print bridge while
// localhost/self-hosted deployments can still use the server-side route.
export const ipAdapter: PrintAdapter = {
  name: "ip",

  async isAvailable(): Promise<boolean> {
    return true; // Availability depends on server-side connectivity
  },

  async print(data: ReceiptData, printer: Printer): Promise<void> {
    if (!printer.id) throw new Error("ไม่ได้เลือกเครื่องพิมพ์จากการตั้งค่าร้าน");
    const printJobBase64 = bytesToBase64(buildReceiptPrinterBytes(data, data));
    await sendNetworkPrintJob(printer, { receiptData: data, printerId: printer.id, printJobBase64 });
  },
};
