import type { ReceiptData } from "./types";

// Characters per row for each paper width (monospace layout).
export const RECEIPT_COLS: Record<"58mm" | "80mm", number> = { "58mm": 32, "80mm": 42 };

function priceStr(n: number): string {
  return n.toFixed(2);
}

function padLine(label: string, value: string, width: number): string {
  const gap = width - label.length - value.length;
  return label + (gap > 0 ? " ".repeat(gap) : " ") + value;
}

const METHOD_LABELS: Record<string, string> = {
  cash: "เงินสด",
  qr_promptpay: "QR PromptPay",
  credit_card: "บัตร",
  bank_transfer: "โอนเงิน",
  other: "อื่น ๆ",
};

/**
 * Canonical plain-text receipt lines — single source of truth shared by the
 * browser (HTML) and the image/raster ESC/POS renderer. Each entry is one line;
 * `align` hints centering for the raster renderer (browser uses left + pre).
 */
export interface ReceiptLine {
  text: string;
  align?: "left" | "center";
  bold?: boolean;
}

export function buildReceiptLines(data: ReceiptData): { lines: ReceiptLine[]; cols: number } {
  const cols = RECEIPT_COLS[data.paperWidth];
  const div = "-".repeat(cols);
  const lines: ReceiptLine[] = [];

  lines.push({ text: data.storeName, align: "center", bold: true });
  if (data.address) lines.push({ text: data.address, align: "center" });
  if (data.phone) lines.push({ text: `โทร: ${data.phone}`, align: "center" });
  if (data.showTaxId && data.taxId) lines.push({ text: `เลขผู้เสียภาษี: ${data.taxId}`, align: "center" });
  if (data.headerText) lines.push({ text: data.headerText, align: "center" });
  lines.push({ text: div });
  lines.push({ text: `ออร์เดอร์: ${data.orderNumber}` });
  if (data.tableNumber) lines.push({ text: `โต๊ะ: ${data.tableNumber}` });
  lines.push({
    text: new Date(data.printedAt).toLocaleString("th-TH", {
      year: "2-digit", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    }),
  });
  lines.push({ text: div });

  for (const item of data.items) {
    const displayName = item.variantName ? `${item.name} (${item.variantName})` : item.name;
    const priceField = `x${item.quantity} ${priceStr(item.totalPrice)}`;
    const nameWidth = cols - priceField.length - 1;
    const name =
      displayName.length > nameWidth ? displayName.slice(0, nameWidth - 1) + "…" : displayName.padEnd(nameWidth);
    lines.push({ text: `${name} ${priceField}` });
    if (item.modifierNames.length > 0) lines.push({ text: `  + ${item.modifierNames.join(", ")}` });
    if (item.note) lines.push({ text: `  * ${item.note}` });
    if ((item.discount ?? 0) > 0) {
      const label = item.discountNote ? `ส่วนลดรายการ (${item.discountNote})` : "ส่วนลดรายการ";
      lines.push({ text: `  ${label}: -${priceStr(item.discount ?? 0)}` });
    }
  }

  lines.push({ text: div });
  lines.push({ text: padLine("ยอดรวมย่อย", priceStr(data.subtotal), cols) });
  if (data.discount > 0) {
    const label = data.discountNote ? `ส่วนลด (${data.discountNote})` : "ส่วนลด";
    lines.push({ text: padLine(label, `-${priceStr(data.discount)}`, cols) });
  }
  lines.push({ text: padLine("** รวมสุทธิ **", priceStr(data.total), cols), bold: true });

  for (const p of data.payments) {
    const displayAmount = p.method === "cash" && p.receivedAmount !== undefined ? p.receivedAmount : p.amount;
    lines.push({ text: padLine(METHOD_LABELS[p.method] ?? p.method, priceStr(displayAmount), cols) });
    if (p.method !== "cash" && p.receivedAmount !== undefined) {
      lines.push({ text: padLine("  รับเงิน", priceStr(p.receivedAmount), cols) });
    }
    if (p.changeAmount !== undefined && p.changeAmount > 0) {
      lines.push({ text: padLine("  เงินทอน", priceStr(p.changeAmount), cols) });
    }
  }

  if (data.footerText) {
    lines.push({ text: div });
    lines.push({ text: data.footerText, align: "center" });
  }

  return { lines, cols };
}
