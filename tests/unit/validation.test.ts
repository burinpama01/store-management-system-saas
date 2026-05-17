import { describe, it, expect } from "vitest";
import {
  isValidEmail,
  isValidThaiPhone,
  isValidISODate,
  isPositiveNumber,
  isNonNegativeNumber,
  isValidPrice,
  isNonEmptyString,
  validateProduct,
  validateTransaction,
  validateModifierGroup,
} from "@/shared/validation";

describe("isValidEmail", () => {
  it("accepts standard email", () => expect(isValidEmail("a@b.com")).toBe(true));
  it("rejects missing @", () => expect(isValidEmail("noatsign.com")).toBe(false));
  it("rejects empty string", () => expect(isValidEmail("")).toBe(false));
});

describe("isValidThaiPhone", () => {
  it("accepts 10-digit Thai mobile", () => expect(isValidThaiPhone("0812345678")).toBe(true));
  it("accepts with spaces", () => expect(isValidThaiPhone("081 234 5678")).toBe(true));
  it("rejects non-zero prefix", () => expect(isValidThaiPhone("1234567890")).toBe(false));
  it("rejects too short", () => expect(isValidThaiPhone("081234")).toBe(false));
});

describe("isValidISODate", () => {
  it("accepts valid date", () => expect(isValidISODate("2024-01-15")).toBe(true));
  it("rejects wrong format", () => expect(isValidISODate("15-01-2024")).toBe(false));
  it("rejects invalid date", () => expect(isValidISODate("2024-13-01")).toBe(false));
});

describe("number validators", () => {
  it("isPositiveNumber rejects 0", () => expect(isPositiveNumber(0)).toBe(false));
  it("isPositiveNumber accepts 1", () => expect(isPositiveNumber(1)).toBe(true));
  it("isNonNegativeNumber accepts 0", () => expect(isNonNegativeNumber(0)).toBe(true));
  it("isNonNegativeNumber rejects negative", () => expect(isNonNegativeNumber(-1)).toBe(false));
  it("isValidPrice rejects Infinity", () => expect(isValidPrice(Infinity)).toBe(false));
  it("isValidPrice accepts 0", () => expect(isValidPrice(0)).toBe(true));
});

describe("validateProduct", () => {
  it("accepts valid product", () => {
    const result = validateProduct({ name: "Coffee", categoryId: "cat-1", basePrice: 50 });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("rejects empty name", () => {
    const result = validateProduct({ name: "", categoryId: "cat-1", basePrice: 50 });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === "name")).toBe(true);
  });

  it("rejects negative price", () => {
    const result = validateProduct({ name: "Item", categoryId: "cat-1", basePrice: -10 });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === "basePrice")).toBe(true);
  });

  it("rejects missing category", () => {
    const result = validateProduct({ name: "Item", categoryId: "", basePrice: 100 });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === "categoryId")).toBe(true);
  });
});

describe("validateTransaction", () => {
  it("accepts valid income transaction", () => {
    const result = validateTransaction({
      amount: 200,
      categoryId: "cat-1",
      date: "2024-06-15",
      type: "income",
    });
    expect(result.valid).toBe(true);
  });

  it("rejects zero amount", () => {
    const result = validateTransaction({
      amount: 0,
      categoryId: "cat-1",
      date: "2024-06-15",
      type: "expense",
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === "amount")).toBe(true);
  });

  it("rejects invalid date format", () => {
    const result = validateTransaction({
      amount: 100,
      categoryId: "cat-1",
      date: "not-a-date",
      type: "income",
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === "date")).toBe(true);
  });

  it("rejects unknown type", () => {
    const result = validateTransaction({
      amount: 100,
      categoryId: "cat-1",
      date: "2024-06-15",
      type: "refund",
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === "type")).toBe(true);
  });
});

describe("validateModifierGroup", () => {
  it("accepts valid single-select group", () => {
    const result = validateModifierGroup({
      name: "Size",
      selectionType: "single",
      minSelections: 1,
      maxSelections: 1,
    });
    expect(result.valid).toBe(true);
  });

  it("accepts valid multi-select group", () => {
    const result = validateModifierGroup({
      name: "Toppings",
      selectionType: "multiple",
      minSelections: 0,
      maxSelections: 3,
    });
    expect(result.valid).toBe(true);
  });

  it("rejects min > max", () => {
    const result = validateModifierGroup({
      name: "Extras",
      selectionType: "multiple",
      minSelections: 5,
      maxSelections: 2,
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === "minSelections")).toBe(true);
  });

  it("rejects single-select with max > 1", () => {
    const result = validateModifierGroup({
      name: "Temperature",
      selectionType: "single",
      minSelections: 0,
      maxSelections: 3,
    });
    expect(result.valid).toBe(false);
  });

  it("rejects empty name", () => {
    const result = validateModifierGroup({
      name: "",
      selectionType: "single",
      minSelections: 1,
      maxSelections: 1,
    });
    expect(result.valid).toBe(false);
  });
});
