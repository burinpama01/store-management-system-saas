import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cartRequestsDiscount } from "@/modules/pos/discount-policy";

describe("cartRequestsDiscount", () => {
  it("detects percentage discount intent even when the final discount amount is zero", () => {
    expect(
      cartRequestsDiscount({
        discount: 0,
        discountType: "percentage",
        discountValue: 10,
      }),
    ).toBe(true);
  });

  it("keeps zero and cleared discounts from requiring discount permission", () => {
    expect(cartRequestsDiscount({ discount: 0 })).toBe(false);
    expect(
      cartRequestsDiscount({
        discount: 0,
        discountType: "percentage",
        discountValue: 0,
      }),
    ).toBe(false);
  });

  it("detects item discount metadata even when the final item discount amount is zero", () => {
    expect(
      cartRequestsDiscount({
        discount: 0,
        items: [
          {
            discount: 0,
            discountType: "percentage",
            discountValue: 10,
          },
        ],
      } as Parameters<typeof cartRequestsDiscount>[0]),
    ).toBe(true);
  });

  it("is used by POS server actions before granting discount permission bypass", () => {
    const source = readFileSync(join(process.cwd(), "src/app/pos/actions.ts"), "utf8");

    expect(source).toContain("cartRequestsDiscount(ticket.cart)");
    expect(source).toContain("cartRequestsDiscount(cart)");
    expect(source).not.toContain("ticket.cart.discount <= 0");
    expect(source).not.toContain("cart.discount <= 0 ||");
  });
});
