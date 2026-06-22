import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const read = (file: string) => fs.readFileSync(path.join(process.cwd(), file), "utf8");

describe("normal POS shared coupon loyalty and display", () => {
  it("exposes customer, coupon, and customer display controls in the normal POS UI", () => {
    const terminal = read("src/app/pos/PosTerminal.tsx");
    const page = read("src/app/pos/page.tsx");

    expect(page).toContain("getOrganizationBillingState");
    expect(page).toContain('"couponManagement"');
    expect(page).toContain('"loyaltyPoints"');
    expect(page).toContain('"customerDisplay"');
    expect(page).toContain("couponEnabled");
    expect(page).toContain("loyaltyEnabled");
    expect(page).toContain("customerDisplayEnabled");

    expect(terminal).toContain("searchPosCustomersAction");
    expect(terminal).toContain("evaluatePosCouponAction");
    expect(terminal).toContain("publishCustomerDisplaySnapshot");
    expect(terminal).toContain('href="/pos/display"');
    expect(terminal).toContain("onShowPromptPayOnCustomerDisplay");
    expect(terminal).toContain("แสดง QR บนจอลูกค้า");
    expect(terminal).toContain("PromptPay จาก ตั้งค่า › ใบเสร็จ");
    expect(terminal).toContain("ค้นชื่อลูกค้าหรือเบอร์โทร");
    expect(terminal).toContain("ใช้คูปอง");
    expect(terminal).toContain("selectedCustomer?.id");
    expect(terminal).toContain("clientCouponDiscountAmount");
    expect(terminal).toContain("checkoutIdempotencyKeyRef");
    expect(terminal).toContain("idempotencyKey: checkoutIdempotencyKey");
    expect(terminal).toContain("changeAmount: received !== undefined ? Math.max(0, received - displayCart.total) : undefined");
    expect(terminal).not.toContain("changeAmount: received !== undefined ? Math.max(0, received - cart.total) : undefined");
  });

  it("adds a normal POS customer display route using the shared display screen", () => {
    const displayPage = read("src/app/pos/display/page.tsx");

    expect(displayPage).toContain("requirePermission(\"pos.use\")");
    expect(displayPage).toContain("requireFeature(\"customerDisplay\")");
    expect(displayPage).toContain("CustomerDisplayScreen");
  });

  it("publishes locked PromptPay QR payment details to the customer display on cashier request", () => {
    const terminal = read("src/app/pos/PosTerminal.tsx");

    expect(terminal).toContain("buildPromptPayPayload({ recipientId: promptpayId, amount: cart.total })");
    expect(terminal).toContain("publishCustomerDisplaySnapshot(cart, {");
    expect(terminal).toContain("payment: {");
    expect(terminal).toContain('method: "qr_promptpay"');
    expect(terminal).toContain("amount: cart.total");
    expect(terminal).toContain("promptPayPayload");
  });

  it("validates normal POS coupons and passes customer/coupon data to trusted order creation", () => {
    const actions = read("src/app/pos/actions.ts");
    const repository = read("src/modules/pos/order-repository.ts");
    const submitStart = actions.indexOf("export async function submitOrderAction");
    const collectStart = actions.indexOf("export async function collectPaymentAction");
    const submitSource = actions.slice(submitStart, collectStart);

    expect(actions).toContain("searchPosCustomersAction");
    expect(actions).toContain("evaluatePosCouponAction");
    expect(actions).toContain("requireFeature(\"couponManagement\")");
    expect(actions).toContain("requireFeature(\"loyaltyPoints\")");
    expect(actions).toContain("buildGroceryCheckoutCart");
    expect(actions).toContain("createPosOrderWithCustomerRewards");
    expect(actions).toContain("closePosOrderPaymentWithRewards");
    expect(actions).toContain("customerId?: string | null");
    expect(actions).toContain("couponCode?: string | null");
    expect(submitSource).toContain("!opts?.idempotencyKey?.trim()");
    expect(submitSource).not.toContain("idempotencyKey: opts?.idempotencyKey ?? randomUUID()");

    expect(repository).toContain("createPosOrderWithCustomerRewards");
    expect(repository).toContain("create_pos_order_with_customer_rewards");
    expect(repository).toContain("const idempotencyKey = input.idempotencyKey?.trim()");
    expect(repository).toContain("closePosOrderPaymentWithRewards");
    expect(repository).toContain("close_grocery_pos_order_payment_with_rewards");
  });

  it("ships the normal POS customer/coupon rewards RPC migration", () => {
    const migration = read("supabase/migrations/20260621040000_normal_pos_customer_coupon_loyalty.sql");

    expect(migration).toContain("create or replace function create_pos_order_with_customer_rewards");
    expect(migration).toContain("p_table_id uuid default null");
    expect(migration).toContain("p_customer_id uuid default null");
    expect(migration).toContain("p_coupon_id uuid default null");
    expect(migration).toContain("pos_order_idempotency_keys");
    expect(migration).toContain("pg_advisory_xact_lock");
    expect(migration).toContain("select order_id into v_order_id");
    expect(migration).toContain("coupon_redemptions");
    expect(migration).toContain("customer_id = p_customer_id");
  });
});
