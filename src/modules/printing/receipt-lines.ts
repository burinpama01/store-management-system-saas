import type { ReceiptData } from "./types";
import { buildReceiptPromptPayQr } from "./receipt-qr";

// Characters per row for each paper width (monospace layout).
export const RECEIPT_COLS: Record<"58mm" | "80mm", number> = { "58mm": 32, "80mm": 42 };

function priceStr(n: number): string {
  return n.toFixed(2);
}

function pointsStr(n: number): string {
  return new Intl.NumberFormat("th-TH", { maximumFractionDigits: 0 }).format(n);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function padLine(label: string, value: string, width: number): string {
  const gap = width - label.length - value.length;
  return label + (gap > 0 ? " ".repeat(gap) : " ") + value;
}

const TRAILING_GRAPHEME_PART_RE = /^(?:\p{Mark}|\u0E33)$/u;

function fallbackGraphemes(text: string): string[] {
  const graphemes: string[] = [];
  for (const char of Array.from(text)) {
    if (TRAILING_GRAPHEME_PART_RE.test(char) && graphemes.length > 0) {
      graphemes[graphemes.length - 1] += char;
    } else {
      graphemes.push(char);
    }
  }
  return graphemes;
}

function wrapText(text: string, width: number): string[] {
  const max = Math.max(1, width);
  const paragraphs = text.replace(/\r\n/g, "\n").split("\n");
  const wrapped: string[] = [];
  const segmenter =
    typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
      ? new Intl.Segmenter("th", { granularity: "grapheme" })
      : null;
  for (const paragraph of paragraphs) {
    const chars = segmenter
      ? Array.from(segmenter.segment(paragraph), (part) => part.segment)
      : fallbackGraphemes(paragraph);
    if (chars.length === 0) {
      wrapped.push("");
      continue;
    }
    let current = "";
    for (const char of chars) {
      if (current && current.length + char.length > max) {
        wrapped.push(current);
        current = char;
      } else {
        current += char;
      }
    }
    if (current) {
      wrapped.push(current);
    }
  }
  return wrapped;
}

function pushWrapped(
  lines: ReceiptLine[],
  text: string | undefined,
  cols: number,
  options: Pick<ReceiptLine, "align" | "bold"> = {},
) {
  if (!text) return;
  for (const line of wrapText(text, cols)) {
    lines.push({ text: line, ...options });
  }
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
  qrPayload?: string;
  qrAmount?: number;
}

export function buildReceiptLines(data: ReceiptData): { lines: ReceiptLine[]; cols: number } {
  const cols = RECEIPT_COLS[data.paperWidth];
  const div = "-".repeat(cols);
  const lines: ReceiptLine[] = [];

  lines.push({ text: data.storeName, align: "center", bold: true });
  if (data.address) lines.push({ text: data.address, align: "center" });
  if (data.phone) lines.push({ text: `โทร: ${data.phone}`, align: "center" });
  if (data.showTaxId && data.taxId) lines.push({ text: `เลขผู้เสียภาษี: ${data.taxId}`, align: "center" });
  pushWrapped(lines, data.headerText, cols, { align: "center" });
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

  const earnedPoints = data.loyaltyPointsEarned;
  const hasEarnedPoints = isFiniteNumber(earnedPoints) && earnedPoints > 0;
  const balancePoints = hasEarnedPoints ? data.loyaltyPointsBalance : undefined;
  const hasBalancePoints = isFiniteNumber(balancePoints);
  if (hasEarnedPoints || hasBalancePoints) {
    lines.push({ text: div });
    lines.push({ text: "สะสมแต้ม", align: "center", bold: true });
    if (hasEarnedPoints) {
      lines.push({ text: padLine("แต้มที่ได้รับ", `+${pointsStr(earnedPoints)}`, cols) });
    }
    if (hasBalancePoints) {
      lines.push({ text: padLine("แต้มคงเหลือ", pointsStr(balancePoints), cols) });
    }
  }

  const promptPayQr = buildReceiptPromptPayQr(data);
  if (promptPayQr) {
    lines.push({ text: div });
    lines.push({ text: "QR PromptPay ล็อกยอด", align: "center", bold: true });
    lines.push({ text: `ยอดชำระ ${priceStr(promptPayQr.amount)} บาท`, align: "center" });
    lines.push({
      text: "",
      align: "center",
      qrPayload: promptPayQr.payload,
      qrAmount: promptPayQr.amount,
    });
  }

  if (data.footerText) {
    lines.push({ text: div });
    pushWrapped(lines, data.footerText, cols, { align: "center" });
  }

  return { lines, cols };
}
