// ESC/POS command builder for 58mm/80mm thermal receipt printers

// Control bytes
const ESC = 0x1b;
const GS = 0x1d;
const LF = 0x0a;
const HT = 0x09; // Horizontal tab

// ─── Commands ───────────────────────────────────────────────────────

export const CMD = {
  INIT: [ESC, 0x40],
  LF: [LF],
  CUT: [GS, 0x56, 0x41, 3],          // Partial cut with 3-line feed
  ALIGN_LEFT: [ESC, 0x61, 0],
  ALIGN_CENTER: [ESC, 0x61, 1],
  ALIGN_RIGHT: [ESC, 0x61, 2],
  BOLD_ON: [ESC, 0x45, 1],
  BOLD_OFF: [ESC, 0x45, 0],
  UNDERLINE_ON: [ESC, 0x2d, 1],
  UNDERLINE_OFF: [ESC, 0x2d, 0],
  DOUBLE_HEIGHT: [GS, 0x21, 0x01],   // Double height only
  DOUBLE_BOTH: [GS, 0x21, 0x11],     // Double height + width
  NORMAL_SIZE: [GS, 0x21, 0x00],
  // Thai code page (CP874 / TIS-620): ESC t 21
  CODEPAGE_THAI: [ESC, 0x74, 21],
  // Standard code page (UTF-8 compatible on modern printers): ESC t 0
  CODEPAGE_PC437: [ESC, 0x74, 0],
  HT: [HT],
  // Tab stops: ESC D — sets tab stops at specified column positions
  TAB_STOPS_58MM: [ESC, 0x44, 24, 0],   // 58mm: tab at col 24
  TAB_STOPS_80MM: [ESC, 0x44, 32, 0],   // 80mm: tab at col 32
} as const;

// ─── Text encoding ───────────────────────────────────────────────────

function encodeText(text: string): number[] {
  // Use TextEncoder for UTF-8; modern Star/Epson printers support UTF-8 with ESC t 0
  const encoder = new TextEncoder();
  return Array.from(encoder.encode(text));
}

// ─── Column widths ───────────────────────────────────────────────────

const COLUMNS: Record<"58mm" | "80mm", number> = { "58mm": 32, "80mm": 42 };

function padRight(text: string, width: number): string {
  return text.length >= width ? text.slice(0, width) : text + " ".repeat(width - text.length);
}

function padLeft(text: string, width: number): string {
  return text.length >= width ? text.slice(0, width) : " ".repeat(width - text.length) + text;
}

function divider(paperWidth: "58mm" | "80mm", char = "-"): number[] {
  return encodeText(char.repeat(COLUMNS[paperWidth]) + "\n");
}

// ─── Receipt line builders ───────────────────────────────────────────

interface LineItem {
  name: string;
  variantName?: string;
  modifierNames: string[];
  quantity: number;
  totalPrice: number;
  discount?: number;
  discountNote?: string;
  note?: string;
}

function formatPrice(amount: number): string {
  return amount.toFixed(2);
}

function itemLine(item: LineItem, paperWidth: "58mm" | "80mm"): number[] {
  const cols = COLUMNS[paperWidth];
  const priceStr = formatPrice(item.totalPrice);
  const qtyLabel = `x${item.quantity}`;
  // Name column: total width minus price (8) and qty (4)
  const nameWidth = cols - priceStr.length - qtyLabel.length - 2;
  const displayName = item.variantName ? `${item.name} (${item.variantName})` : item.name;
  const line = padRight(displayName, nameWidth) + " " + qtyLabel + " " + padLeft(priceStr, priceStr.length) + "\n";
  const result: number[] = encodeText(line);
  if (item.modifierNames.length > 0) {
    result.push(...encodeText(`  + ${item.modifierNames.join(", ")}\n`));
  }
  if (item.note) {
    result.push(...encodeText(`  * ${item.note}\n`));
  }
  if ((item.discount ?? 0) > 0) {
    const label = item.discountNote ? `Discount item (${item.discountNote})` : "Discount item";
    result.push(...encodeText(`  ${label}: -${formatPrice(item.discount ?? 0)}\n`));
  }
  return result;
}

