import { describe, expect, it } from "vitest";
import { parseSetupProfile } from "@/modules/onboarding/setup-profile";

describe("setup profile parser (allowlist contract)", () => {
  it("accepts a valid profile and returns exactly the allowlisted keys", () => {
    const p = parseSetupProfile({ businessMode: "restaurant", usesTables: true, needsPrinting: false });
    expect(p).toEqual({ businessMode: "restaurant", usesTables: true, needsPrinting: false });
  });

  it("accepts every legal businessMode", () => {
    for (const businessMode of ["retail", "restaurant", "service"] as const) {
      expect(parseSetupProfile({ businessMode, usesTables: false, needsPrinting: true }).businessMode).toBe(businessMode);
    }
  });

  it("rejects unknown keys (allowlist, no passthrough)", () => {
    expect(() => parseSetupProfile({ businessMode: "retail", usesTables: true, needsPrinting: false, isAdmin: true })).toThrow("unknown_key");
  });

  it("rejects null, arrays and primitives", () => {
    for (const bad of [null, [], "restaurant", 42]) {
      expect(() => parseSetupProfile(bad)).toThrow("invalid_profile");
    }
  });

  it("rejects missing or non-boolean options", () => {
    expect(() => parseSetupProfile({ businessMode: "retail", usesTables: true })).toThrow("invalid_options");
    expect(() => parseSetupProfile({ businessMode: "retail", usesTables: "yes", needsPrinting: true })).toThrow("invalid_options");
  });

  it("rejects invalid businessMode", () => {
    expect(() => parseSetupProfile({ businessMode: "cafe", usesTables: true, needsPrinting: true })).toThrow("invalid_mode");
    expect(() => parseSetupProfile({ usesTables: true, needsPrinting: true })).toThrow("invalid_mode");
  });
});