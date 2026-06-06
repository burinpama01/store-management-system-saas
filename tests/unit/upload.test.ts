import { describe, it, expect } from "vitest";
import { computeUploadPercent } from "@/shared/services/upload";

describe("computeUploadPercent", () => {
  it("computes real percentage from bytes", () => {
    expect(computeUploadPercent(0, 100)).toBe(0);
    expect(computeUploadPercent(50, 100)).toBe(50);
    expect(computeUploadPercent(100, 100)).toBe(100);
    expect(computeUploadPercent(1, 3)).toBe(33);
  });

  it("clamps and guards against zero/invalid totals", () => {
    expect(computeUploadPercent(10, 0)).toBe(0);
    expect(computeUploadPercent(200, 100)).toBe(100);
    expect(computeUploadPercent(-5, 100)).toBe(0);
  });
});
