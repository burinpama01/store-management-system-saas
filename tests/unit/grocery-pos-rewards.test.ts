import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { evaluateCouponForCart } from "@/modules/promotions/coupon-policy";
import type { CouponPolicy } from "@/modules/promotions/types";
import { buildGroceryCheckoutCart } from "@/modules/grocery-pos/rewards";
import {
  computeLoyaltyBalance,
  createEarnPointsEntry,
  createRedeemPointsEntry,
  createReversalEntry,
} from "@/modules/loyalty/ledger";
import type { Cart } from "@/modules/pos/types";
import { canUseFeature } from "@/modules/billing/types";
import type { BillingState } from "@/modules/billing/types";
import type { CouponEvaluation, CouponRejectionReason } from "@/modules/promotions/types";

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");

function state(plan: BillingState["plan"]): BillingState {
  return {
    plan,
    status: "active",
    currentPeriodEnd: "2030-01-01T00:00:00Z",
    cancelAtPeriodEnd: false,
    trialEnd: null,
  };
}

function cart(overrides: Partial<Cart> = {}): Cart {
  return {
    storeId: "store-1",
    items: [],
    subtotal: 500,
    discount: 0,
    total: 500,
    ...overrides,
  };
}

function coupon(overrides: Partial<CouponPolicy> = {}): CouponPolicy {
  return {
    id: "coupon-1",
    storeId: "store-1",
    code: "SAVE10",
    name: "ส่วนลดสมาชิก",
    discountType: "percentage",
    discountValue: 10,
    minSubtotal: 100,
    isActive: true,
    redeemedCount: 0,
    customerRedeemedCount: 0,
    ...overrides,
  };
}

function expectCouponReason(evaluation: CouponEvaluation, reason: CouponRejectionReason) {
  expect(evaluation.ok).toBe(false);
  if (!evaluation.ok) {
    expect(evaluation.reason).toBe(reason);
  }
}

describe("grocery POS coupon policy", () => {
  it("evaluates percentage coupons from the trusted server cart total", () => {
    expect(
      evaluateCouponForCart({
        coupon: coupon(),
        cart: cart({ subtotal: 500 }),
        code: " save10 ",
        now: "2026-06-21T00:00:00.000Z",
      }),
    ).toEqual({
      ok: true,
      couponId: "coupon-1",
      discount: 50,
      normalizedCode: "SAVE10",
    });
  });

  it("rejects inactive, cross-store, expired, min-spend, and usage-limit coupons", () => {
    expectCouponReason(evaluateCouponForCart({ coupon: coupon({ isActive: false }), cart: cart(), code: "SAVE10" }), "coupon_inactive");
    expectCouponReason(evaluateCouponForCart({ coupon: coupon({ storeId: "store-2" }), cart: cart(), code: "SAVE10" }), "coupon_wrong_store");
    expectCouponReason(evaluateCouponForCart({ coupon: coupon({ endsAt: "2026-01-01T00:00:00.000Z" }), cart: cart(), code: "SAVE10", now: "2026-06-21T00:00:00.000Z" }), "coupon_expired");
    expectCouponReason(evaluateCouponForCart({ coupon: coupon({ minSubtotal: 600 }), cart: cart({ subtotal: 500 }), code: "SAVE10" }), "coupon_min_subtotal");
    expectCouponReason(evaluateCouponForCart({ coupon: coupon({ maxRedemptions: 5, redeemedCount: 5 }), cart: cart(), code: "SAVE10" }), "coupon_usage_limit");
  });

  it("requires the targeted customer and blocks stacking with manual order discounts by default", () => {
    expectCouponReason(
      evaluateCouponForCart({
        coupon: coupon({ customerIds: ["customer-1"] }),
        cart: cart(),
        code: "SAVE10",
      }),
      "coupon_customer_required",
    );

    expectCouponReason(
      evaluateCouponForCart({
        coupon: coupon({ customerIds: ["customer-1"] }),
        cart: cart({ discount: 25 }),
        code: "SAVE10",
        customerId: "customer-1",
      }),
      "coupon_manual_discount_conflict",
    );
  });
});

