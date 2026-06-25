import type { PrintAdapter, ReceiptData } from "../types";
import type { Printer } from "@/modules/stores/types";
import { bytesToBase64 } from "../print-job-base64";
import { buildReceiptPrinterBytes } from "../receipt-printer-bytes";
import { sendNetworkPrintJob } from "../network-print-client";

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
    await sendNetworkPrintJob(printer, { receiptData: data, printerId: printer.id, printJobBase64 });
  },
};
