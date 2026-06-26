import { describe, it, expect } from "vitest";
import {
  formatStoreTime,
  toStoreDateTimeLocal,
  storeDateTimeToUtc,
} from "@/modules/attendance/date";

// Clock timestamps are stored as UTC; staff see and edit them in the store's timezone.
describe("attendance store-timezone helpers", () => {
  it("formats a UTC instant as HH:MM in the store timezone (Bangkok = UTC+7)", () => {
    // 02:00Z is 09:00 in Bangkok — the old slice(11,16) wrongly showed 02:00.
    expect(formatStoreTime("2026-06-20T02:00:00.000Z", "Asia/Bangkok")).toBe("09:00");
  });

  it("formats a datetime-local default value in the store timezone", () => {
    expect(toStoreDateTimeLocal("2026-06-20T02:00:00.000Z", "Asia/Bangkok")).toBe(
      "2026-06-20T09:00",
    );
  });

  it("interprets a datetime-local value as store-local wall time → UTC", () => {
    // Manager typed 09:00 meaning Bangkok; must persist as 02:00Z, not 09:00Z.
    expect(storeDateTimeToUtc("2026-06-20T09:00", "Asia/Bangkok")).toBe(
      "2026-06-20T02:00:00.000Z",
    );
  });

  it("round-trips edit form ↔ storage without drift", () => {
    const stored = "2026-06-20T02:00:00.000Z";
    const formValue = toStoreDateTimeLocal(stored, "Asia/Bangkok");
    expect(storeDateTimeToUtc(formValue, "Asia/Bangkok")).toBe(stored);
  });

  it("handles a UTC store timezone as a no-op", () => {
    expect(storeDateTimeToUtc("2026-06-20T09:00", "UTC")).toBe("2026-06-20T09:00:00.000Z");
    expect(formatStoreTime("2026-06-20T09:00:00.000Z", "UTC")).toBe("09:00");
  });

  it("respects DST offsets (New York is UTC-4 in June)", () => {
    expect(storeDateTimeToUtc("2026-06-20T09:00", "America/New_York")).toBe(
      "2026-06-20T13:00:00.000Z",
    );
    expect(formatStoreTime("2026-06-20T13:00:00.000Z", "America/New_York")).toBe("09:00");
  });

  it("falls back to Bangkok and returns null on malformed input", () => {
    expect(formatStoreTime("2026-06-20T02:00:00.000Z", "")).toBe("09:00");
    expect(storeDateTimeToUtc("not-a-date", "Asia/Bangkok")).toBeNull();
  });
});
