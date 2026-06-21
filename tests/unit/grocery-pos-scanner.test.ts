import { describe, expect, it } from "vitest";
import { applyScannerKey, normalizeBarcodeScan, type ScannerBufferState } from "@/modules/grocery-pos/scanner";

describe("grocery POS scanner", () => {
  it("normalizes barcode scanner payloads before lookup", () => {
    expect(normalizeBarcodeScan("  8851234-ABC \r\n")).toEqual({ ok: true, barcode: "8851234-ABC" });
    expect(normalizeBarcodeScan("")).toEqual({ ok: false, reason: "empty" });
    expect(normalizeBarcodeScan("สินค้าไทย")).toEqual({ ok: false, reason: "unsupported_characters" });
  });

  it("collects keyboard-wedge scanner keys until Enter submits the barcode", () => {
    let state: ScannerBufferState = { value: "", updatedAtMs: 0 };

    state = applyScannerKey(state, { key: "8", timeMs: 10 }).state;
    state = applyScannerKey(state, { key: "8", timeMs: 20 }).state;
    state = applyScannerKey(state, { key: "5", timeMs: 30 }).state;
    const result = applyScannerKey(state, { key: "Enter", timeMs: 40 });

    expect(result.barcode).toBe("885");
    expect(result.state.value).toBe("");
  });

  it("resets stale scanner buffers so manual typing does not submit a mixed barcode", () => {
    let state: ScannerBufferState = { value: "", updatedAtMs: 0 };

    state = applyScannerKey(state, { key: "8", timeMs: 10 }).state;
    state = applyScannerKey(state, { key: "8", timeMs: 20 }).state;
    state = applyScannerKey(state, { key: "5", timeMs: 900 }).state;
    const result = applyScannerKey(state, { key: "Enter", timeMs: 910 });

    expect(result.barcode).toBe("5");
  });
});
