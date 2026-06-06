import { describe, it, expect } from "vitest";
import {
  slugify,
  buildUniqueSlug,
  validateRegistrationInput,
} from "@/modules/auth/registration";

describe("slugify", () => {
  it("lowercases and hyphenates", () => {
    expect(slugify("Caramel Cafe")).toBe("caramel-cafe");
  });

  it("strips non-ascii and collapses separators", () => {
    expect(slugify("ร้าน  Cafe!! @ Siam")).toBe("cafe-siam");
  });

  it("trims leading/trailing hyphens", () => {
    expect(slugify("--Hello--")).toBe("hello");
  });

  it("returns empty string when no slug-safe chars", () => {
    expect(slugify("ร้านอาหาร")).toBe("");
  });
});

describe("buildUniqueSlug", () => {
  it("appends a random suffix to the base", () => {
    const slug = buildUniqueSlug("Caramel Cafe", "store");
    expect(slug).toMatch(/^caramel-cafe-[a-z0-9]{1,6}$/);
  });

  it("uses fallback when name has no slug-safe chars", () => {
    const slug = buildUniqueSlug("ร้านอาหาร", "store");
    expect(slug).toMatch(/^store-[a-z0-9]{1,6}$/);
  });

  it("produces distinct slugs across calls", () => {
    expect(buildUniqueSlug("Cafe", "store")).not.toBe(buildUniqueSlug("Cafe", "store"));
  });
});

describe("validateRegistrationInput", () => {
  const valid = {
    email: "owner@example.com",
    password: "supersecret",
    organizationName: "Caramel Group",
    storeName: "Caramel Cafe",
  };

  it("accepts valid input", () => {
    expect(validateRegistrationInput(valid)).toEqual({ valid: true, errors: [] });
  });

  it("rejects invalid email", () => {
    const result = validateRegistrationInput({ ...valid, email: "nope" });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("อีเมล"))).toBe(true);
  });

  it("rejects short password", () => {
    const result = validateRegistrationInput({ ...valid, password: "short" });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("รหัสผ่าน"))).toBe(true);
  });

  it("rejects empty organization and store names", () => {
    const result = validateRegistrationInput({
      ...valid,
      organizationName: "  ",
      storeName: "",
    });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(2);
  });
});
