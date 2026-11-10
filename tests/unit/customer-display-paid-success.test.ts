import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildCustomerDisplaySnapshot,
  CUSTOMER_DISPLAY_PAID_FLASH_MS,
  resolveCustomerDisplayPaymentTransition,
  type CustomerDisplayPayment,
} from "@/modules/grocery-pos/customer-display";
import type { Cart } from "@/modules/pos/types";

const cart: Cart = {
  storeId: "store-1",
  items: [],
  subtotal: 70,
  discount: 0,
  total: 70,
};

const qr: CustomerDisplayPayment = { method: "qr_promptpay", amount: 70, promptPayPayload: "000201..." };

describe("customer display: paid success flash", () => {
  it("remembers the QR while waiting for payment", () => {
    const t = resolveCustomerDisplayPaymentTransition(null, buildCustomerDisplaySnapshot(cart, { status: "checkout", payment: qr }));
    expect(t.pendingPayment).toEqual(qr);
    expect(t.paidFlash).toBeNull();
  });

  it("flashes success once when paid arrives while the QR is shown", () => {
    const paid = buildCustomerDisplaySnapshot(cart, { status: "paid", customer: { name: "A", pointsEarned: 7 } });
    const t = resolveCustomerDisplayPaymentTransition(qr, paid);
    expect(t.paidFlash).toEqual({ amount: 70, method: "qr_promptpay", pointsEarned: 7 });
    expect(t.pendingPayment).toBeNull();
    // POS ส่ง paid ซ้ำ (effect re-render) → ไม่เด้งใหม่
    expect(resolveCustomerDisplayPaymentTransition(t.pendingPayment, paid).paidFlash).toBeNull();
  });

  it("keeps the QR when POS re-sends checkout without it (member linked after QR)", () => {
    const resent = resolveCustomerDisplayPaymentTransition(qr, buildCustomerDisplaySnapshot(cart, { status: "checkout", customer: { name: "A" } }));
    expect(resent.pendingPayment).toEqual(qr);
    const paid = resolveCustomerDisplayPaymentTransition(resent.pendingPayment, buildCustomerDisplaySnapshot(cart, { status: "paid" }));
    expect(paid.paidFlash?.amount).toBe(70);
  });

  it("drops the QR if the total changed (stale amount)", () => {
    const changed = resolveCustomerDisplayPaymentTransition(qr, buildCustomerDisplaySnapshot({ ...cart, total: 80 }, { status: "checkout" }));
    expect(changed.pendingPayment).toBeNull();
  });

  it("omits zero points", () => {
    const paid = buildCustomerDisplaySnapshot(cart, { status: "paid", customer: { name: "A", pointsEarned: 0 } });
    expect(resolveCustomerDisplayPaymentTransition(qr, paid).paidFlash).toEqual({ amount: 70, method: "qr_promptpay" });
  });

  it("does not flash for cash sales or a QR the cashier closed", () => {
    const paid = buildCustomerDisplaySnapshot(cart, { status: "paid" });
    expect(resolveCustomerDisplayPaymentTransition(null, paid).paidFlash).toBeNull();
    const back = resolveCustomerDisplayPaymentTransition(qr, buildCustomerDisplaySnapshot(cart, { status: "idle" }));
    expect(back.pendingPayment).toBeNull();
  });

  it("auto-closes after a few seconds", () => {
    expect(CUSTOMER_DISPLAY_PAID_FLASH_MS).toBe(5000);
  });
});

describe("customer display screen wiring", () => {
  const src = readFileSync("src/app/pos/grocery/display/CustomerDisplayScreen.tsx", "utf8");

  it("uses the transition helper and a timer to close the success dialog", () => {
    expect(src).toMatch(/resolveCustomerDisplayPaymentTransition\(pendingPaymentRef\.current, next\)/);
    expect(src).toMatch(/window\.setTimeout\(\(\) => setPaidFlash\(null\), CUSTOMER_DISPLAY_PAID_FLASH_MS\)/);
    expect(src).toContain("ชำระเงินสำเร็จ");
    expect(src).toMatch(/snapshot\.payment \?\? pendingPayment/);
  });

  it("closes the success dialog when the next customer starts", () => {
    expect(src).toMatch(/next\.status === "checkout" \|\| next\.status === "scanning"/);
  });
});
