import type { PrintAdapter, ReceiptData } from "../types";
import type { Printer } from "@/modules/stores/types";

// Column characters per paper width for browser rendering
const CHAR_WIDTH: Record<"58mm" | "80mm", number> = { "58mm": 32, "80mm": 42 };

function priceStr(n: number): string {
  return n.toFixed(2);
}

function padLine(label: string, value: string, width: number): string {
  const gap = width - label.length - value.length;
  return label + (gap > 0 ? " ".repeat(gap) : " ") + value;
}

function buildReceiptHtml(data: ReceiptData): string {
  const cols = CHAR_WIDTH[data.paperWidth];
  const div = "-".repeat(cols);
  const lines: string[] = [];

  lines.push(data.storeName);
  if (data.address) lines.push(data.address);
  if (data.phone) lines.push(`โทร: ${data.phone}`);
  if (data.showTaxId && data.taxId) lines.push(`เลขประจำตัวผู้เสียภาษี: ${data.taxId}`);
  if (data.headerText) lines.push(data.headerText);
  lines.push(div);
  lines.push(`ออร์เดอร์: ${data.orderNumber}`);
  if (data.tableNumber) lines.push(`โต๊ะ: ${data.tableNumber}`);
  lines.push(
    new Date(data.printedAt).toLocaleString("th-TH", {
      year: "2-digit", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit",
    }),
  );
  lines.push(div);

  for (const item of data.items) {
    const displayName = item.variantName ? `${item.name} (${item.variantName})` : item.name;
    const priceField = `x${item.quantity} ${priceStr(item.totalPrice)}`;
    const nameWidth = cols - priceField.length - 1;
    const name = displayName.length > nameWidth ? displayName.slice(0, nameWidth - 1) + "…" : displayName.padEnd(nameWidth);
    lines.push(`${name} ${priceField}`);
    if (item.modifierNames.length > 0) lines.push(`  + ${item.modifierNames.join(", ")}`);
    if (item.note) lines.push(`  * ${item.note}`);
  }

  lines.push(div);
  lines.push(padLine("ยอดรวมย่อย", priceStr(data.subtotal), cols));
  if (data.discount > 0) {
    const label = data.discountNote ? `ส่วนลด (${data.discountNote})` : "ส่วนลด";
    lines.push(padLine(label, `-${priceStr(data.discount)}`, cols));
  }
  lines.push(padLine("** รวมสุทธิ **", priceStr(data.total), cols));

  for (const p of data.payments) {
    const methodMap: Record<string, string> = {
      cash: "เงินสด", qr_promptpay: "QR PromptPay",
      credit_card: "บัตร", bank_transfer: "โอนเงิน", other: "อื่น ๆ",
    };
    lines.push(padLine(methodMap[p.method] ?? p.method, priceStr(p.amount), cols));
    if (p.receivedAmount !== undefined) lines.push(padLine("  รับเงิน", priceStr(p.receivedAmount), cols));
    if (p.changeAmount !== undefined && p.changeAmount > 0) lines.push(padLine("  เงินทอน", priceStr(p.changeAmount), cols));
  }

  if (data.footerText) {
    lines.push(div);
    lines.push(data.footerText);
  }

  const paperWidthCss = data.paperWidth === "58mm" ? "58mm" : "80mm";

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  @page { margin: 0; size: ${paperWidthCss} auto; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'Courier New', Courier, monospace; font-size: 11px; width: ${paperWidthCss}; padding: 4mm 2mm; white-space: pre; }
  @media print { body { -webkit-print-color-adjust: exact; } }
</style>
</head>
<body>${lines.map((l) => l.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")).join("\n")}</body>
</html>`;
}

export const browserAdapter: PrintAdapter = {
  name: "browser",

  async isAvailable(): Promise<boolean> {
    return typeof window !== "undefined";
  },

  async print(data: ReceiptData, printer: Printer): Promise<void> {
    void printer;
    const html = buildReceiptHtml(data);
    const win = window.open("", "_blank", "width=400,height=600");
    if (!win) throw new Error("เบราว์เซอร์บล็อกหน้าต่างพิมพ์ กรุณาอนุญาต pop-up สำหรับหน้านี้");
    win.document.write(html);
    win.document.close();
    win.focus();
    win.print();
    // Close after print dialog dismisses (non-blocking)
    win.addEventListener("afterprint", () => win.close());
  },
};
