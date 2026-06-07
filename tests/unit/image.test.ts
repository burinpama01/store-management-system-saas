import { describe, it, expect } from "vitest";
import { computeResizedDimensions } from "@/shared/services/image";

describe("computeResizedDimensions", () => {
  it("does not upscale images within the limit", () => {
    expect(computeResizedDimensions(800, 600, 1024)).toEqual({ width: 800, height: 600 });
  });

  it("scales down by the longest side, preserving ratio", () => {
    expect(computeResizedDimensions(4000, 3000, 1024)).toEqual({ width: 1024, height: 768 });
    expect(computeResizedDimensions(2000, 4000, 1024)).toEqual({ width: 512, height: 1024 });
  });

  it("handles zero/edge dimensions safely", () => {
    expect(computeResizedDimensions(0, 0, 1024)).toEqual({ width: 0, height: 0 });
  });
});
