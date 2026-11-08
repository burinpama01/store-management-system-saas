import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  applyKeypadKey,
  availableDiscountPresets,
  couponCartKey,
  fallbackMemberName,
  isCompleteThaiMobile,
  isRegistrablePhone,
  pickAutoSelectCustomer,
  shouldAutoSearchCustomer,
  usableVouchers,
  type PosRewardVoucher,
} from "@/modules/pos/loyalty-coupon-ux";
import type { CustomerProfile } from "@/modules/customers/types";
import type { Cart, CartItem } from "@/modules/pos/types";

function item(key: string, quantity: number, totalPrice: number, extra: Partial<CartItem> = {}): CartItem {
  return {
    key,
    productId: key,
    productName: key,
    categoryId: "c",
    variant: null,
    modifiers: [],
    quantity,
    unitPrice: totalPrice / quantity,
    totalPrice,
    ...extra,
  } as CartItem;
}

function cart(items: CartItem[], discount = 0): Cart {
  const subtotal = items.reduce((sum, i) => sum + i.totalPrice, 0);
  return { storeId: "s", items, subtotal, discount, total: subtotal - discount };
}

function customer(id: string, phone?: string): CustomerProfile {
  return { id, organizationId: "o", storeId: "s", name: id, phone, priceTier: "retail", isActive: true, createdAt: "", updatedAt: "" } as CustomerProfile;
}

describe("couponCartKey (C1: คำนวณคูปองใหม่เมื่อตะกร้าเปลี่ยน)", () => {
  it("changes when quantity, items or bill discount change", () => {
    const base = couponCartKey(cart([item("a", 1, 50)]));
    expect(couponCartKey(cart([item("a", 2, 100)]))).not.toBe(base);
    expect(couponCartKey(cart([item("a", 1, 50), item("b", 1, 20)]))).not.toBe(base);
    expect(couponCartKey(cart([item("a", 1, 50)], 5))).not.toBe(base);
  });

  it("is stable regardless of item order", () => {
    expect(couponCartKey(cart([item("a", 1, 50), item("b", 1, 20)]))).toBe(couponCartKey(cart([item("b", 1, 20), item("a", 1, 50)])));
  });
});

describe("member search helpers (L1/L2)", () => {
  it("detects complete Thai mobile numbers", () => {
    expect(isCompleteThaiMobile("0812345678")).toBe(true);
    expect(isCompleteThaiMobile("081-234-5678")).toBe(true);
    expect(isCompleteThaiMobile("081234567")).toBe(false);
    expect(isCompleteThaiMobile("สมชาย")).toBe(false);
  });

  it("allows registering 9–10 digit numbers starting with 0", () => {
    expect(isRegistrablePhone("021234567")).toBe(true);
    expect(isRegistrablePhone("0812345678")).toBe(true);
    expect(isRegistrablePhone("12345678")).toBe(false);
    expect(isRegistrablePhone("08123456789")).toBe(false);
  });

  it("auto-searches names from 2 chars and numbers from 4 digits", () => {
    expect(shouldAutoSearchCustomer("ส")).toBe(false);
    expect(shouldAutoSearchCustomer("สม")).toBe(true);
    expect(shouldAutoSearchCustomer("081")).toBe(false);
    expect(shouldAutoSearchCustomer("0812")).toBe(true);
  });

  it("auto-selects only one exact phone match", () => {
    const a = customer("a", "0812345678");
    const b = customer("b", "0812345679");
    expect(pickAutoSelectCustomer("0812345678", [a, b])).toBe(a);
    expect(pickAutoSelectCustomer("0812345678", [a, customer("dup", "081-234-5678")])).toBeNull();
    expect(pickAutoSelectCustomer("08123", [a])).toBeNull();
  });

  it("names new members by the last 4 digits only", () => {
    expect(fallbackMemberName("081-234-5678")).toBe("ลูกค้า 5678");
  });
});

describe("discount presets (D1)", () => {
  it("hides baht presets that exceed the subtotal", () => {
    expect(availableDiscountPresets(30).map((p) => p.label)).toEqual(["5%", "10%", "20%", "฿10", "฿20"]);
    expect(availableDiscountPresets(500)).toHaveLength(6);
    expect(availableDiscountPresets(0).map((p) => p.type)).toEqual(["percentage", "percentage", "percentage"]);
  });
});

