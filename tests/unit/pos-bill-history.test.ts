import { describe, expect, it } from "vitest";
import { getStoreLocalDateRangeUtc } from "@/modules/pos/order-repository";

describe("POS bill history date range", () => {
  it("converts store-local date ranges to exact UTC query boundaries", () => {
    expect(getStoreLocalDateRangeUtc("2026-06-18", "2026-06-18", "Asia/Bangkok")).toEqual({
      startUtc: "2026-06-17T17:00:00.000Z",
      endUtc: "2026-06-18T17:00:00.000Z",
    });
  });

  it("supports multiple local days without broad padding that can be trimmed before filtering", () => {
    expect(getStoreLocalDateRangeUtc("2026-06-12", "2026-06-18", "Asia/Bangkok")).toEqual({
      startUtc: "2026-06-11T17:00:00.000Z",
      endUtc: "2026-06-18T17:00:00.000Z",
    });
  });

  it("falls back to Bangkok timezone when the store timezone is invalid", () => {
    expect(getStoreLocalDateRangeUtc("2026-06-18", "2026-06-18", "Invalid/Zone")).toEqual({
      startUtc: "2026-06-17T17:00:00.000Z",
      endUtc: "2026-06-18T17:00:00.000Z",
    });
  });
});