describe("grocery POS checkout reward composition", () => {
  it("recomputes coupon discount from trusted server policy instead of trusting client amounts", () => {
    const result = buildGroceryCheckoutCart({
      trustedCart: cart({ subtotal: 500, discount: 0, total: 500 }),
      coupon: coupon(),
      couponCode: "SAVE10",
      clientCouponDiscountAmount: 500,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("ยอดส่วนลดคูปองไม่ตรงกับนโยบาย");
    }

    const valid = buildGroceryCheckoutCart({
      trustedCart: cart({ subtotal: 500, discount: 0, total: 500 }),
      coupon: coupon(),
      couponCode: "SAVE10",
      clientCouponDiscountAmount: 50,
    });

    expect(valid.ok).toBe(true);
    if (valid.ok) {
      expect(valid.cart.discount).toBe(50);
      expect(valid.cart.total).toBe(450);
    }
  });
});

describe("grocery POS loyalty ledger", () => {
  it("earns points only from paid totals and stores idempotent ledger entries", () => {
    const entry = createEarnPointsEntry({
      accountId: "account-1",
      orderId: "order-1",
      paidTotal: 250,
      pointsPerCurrency: 0.01,
      idempotencyKey: "order-1:earn",
    });

    expect(entry).toMatchObject({
      accountId: "account-1",
      orderId: "order-1",
      type: "earn",
      pointsDelta: 2,
      idempotencyKey: "order-1:earn",
    });
  });

  it("prevents negative balances and models void/refund as reversal entries", () => {
    const earn = createEarnPointsEntry({
      accountId: "account-1",
      orderId: "order-1",
      paidTotal: 1000,
      pointsPerCurrency: 0.01,
      idempotencyKey: "order-1:earn",
    });
    const redeem = createRedeemPointsEntry({
      accountId: "account-1",
      orderId: "order-2",
      points: 4,
      currentBalance: computeLoyaltyBalance([earn]),
      idempotencyKey: "order-2:redeem",
    });
    const reversal = createReversalEntry({
      original: redeem,
      reason: "void_order",
      idempotencyKey: "order-2:redeem:reversal",
    });

    expect(computeLoyaltyBalance([earn, redeem])).toBe(6);
    expect(computeLoyaltyBalance([earn, redeem, reversal])).toBe(10);
    expect(() =>
      createRedeemPointsEntry({
        accountId: "account-1",
        orderId: "order-3",
        points: 11,
        currentBalance: 10,
        idempotencyKey: "order-3:redeem",
      }),
    ).toThrow("แต้มสะสมไม่พอ");
  });
});

describe("grocery POS reward data contract", () => {
  it("adds customer, coupon, and loyalty schema with store-scoped RLS", () => {
    const migration = read("supabase/migrations/20260621020000_customer_coupon_loyalty.sql");

    expect(migration).toContain("create table if not exists customers");
    expect(migration).toContain("create table if not exists coupons");
    expect(migration).toContain("create table if not exists coupon_redemptions");
    expect(migration).toContain("create table if not exists loyalty_accounts");
    expect(migration).toContain("create table if not exists loyalty_ledger");
    expect(migration).toContain("create table if not exists loyalty_settings");
    expect(migration).toContain("alter table orders add column if not exists customer_id uuid");
    expect(migration).toContain("alter table orders add column if not exists coupon_id uuid");
    expect(migration).toContain("alter table orders add column if not exists coupon_discount_amount numeric(12,2)");
    expect(migration).toContain("alter table orders add column if not exists loyalty_points_earned integer");
    expect(migration).toContain("alter table orders add column if not exists loyalty_points_redeemed integer");
    expect(migration).toContain("customers: store member can read");
    expect(migration).toContain("coupons: manager+ can write");
    expect(migration).toContain("loyalty_ledger_idempotency_key_idx");
    expect(migration).toContain("coupons_store_code_lower_idx");
    expect(migration).toContain("coupon_redemptions_coupon_store_fkey");
    expect(migration).toContain("coupon_redemptions_order_store_fkey");
    expect(migration).toContain("loyalty_ledger_account_store_fkey");
    expect(migration).toContain("loyalty_ledger_customer_store_fkey");
    expect(migration).toContain("loyalty_settings: store member can read");
    expect(migration).toContain("loyalty_settings: manager+ can write");
    expect(migration).toContain("revoke insert, update, delete on coupon_redemptions from authenticated");
    expect(migration).toContain("revoke insert, update, delete on loyalty_accounts from authenticated");
    expect(migration).toContain("revoke insert, update, delete on loyalty_ledger from authenticated");
    expect(migration).not.toContain("coupon_redemptions: cashier+ can create");
    expect(migration).not.toContain("loyalty_accounts: cashier+ can write");
    expect(migration).not.toContain("loyalty_ledger: cashier+ can create");
    expect(migration).toContain("orders_customer_store_fkey");
    expect(migration).toContain("orders_coupon_store_fkey");
    expect(migration).toContain("normalized_code");
    expect(migration).toContain("normalize_coupon_code");
    expect(migration).toContain("set_coupon_normalized_code");
    expect(migration).toContain("coupons_store_normalized_code_idx");
  });

  it("updates billing package gates and visible plan copy together", () => {
    expect(canUseFeature(state("free"), "groceryPos")).toBe(false);
    expect(canUseFeature(state("starter"), "groceryPos")).toBe(true);
    expect(canUseFeature(state("standard"), "couponManagement")).toBe(true);
    expect(canUseFeature(state("standard"), "loyaltyPoints")).toBe(true);
    expect(canUseFeature(state("starter"), "couponManagement")).toBe(false);
    expect(canUseFeature(state("premium"), "customerDisplay")).toBe(true);
    expect(canUseFeature(state("standard"), "customerDisplay")).toBe(false);

    const migration = read("supabase/migrations/20260621021000_update_plan_settings_grocery_pos.sql");
    expect(migration).toContain("Grocery POS + Barcode");
    expect(migration).toContain("Coupon + Loyalty");
    expect(migration).toContain("Customer display");
  });

  it("keeps grocery reward actions server-gated", () => {
    const actions = read("src/app/pos/grocery/actions.ts");

    expect(actions).toContain("evaluateGroceryCouponAction");
    expect(actions).toContain('requireFeature("groceryPos")');
    expect(actions).toContain('requireFeature("couponManagement")');
    expect(actions).toContain('requireFeature("loyaltyPoints")');
    expect(actions).toContain("evaluateCouponForCart");
    expect(actions).toContain("searchGroceryCustomersAction");
    expect(actions).toContain("createTrustedGroceryOrder");
    expect(actions).toContain("couponCode");
    expect(actions).toContain("clientCouponDiscountAmount");
    expect(actions).toContain("voidGroceryOrderAction");
    expect(actions).not.toContain("getLoyaltyAccountForCustomer");
    expect(actions).not.toContain("createIfMissing: true");
    expect(actions).not.toContain("pointsPerCurrency?: number");
    expect(actions).not.toContain("input.pointsPerCurrency");
    expect(actions).not.toContain("loyaltyPointsRedeemed?: number");
    expect(actions).not.toContain("input.loyaltyPointsRedeemed");

    const checkoutService = read("src/modules/grocery-pos/checkout-service.ts");
    expect(checkoutService).toContain("buildGroceryCheckoutCart");
    expect(checkoutService).toContain("buildTrustedCartFromCatalog");
    expect(checkoutService).toContain("createGroceryOrderWithRewards");

    const terminal = read("src/app/pos/grocery/GroceryPosTerminal.tsx");
    expect(terminal).toContain("searchGroceryCustomersAction");
    expect(terminal).toContain("evaluateGroceryCouponAction");
    expect(terminal).toContain("createGroceryOrderAction");
    expect(terminal).toContain("closeGroceryOrderPaymentAction");
    expect(terminal).toContain("voidGroceryOrderAction");
    expect(terminal).toContain("couponCode");
    expect(terminal).toContain("customerQuery");
    expect(terminal).toContain("pointsBalance");
  });

  it("persists grocery checkout rewards through an atomic RPC contract", () => {
    const migration = read("supabase/migrations/20260621022000_grocery_pos_checkout_rewards.sql");
    const repository = read("src/modules/grocery-pos/order-repository.ts");
    const actions = read("src/app/pos/grocery/actions.ts");
    const types = read("src/server/integrations/supabase/database.types.ts");

    expect(migration).toContain("create or replace function create_grocery_pos_order_with_rewards");
    expect(migration).toContain("create or replace function close_grocery_pos_order_payment_with_rewards");
    expect(migration).toContain("close_pos_order_payment");
    expect(migration).toContain("v_expected_coupon_discount");
    expect(migration).toContain("v_manual_discount");
    expect(migration).toContain("v_coupon.min_subtotal");
    expect(migration).toContain("v_coupon.discount_type");
    expect(migration).toContain("for update");
    expect(migration).toContain("insert into coupon_redemptions");
    expect(migration).toContain("insert into loyalty_ledger");
    expect(migration).toContain("update loyalty_accounts");
    expect(migration).toContain("loyalty_points_earned");
    expect(migration).toContain("select *");
    expect(migration).toContain("from loyalty_settings");
    expect(migration).toContain("void_grocery_pos_order_with_rewards");
    expect(migration).toContain("voided_at = now()");
    expect(migration).toContain("'reversal'");
    expect(migration).not.toContain("p_loyalty_points_redeemed");
    expect(migration).not.toContain("p_points_per_currency");
    expect(migration).toContain("grant execute on function create_grocery_pos_order_with_rewards");
    expect(migration).toContain("grant execute on function close_grocery_pos_order_payment_with_rewards");
    expect(migration).toContain("grant execute on function void_grocery_pos_order_with_rewards");
    expect(repository).toContain('supabase.rpc("create_grocery_pos_order_with_rewards"');
    expect(repository).toContain('supabase.rpc("close_grocery_pos_order_payment_with_rewards"');
    expect(repository).toContain('supabase.rpc("void_grocery_pos_order_with_rewards"');
    expect(actions).toContain("createGroceryOrderAction");
    expect(actions).toContain("closeGroceryOrderPaymentAction");
    expect(actions).toContain("voidGroceryOrderAction");
    expect(types).toContain("create_grocery_pos_order_with_rewards");
    expect(types).toContain("close_grocery_pos_order_payment_with_rewards");
    expect(types).toContain("void_grocery_pos_order_with_rewards");
  });
});
