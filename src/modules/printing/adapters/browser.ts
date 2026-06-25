import { normalizePrintCopies, type PrintAdapter, type ReceiptData } from "../types";
import type { Printer } from "@/modules/stores/types";
import { buildReceiptLines, type ReceiptLine } from "../receipt-lines";
import { renderReceiptQrSvg } from "../receipt-qr";

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

function renderReceiptLine(line: ReceiptLine, paperWidth: ReceiptData["paperWidth"]): string {
  if (line.qrPayload) {
    return `<div class="promptpay-qr">${renderReceiptQrSvg(line.qrPayload, paperWidth)}</div>`;
  }

  const classes = [
    "receipt-line",
    line.align === "center" ? "is-center" : "",
    line.bold ? "is-bold" : "",
  ].filter(Boolean).join(" ");
  return `<div class="${classes}">${escapeHtml(line.text) || "&nbsp;"}</div>`;
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
  const paperWidthCss = data.paperWidth === "58mm" ? "58mm" : "80mm";
  const { lines } = buildReceiptLines(data);
  const receiptContent = lines.map((line) => renderReceiptLine(line, data.paperWidth)).join("");
  const copies = normalizePrintCopies(data.printCopies);
  const receiptCopies = Array.from({ length: copies }, (_, index) => `
<section class="receipt-copy" aria-label="receipt copy ${index + 1}">
<div class="receipt-text">${receiptContent}</div>
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
  .receipt-text { font: 11px 'Courier New', Courier, monospace; }
  .receipt-line { min-height: 1.25em; white-space: pre-wrap; line-height: 1.25; }
  .receipt-line.is-center { text-align: center; }
  .receipt-line.is-bold { font-weight: 700; }
  .promptpay-qr { display: flex; justify-content: center; padding: 2mm 0 1mm; }
  .promptpay-qr-image { display: block; background: #fff; image-rendering: pixelated; }
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
