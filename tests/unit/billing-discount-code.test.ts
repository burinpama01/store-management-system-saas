import { describe, it, expect } from "vitest";
import {
  normalizeDiscountCode,
  evaluateBillingDiscount,
  describeDiscountRejection,
  type BillingDiscountCode,
} from "@/modules/billing/discount-code";

function code(over: Partial<BillingDiscountCode> = {}): BillingDiscountCode {
  return {
    id: "dc1",
    code: "SAVE20",
    normalizedCode: "SAVE20",
    description: "ลด 20%",
    discountType: "percentage",
    discountValue: 20,
    plan: null,
    duration: null,
    minAmount: 0,
    maxRedemptions: null,
    maxRedemptionsPerOrg: null,
    active: true,
    startsAt: null,
    endsAt: null,
    ...over,
  };
}

const now = new Date("2026-06-26T00:00:00Z");

function evaluate(over: Partial<Parameters<typeof evaluateBillingDiscount>[0]> = {}) {
  return evaluateBillingDiscount({
    code: "SAVE20",
    plan: "standard",
    duration: "30d",
    baseAmount: 1290,
    discount: code(),
    globalRedeemed: 0,
    orgRedeemed: 0,
    now,
    ...over,
  });
}

describe("normalizeDiscountCode", () => {
  it("trims, uppercases, and removes inner whitespace", () => {
    expect(normalizeDiscountCode("  save 20 ")).toBe("SAVE20");
    expect(normalizeDiscountCode("new\tyear")).toBe("NEWYEAR");
    expect(normalizeDiscountCode("")).toBe("");
  });
});

describe("evaluateBillingDiscount", () => {
  it("applies a percentage discount rounded to baht", () => {
    const r = evaluate({ baseAmount: 1290, discount: code({ discountValue: 15 }) });
    expect(r.ok).toBe(true);
    expect(r.discount).toBe(194); // 193.5 -> 194
    expect(r.codeId).toBe("dc1");
    expect(r.description).toBe("ลด 20%");
  });

  it("applies a fixed discount capped at the base amount", () => {
    const r = evaluate({
      baseAmount: 1290,
      discount: code({ discountType: "fixed", discountValue: 200 }),
    });
    expect(r.ok).toBe(true);
    expect(r.discount).toBe(200);

    const capped = evaluate({
      baseAmount: 150,
      discount: code({ discountType: "fixed", discountValue: 200 }),
    });
    expect(capped.ok).toBe(true);
    expect(capped.discount).toBe(150);
  });

  it("rejects a code that does not match the supplied input", () => {
    const r = evaluate({ code: "OTHER" });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("code_mismatch");
  });

  it("rejects inactive, not-started, and expired codes", () => {
    expect(evaluate({ discount: code({ active: false }) }).reason).toBe("inactive");
    expect(evaluate({ discount: code({ startsAt: "2026-07-01T00:00:00Z" }) }).reason).toBe("not_started");
    expect(evaluate({ discount: code({ endsAt: "2026-06-01T00:00:00Z" }) }).reason).toBe("expired");
  });

  it("enforces plan and duration scoping", () => {
    expect(evaluate({ discount: code({ plan: "premium" }) }).reason).toBe("plan_mismatch");
    expect(evaluate({ discount: code({ plan: "standard" }) }).ok).toBe(true);
    expect(evaluate({ discount: code({ duration: "1y" }) }).reason).toBe("duration_mismatch");
    expect(evaluate({ discount: code({ duration: "30d" }) }).ok).toBe(true);
  });

  it("enforces the minimum amount", () => {
    const r = evaluate({ baseAmount: 500, discount: code({ minAmount: 1000 }) });
    expect(r.reason).toBe("min_amount");
  });

  it("enforces global and per-org redemption limits", () => {
    expect(evaluate({ discount: code({ maxRedemptions: 5 }), globalRedeemed: 5 }).reason).toBe("usage_limit");
    expect(evaluate({ discount: code({ maxRedemptions: 5 }), globalRedeemed: 4 }).ok).toBe(true);
    expect(evaluate({ discount: code({ maxRedemptionsPerOrg: 1 }), orgRedeemed: 1 }).reason).toBe("org_usage_limit");
    expect(evaluate({ discount: code({ maxRedemptionsPerOrg: 1 }), orgRedeemed: 0 }).ok).toBe(true);
  });

  it("rejects when the base amount is zero (nothing to discount)", () => {
    expect(evaluate({ baseAmount: 0 }).reason).toBe("invalid_discount");
  });

  it("maps every rejection reason to a Thai message", () => {
    expect(describeDiscountRejection("expired")).toContain("หมดอายุ");
    expect(describeDiscountRejection("usage_limit")).toContain("ครบ");
    expect(describeDiscountRejection("org_usage_limit")).toContain("ครบ");
    expect(describeDiscountRejection("code_not_found")).toContain("ไม่พบ");
  });
});
