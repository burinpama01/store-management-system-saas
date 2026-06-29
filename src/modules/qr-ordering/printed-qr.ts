import type { QrOrderingMode } from "@/modules/stores/types";

export interface TableQrUrlInput {
  baseUrl: string;
  storeSlug: string;
  tableId: string;
  qrMode: QrOrderingMode;
  /** Active table session id; only used for session_printed mode. */
  sessionId: string | null;
}

/**
 * Builds the customer QR URL for a table. For `session_printed` stores the URL
 * carries the active session token (`?s=`) so the printed QR expires when the
 * session is cleared. `table_bound` stores use the permanent table URL.
 */
export function buildTableQrUrl(input: TableQrUrlInput): string {
  const base = `${input.baseUrl}/qr/${input.storeSlug}/${input.tableId}`;
  if (input.qrMode === "session_printed" && input.sessionId) {
    return `${base}?s=${encodeURIComponent(input.sessionId)}`;
  }
  return base;
}
