import type { ReceiptData } from "./types";

export interface TableQrSlipInput {
  storeName: string;
  tableLabel: string;
  /** Customer ordering URL to render as a scannable QR. */
  qrPayload: string;
  /** ISO time the table session is valid until (optional). */
  validUntil?: string | null;
  paperWidth?: "58mm" | "80mm";
  logoUrl?: string | null;
}

/**
 * Builds a minimal receipt whose only job is to print a table-open slip with the
 * customer ordering QR. Rendered through the normal raster pipeline (ticketMode
 * "table_qr"), so it prints on a thermal printer via the Print Hub (iPad-safe).
 */
export function buildTableQrReceiptData(input: TableQrSlipInput): ReceiptData {
  return {
    storeName: input.storeName,
    showTaxId: false,
    orderNumber: "TABLE-QR",
    tableNumber: input.tableLabel,
    items: [],
    subtotal: 0,
    discount: 0,
    total: 0,
    payments: [],
    showQrPayment: false,
    logoUrl: input.logoUrl ?? undefined,
    paperWidth: input.paperWidth ?? "80mm",
    printedAt: new Date().toISOString(),
    ticketMode: "table_qr",
    tableQrPayload: input.qrPayload,
    tableValidUntil: input.validUntil ?? undefined,
  };
}