function summaryLine(label: string, value: string, paperWidth: "58mm" | "80mm"): number[] {
  const cols = COLUMNS[paperWidth];
  const line = padRight(label, cols - value.length) + value + "\n";
  return encodeText(line);
}

// ─── Full receipt builder ────────────────────────────────────────────

export interface EscPosReceiptInput {
  storeName: string;
  address?: string;
  phone?: string;
  headerText?: string;
  orderNumber: string;
  tableNumber?: string;
  items: LineItem[];
  subtotal: number;
  discount: number;
  discountNote?: string;
  total: number;
  payments: { method: string; amount: number; receivedAmount?: number; changeAmount?: number }[];
  footerText?: string;
  paperWidth: "58mm" | "80mm";
  printedAt: string;
}

export function buildEscPosReceipt(receipt: EscPosReceiptInput): Uint8Array {
  const { paperWidth } = receipt;
  const bytes: number[] = [];

  const push = (...cmds: (readonly number[] | readonly (readonly number[])[])[]) => {
    for (const c of cmds) {
      if (typeof c[0] === "number") bytes.push(...(c as readonly number[]));
      else for (const sub of c as readonly (readonly number[])[]) bytes.push(...sub);
    }
  };

  // Init + code page
  push(CMD.INIT, CMD.CODEPAGE_THAI);

  // Store name (centered, double height)
  push(CMD.ALIGN_CENTER, CMD.BOLD_ON, CMD.DOUBLE_HEIGHT);
  push(encodeText(receipt.storeName + "\n"));
  push(CMD.NORMAL_SIZE, CMD.BOLD_OFF);

  // Address / phone
  if (receipt.address) push(encodeText(receipt.address + "\n"));
  if (receipt.phone) push(encodeText("Tel: " + receipt.phone + "\n"));
  if (receipt.headerText) push(encodeText(receipt.headerText + "\n"));

  push(CMD.ALIGN_LEFT);
  push(divider(paperWidth));

  // Order meta
  push(encodeText(`Order: ${receipt.orderNumber}\n`));
  if (receipt.tableNumber) push(encodeText(`Table: ${receipt.tableNumber}\n`));
  const dateStr = new Date(receipt.printedAt).toLocaleString("th-TH", {
    year: "2-digit", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  });
  push(encodeText(`Date: ${dateStr}\n`));
  push(divider(paperWidth));

  // Items
  for (const item of receipt.items) {
    push(itemLine(item, paperWidth));
  }
  push(divider(paperWidth));

  // Totals
  push(summaryLine("Subtotal", formatPrice(receipt.subtotal), paperWidth));
  if (receipt.discount > 0) {
    const discountLabel = receipt.discountNote ? `Discount (${receipt.discountNote})` : "Discount";
    push(summaryLine(discountLabel, `-${formatPrice(receipt.discount)}`, paperWidth));
  }
  push(CMD.BOLD_ON);
  push(summaryLine("TOTAL", formatPrice(receipt.total), paperWidth));
  push(CMD.BOLD_OFF);

  // Payments
  for (const payment of receipt.payments) {
    const methodLabel: Record<string, string> = {
      cash: "Cash", qr_promptpay: "QR PromptPay",
      credit_card: "Card", bank_transfer: "Transfer", other: "Other",
    };
    const displayAmount = payment.method === "cash" && payment.receivedAmount !== undefined ? payment.receivedAmount : payment.amount;
    push(summaryLine(methodLabel[payment.method] ?? payment.method, formatPrice(displayAmount), paperWidth));
    if (payment.method !== "cash" && payment.receivedAmount !== undefined) {
      push(summaryLine("  Received", formatPrice(payment.receivedAmount), paperWidth));
    }
    if (payment.changeAmount !== undefined && payment.changeAmount > 0) {
      push(summaryLine("  Change", formatPrice(payment.changeAmount), paperWidth));
    }
  }

  // Footer
  if (receipt.footerText) {
    push(divider(paperWidth));
    push(CMD.ALIGN_CENTER);
    push(encodeText(receipt.footerText + "\n"));
    push(CMD.ALIGN_LEFT);
  }

  // Feed and cut
  push(CMD.LF, CMD.LF, CMD.LF, CMD.CUT);

  return new Uint8Array(bytes);
}
