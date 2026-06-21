export type BarcodeScanError = "empty" | "unsupported_characters";

export interface BarcodeScanResult {
  ok: boolean;
  barcode?: string;
  reason?: BarcodeScanError;
}

export interface ScannerBufferState {
  value: string;
  updatedAtMs: number;
}

export interface ScannerKeyInput {
  key: string;
  timeMs: number;
}

const SCANNER_STALE_MS = 500;
const SUPPORTED_BARCODE_PATTERN = /^[0-9A-Za-z._-]+$/;
const IGNORED_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock", "Tab"]);

export function normalizeBarcodeScan(input: string): BarcodeScanResult {
  const barcode = input.trim();
  if (!barcode) return { ok: false, reason: "empty" };
  if (!SUPPORTED_BARCODE_PATTERN.test(barcode)) {
    return { ok: false, reason: "unsupported_characters" };
  }
  return { ok: true, barcode };
}

export function applyScannerKey(
  state: ScannerBufferState,
  input: ScannerKeyInput,
): { state: ScannerBufferState; barcode?: string } {
  if (IGNORED_KEYS.has(input.key)) return { state };

  const stale = input.timeMs - state.updatedAtMs > SCANNER_STALE_MS;
  const value = stale ? "" : state.value;

  if (input.key === "Enter") {
    const result = normalizeBarcodeScan(value);
    return {
      state: { value: "", updatedAtMs: input.timeMs },
      barcode: result.ok ? result.barcode : undefined,
    };
  }

  if (input.key.length !== 1) {
    return { state: { value, updatedAtMs: input.timeMs } };
  }

  return {
    state: {
      value: `${value}${input.key}`,
      updatedAtMs: input.timeMs,
    },
  };
}