describe("usableVouchers (L3)", () => {
  const vouchers: PosRewardVoucher[] = [
    { redemptionId: "1", code: "RWA", rewardName: "ชาเย็น", rewardType: "product", expiresAt: null },
    { redemptionId: "2", code: "RWB", rewardName: "ลด 10%", rewardType: "discount", expiresAt: null },
    { redemptionId: "3", code: "RWC", rewardName: "เค้ก", rewardType: "product", expiresAt: null },
  ];

  it("drops vouchers already in the bill or applied as the coupon", () => {
    const withReward = cart([item("x", 1, 50), item("reward:RWA", 1, 0, { rewardVoucherCode: "RWA" })]);
    expect(usableVouchers(vouchers, withReward, "rwb").map((v) => v.code)).toEqual(["RWC"]);
  });
});

describe("applyKeypadKey (แป้นตัวเลขบนจอ)", () => {
  it("types phone digits up to 10 and supports back/clear", () => {
    let v = "";
    for (const k of ["0", "8", "1", "2", "3", "4", "5", "6", "7", "8", "9"] as const) v = applyKeypadKey(v, k, { maxLength: 10 });
    expect(v).toBe("0812345678");
    expect(applyKeypadKey(v, "back")).toBe("081234567");
    expect(applyKeypadKey(v, "clear")).toBe("");
    expect(applyKeypadKey("08", ".")).toBe("08");
  });

  it("handles decimals for discount amounts", () => {
    expect(applyKeypadKey("", ".", { allowDecimal: true })).toBe("0.");
    expect(applyKeypadKey("12.5", ".", { allowDecimal: true })).toBe("12.5");
    expect(applyKeypadKey("12.55", "1", { allowDecimal: true })).toBe("12.55");
    expect(applyKeypadKey("0", "5", { allowDecimal: true })).toBe("5");
    expect(applyKeypadKey("0", "0", { allowDecimal: true })).toBe("0");
  });
});

