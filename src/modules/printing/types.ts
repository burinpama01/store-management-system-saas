import type { Printer, ReceiptSettings } from "@/modules/stores/types";
import type { Order } from "@/modules/pos/types";
import type { DiscountType } from "@/modules/pos/types";

export type { Printer, ReceiptSettings };

export interface ReceiptLineItem {
  name: string;
  variantName?: string;
  modifierNames: string[];
  quantity: number;
  unitPrice: number;
  totalPrice: number;
  discount?: number;
  discountType?: DiscountType;
  discountValue?: number;
  discountNote?: string;
  note?: string;
}

export interface ReceiptPayment {
  method: string;
  amount: number;
  receivedAmount?: number;
  changeAmount?: number;
}

export interface ReceiptData {
  storeName: string;
  address?: string;
  phone?: string;
  taxId?: string;
  showTaxId: boolean;
  orderNumber: string;
  tableNumber?: string;
  items: ReceiptLineItem[];
  subtotal: number;
  discount: number;
  discountNote?: string;
  total: number;
  payments: ReceiptPayment[];
  paymentStatus?: "unpaid" | "paid";
  loyaltyPointsEarned?: number;
  loyaltyPointsBalance?: number;
  footerText?: string;
  showQrPayment: boolean;
  promptpayId?: string;
  headerText?: string;
  logoUrl?: string;
  footerImageUrl?: string;
  /** "receipt" (default) = full bill; "kitchen" = station prep ticket (no prices);
   *  "table_qr" = a table-open slip with the customer ordering QR. */
  ticketMode?: "receipt" | "kitchen" | "table_qr";
  /** Station label shown at the top of a kitchen ticket (e.g. "ครัวร้อน", "บาร์น้ำ"). */
  stationName?: string;
  /** table_qr slip: the customer ordering URL rendered as a scannable QR. */
  tableQrPayload?: string;
  /** table_qr slip: ISO time the table session is valid until (shown on the slip). */
  tableValidUntil?: string;
  paperWidth: "58mm" | "80mm";
  printCopies?: number;
  printedAt: string;
}

export function normalizePrintCopies(printCopies?: number): number {
  if (!Number.isFinite(printCopies)) return 1;
  return Math.min(5, Math.max(1, Math.floor(printCopies ?? 1)));
}

export interface PrintAdapter {
  readonly name: string;
  isAvailable(): Promise<boolean>;
  print(data: ReceiptData, printer: Printer): Promise<void>;
}

export function buildReceiptData(
  order: Order,
  settings: ReceiptSettings,
): ReceiptData {
  const loyaltyPointsEarned =
    order.customerId && typeof order.loyaltyPointsEarned === "number" && order.loyaltyPointsEarned > 0
      ? order.loyaltyPointsEarned
      : undefined;
  return {
    storeName: settings.storeName,
    address: settings.address,
    phone: settings.phone,
    taxId: settings.taxId,
    showTaxId: settings.showTaxId,
    orderNumber: order.orderNumber,
    tableNumber: order.tableNumber,
    items: order.items.map((item) => ({
      name: item.productName,
      variantName: item.variantName,
      modifierNames: item.modifiers.map((m) => m.option.name),
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      totalPrice: item.totalPrice,
      discount: item.discount,
      discountType: item.discountType,
      discountValue: item.discountValue,
      discountNote: item.discountNote,
      note: item.note,
    })),
    subtotal: order.subtotal,
    discount: order.discount,
    discountNote: order.discountNote,
    total: order.total,
    payments: order.payments.map((p) => ({
      method: p.method,
      amount: p.amount,
      receivedAmount: p.receivedAmount,
      changeAmount: p.changeAmount,
    })),
    paymentStatus: "paid",
    loyaltyPointsEarned,
    loyaltyPointsBalance: loyaltyPointsEarned !== undefined ? order.loyaltyPointsBalance : undefined,
    footerText: settings.footerText,
    showQrPayment: settings.showQrPayment,
    promptpayId: settings.promptpayId,
    headerText: settings.headerText,
    logoUrl: settings.logoUrl,
    footerImageUrl: settings.footerImageUrl,
    paperWidth: settings.paperWidth,
    printCopies: normalizePrintCopies(settings.printCopies),
    printedAt: new Date().toISOString(),
  };
}
