import QRCode from "qrcode";
import { buildPromptPayPayload } from "./promptpay-qr";
import type { ReceiptData } from "./types";

const QUIET_MODULES = 4;
const MAX_QR_DOTS: Record<"58mm" | "80mm", number> = { "58mm": 192, "80mm": 224 };

export interface ReceiptPromptPayQr {
  payload: string;
  amount: number;
}

export interface ReceiptQrMatrix {
  size: number;
  isDark(row: number, col: number): boolean;
}

export interface ReceiptQrMetrics {
  matrix: ReceiptQrMatrix;
  quietModules: number;
  cellDots: number;
  drawDots: number;
}

export function buildReceiptPromptPayQr(data: ReceiptData): ReceiptPromptPayQr | null {
  if (data.paymentStatus !== "unpaid" || !data.showQrPayment || !data.promptpayId || data.total <= 0) return null;
  return {
    amount: data.total,
    payload: buildPromptPayPayload({ recipientId: data.promptpayId, amount: data.total }),
  };
}

export function createReceiptQrMatrix(payload: string): ReceiptQrMatrix {
  const qr = QRCode.create(payload, { errorCorrectionLevel: "M" });
  return {
    size: qr.modules.size,
    isDark: (row, col) => Boolean(qr.modules.get(row, col)),
  };
}

export function getReceiptQrMetrics(payload: string, paperWidth: "58mm" | "80mm"): ReceiptQrMetrics {
  const matrix = createReceiptQrMatrix(payload);
  const modulesWithQuietZone = matrix.size + QUIET_MODULES * 2;
  const cellDots = Math.max(3, Math.floor(MAX_QR_DOTS[paperWidth] / modulesWithQuietZone));
  return {
    matrix,
    quietModules: QUIET_MODULES,
    cellDots,
    drawDots: modulesWithQuietZone * cellDots,
  };
}

export function renderReceiptQrSvg(payload: string, paperWidth: "58mm" | "80mm"): string {
  const { matrix, quietModules } = getReceiptQrMetrics(payload, paperWidth);
  const viewSize = matrix.size + quietModules * 2;
  const sizePx = paperWidth === "58mm" ? 160 : 190;
  const rects: string[] = [];

  for (let row = 0; row < matrix.size; row += 1) {
    for (let col = 0; col < matrix.size; col += 1) {
      if (matrix.isDark(row, col)) {
        rects.push(`<rect x="${col + quietModules}" y="${row + quietModules}" width="1" height="1"/>`);
      }
    }
  }

  return `<svg class="promptpay-qr-image" role="img" aria-label="PromptPay QR" width="${sizePx}" height="${sizePx}" viewBox="0 0 ${viewSize} ${viewSize}" xmlns="http://www.w3.org/2000/svg"><rect width="${viewSize}" height="${viewSize}" fill="#fff"/><g fill="#000">${rects.join("")}</g></svg>`;
}