describe("POS wiring", () => {
  const terminal = readFileSync("src/app/pos/PosTerminal.tsx", "utf8");
  const actions = readFileSync("src/app/pos/actions.ts", "utf8");

  it("recalculates the coupon instead of silently dropping it on cart change", () => {
    expect(terminal).toMatch(/recalcAppliedCoupon\(/);
    expect(terminal).toMatch(/appliedCoupon\.cartKey !== couponCartKey\(cart\)/);
    const commitCart = terminal.slice(terminal.indexOf("const commitCart = useCallback"), terminal.indexOf("function updateDiscountDraft"));
    expect(commitCart).not.toContain("setAppliedCoupon(null)");
  });

  it("applies a typed coupon automatically when checking out (C2)", () => {
    const checkout = terminal.slice(terminal.indexOf("function handleCartCheckout()"), terminal.indexOf("/** เช็คบิลจากหน้ารายการโต๊ะ"));
    expect(checkout).toMatch(/applyCouponCode\(typedCode\)/);
    expect(checkout).toMatch(/recalcAppliedCoupon\(appliedCoupon\)/);
  });

  it("clearing the member also drops their voucher chips", () => {
    const clear = terminal.slice(terminal.indexOf("function handleClearCustomer("), terminal.indexOf("function handleRegisterCustomer("));
    expect(clear).toContain("setCustomerVouchers(null)");
  });

  it("keeps the coupon when a member is linked (L4)", () => {
    const select = terminal.slice(terminal.indexOf("function handleSelectCustomer("), terminal.indexOf("function handleClearCustomer("));
    expect(select).not.toContain("setAppliedCoupon(null)");
  });

  it("customer and discount sheets are wide, touch-sized and keypad-enabled for desktop/iPad", () => {
    expect(terminal).toMatch(/title="ส่วนลดท้ายบิล"\s*size="wide"/);
    expect(terminal).toMatch(/title="ลูกค้า \/ คูปอง \/ จอลูกค้า"\s*size="wide"/);
    expect(terminal).toContain('size === "wide" ? "sm:w-[760px]" : "sm:w-[420px]"');
    expect(terminal).toContain('[data-autofocus="true"]');
    const memberSheet = terminal.slice(terminal.indexOf("function MemberSheetSection("), terminal.indexOf("function MemberQuickBar("));
    expect(memberSheet).toContain('label="แป้นเบอร์โทร"');
    expect(memberSheet).toContain("text-base");
    expect(memberSheet).not.toContain("text-xs text-slate-800");
    const discount = terminal.slice(terminal.indexOf("function BillDiscountPanel("), terminal.indexOf("function NumericKeypad("));
    expect(discount).toContain('label="แป้นตัวเลขส่วนลด"');
    expect(discount).toContain("min-h-14");
    // แป้นพิมพ์ทศนิยมได้: ช่องต้องเป็น text + inputMode decimal (number แสดง "0." เป็นค่าว่าง)
    expect(discount).not.toContain('type="number"');
    expect(terminal).toContain(".filter((element) => element.offsetParent !== null)");
  });

  it("labels the code field for reward vouchers too (C3)", () => {
    expect(terminal).toContain("รหัสคูปอง / โค้ดแลกรางวัล");
  });

  it("exposes member quick bar, register and voucher tap-to-use", () => {
    expect(terminal).toContain("function MemberQuickBar(");
    expect(terminal).toContain("registerPosCustomerAction");
    expect(terminal).toContain("listPosCustomerVouchersAction");
    expect(terminal).toContain("pickAutoSelectCustomer(query, result.customers)");
  });

  it("register action is permission-gated, validates phone and logs", () => {
    const register = actions.slice(actions.indexOf("export async function registerPosCustomerAction"), actions.indexOf("export async function submitOrderAction"));
    expect(register).toContain('requirePermission("pos.use")');
    expect(register).toContain('requireFeature("loyaltyPoints")');
    expect(register).toContain("isRegistrablePhone(phone)");
    expect(register).toContain('source: "pos.loyalty"');
    expect(register).toContain('"customer_phone_taken"');
  });

  it("recalc does not count failed conditions as code guesses, but unknown codes still count", () => {
    const evaluate = actions.slice(actions.indexOf("export async function evaluatePosCouponAction"), actions.indexOf("export async function submitOrderAction"));
    expect(evaluate).toContain("opts?: { recalc?: boolean }");
    expect(evaluate).toMatch(/if \(!\(opts\?\.recalc && !evaluation\.ok\)\)/);
    expect(evaluate).toMatch(/isCouponAttemptBlocked\(ctx\.storeId\)/);
    expect(evaluate).toMatch(/succeeded: false \}\);\s*return \{ couponId: null, discount: 0, normalizedCode: null, error: "ไม่พบคูปองนี้" \}/);
    expect(terminal).toContain("evaluatePosCouponAction(coupon.code, evalCart, customerId, { recalc: true })");
  });

  it("recalc network failure clears the pending state and the stale discount", () => {
    const recalc = terminal.slice(terminal.indexOf("async function recalcAppliedCoupon("), terminal.indexOf("const couponIsStale"));
    expect(recalc).toMatch(/catch \{[\s\S]*setCouponRecalcPending\(false\);[\s\S]*setAppliedCoupon\(null\);/);
    // เน็ตหลุด = เก็บโค้ดไว้ให้กดชำระแล้วลองใหม่; ไม่ผ่านเงื่อนไข = ล้างโค้ด (ไม่งั้นกดชำระจะติดคูปองเดิมซ้ำ)
    expect(recalc).toContain("setCouponCode(coupon.code)");
  });

  it("register looks up inactive owners of a taken phone", () => {
    const register = actions.slice(actions.indexOf("export async function registerPosCustomerAction"), actions.indexOf("export async function submitOrderAction"));
    expect(register).toContain("includeInactive: true");
    expect(register).toContain("match && match.isActive");
  });

  it("voucher list checks the customer id and stays store-scoped", () => {
    const list = actions.slice(actions.indexOf("export async function listPosCustomerVouchersAction"), actions.indexOf("export async function registerPosCustomerAction"));
    expect(list).toContain("UUID_PATTERN.test(customerId)");
    expect(list).toContain("listPendingRewardVouchersForCustomer(ctx.storeId, customerId)");
  });
});
