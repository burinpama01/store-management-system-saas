import { normalizePrintCopies, type PrintAdapter, type ReceiptData } from "../types";
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

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function receiptFileName(data: ReceiptData): string {
  const safeOrder = data.orderNumber.replace(/[^a-zA-Z0-9_-]/g, "-") || "receipt";
  return `storeos-receipt-${safeOrder}.html`;
}

function buildReceiptBlob(html: string): Blob {
  return new Blob([html], { type: "text/html;charset=utf-8" });
}

async function fallbackReceiptDownload(data: ReceiptData, html: string): Promise<void> {
  if (typeof window === "undefined" || typeof document === "undefined") {
    throw new Error("ไม่สามารถสร้างไฟล์ใบเสร็จสำรองใน environment นี้");
  }

  const filename = receiptFileName(data);
  const blob = buildReceiptBlob(html);

  if (typeof File !== "undefined" && navigator.share) {
    const file = new File([blob], filename, { type: "text/html" });
    const payload = { files: [file], title: `ใบเสร็จ ${data.orderNumber}`, text: data.storeName };
    const canShare = navigator.canShare?.(payload) ?? true;
    if (canShare) {
      try {
        await navigator.share(payload);
        return;
      } catch (error) {
        const name = error && typeof error === "object" && "name" in error ? String(error.name) : "";
        if (name === "AbortError") {
          throw new Error("ยกเลิกการแชร์ใบเสร็จ");
        }
      }
    }
  }

  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
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
    if ((item.discount ?? 0) > 0) {
      const label = item.discountNote ? `ส่วนลดรายการ (${item.discountNote})` : "ส่วนลดรายการ";
      lines.push(`  ${label}: -${priceStr(item.discount ?? 0)}`);
    }
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
    const displayAmount = p.method === "cash" && p.receivedAmount !== undefined ? p.receivedAmount : p.amount;
    lines.push(padLine(methodMap[p.method] ?? p.method, priceStr(displayAmount), cols));
    if (p.method !== "cash" && p.receivedAmount !== undefined) lines.push(padLine("  รับเงิน", priceStr(p.receivedAmount), cols));
    if (p.changeAmount !== undefined && p.changeAmount > 0) lines.push(padLine("  เงินทอน", priceStr(p.changeAmount), cols));
  }

  if (data.footerText) {
    lines.push(div);
    lines.push(data.footerText);
  }

  const paperWidthCss = data.paperWidth === "58mm" ? "58mm" : "80mm";
  const receiptText = lines.map((line) => escapeHtml(line)).join("\n");
  const copies = normalizePrintCopies(data.printCopies);
  const receiptCopies = Array.from({ length: copies }, (_, index) => `
<section class="receipt-copy" aria-label="receipt copy ${index + 1}">
<pre>${receiptText}</pre>
</section>`).join("");
  const filename = receiptFileName(data);

  return `<!DOCTYPE html>
<html lang="th">
<head>
<meta charset="UTF-8">
<title>Receipt ${escapeHtml(data.orderNumber)}</title>
<style>
  @page { margin: 0; size: ${paperWidthCss} auto; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #f7f4ef; color: #171412; font-family: Arial, sans-serif; }
  .print-actions { position: sticky; top: 0; display: flex; gap: 8px; padding: 10px; background: #fff; border-bottom: 1px solid #eaded2; }
  .print-actions button { min-height: 38px; border: 1px solid #c95f36; border-radius: 8px; background: #c95f36; color: #fff; font-weight: 700; padding: 0 12px; }
  .print-actions button.secondary { background: #fff; color: #7c341a; }
  .receipt-copy { width: ${paperWidthCss}; padding: 4mm 2mm; background: #fff; }
  .receipt-copy + .receipt-copy { break-before: page; page-break-before: always; margin-top: 8mm; }
  pre { margin: 0; white-space: pre-wrap; font: 11px 'Courier New', Courier, monospace; }
  @media print {
    body { background: #fff; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .print-actions { display: none; }
    .receipt-copy { margin: 0; }
  }
</style>
</head>
<body>
<div class="print-actions">
  <button type="button" onclick="window.print()">พิมพ์</button>
  <button type="button" class="secondary" onclick="downloadReceipt()">ดาวน์โหลด</button>
</div>
${receiptCopies}
<script>
function downloadReceipt() {
  var blob = new Blob([document.documentElement.outerHTML], { type: "text/html;charset=utf-8" });
  var url = URL.createObjectURL(blob);
  var link = document.createElement("a");
  link.href = url;
  link.download = ${JSON.stringify(filename)};
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
}
</script>
</body>
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
    if (!win) {
      try {
        await fallbackReceiptDownload(data, html);
        return;
      } catch (error) {
        const reason = error instanceof Error ? error.message : "ไม่ทราบสาเหตุ";
        throw new Error(`เบราว์เซอร์บล็อกหน้าต่างพิมพ์ และสร้างไฟล์ใบเสร็จสำรองไม่สำเร็จ: ${reason}`);
      }
    }
    win.document.write(html);
    win.document.close();
    win.focus();
    win.print();
    // Close after print dialog dismisses (non-blocking)
    win.addEventListener("afterprint", () => win.close());
  },
};
