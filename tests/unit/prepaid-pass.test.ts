import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PREPAID_PASS_TERMS,
  cartHasPassItems,
  formatPassExpiry,
  groupPassRedemptions,
  isPassCartItem,
  passUnitValue,
  validatePassPlanInput,
  type PassPlanInput,
} from "@/modules/prepaid-passes/rules";
import { repriceCartForTier } from "@/modules/pos/cart";
import type { Cart, CartItem } from "@/modules/pos/types";

const read = (path: string) => readFileSync(path, "utf8");
const MIGRATION = "supabase/migrations/20261116120000_prepaid_passes.sql";

function plan(overrides: Partial<PassPlanInput> = {}): PassPlanInput {
  return {
    name: "แพ็กอเมริกาโน่ 10 แก้ว",
    credits: 10,
    price: 350,
    validDays: 90,
    redeemScope: "store",
    terms: DEFAULT_PREPAID_PASS_TERMS,
    productIds: ["p-1"],
    isActive: true,
    ...overrides,
  };
}

function line(overrides: Partial<CartItem> = {}): CartItem {
  return {
    key: "k",
    productId: "p-1",
    productName: "อเมริกาโน่",
    categoryId: "c",
    variant: null,
    modifiers: [],
    quantity: 1,
    unitPrice: 0,
    totalPrice: 0,
    ...overrides,
  };
}

describe("แบบแพ็ก", () => {
  it("ตัวอย่างผู้ใช้ อเมริกาโน่ 10 แก้ว ฿350 ผ่าน และตกแก้วละ ฿35", () => {
    expect(validatePassPlanInput(plan())).toBeNull();
    expect(passUnitValue(350, 10)).toBe(35);
  });

  it("ตรวจค่าที่ผิด", () => {
    expect(validatePassPlanInput(plan({ name: " " }))).toContain("ชื่อ");
    expect(validatePassPlanInput(plan({ credits: 0 }))).toContain("สิทธิ์");
    expect(validatePassPlanInput(plan({ credits: 2.5 }))).toContain("สิทธิ์");
    expect(validatePassPlanInput(plan({ price: 0 }))).toContain("ราคา");
    expect(validatePassPlanInput(plan({ price: 10.555 }))).toContain("ทศนิยม");
    expect(validatePassPlanInput(plan({ validDays: 0 }))).toContain("อายุ");
    expect(validatePassPlanInput(plan({ validDays: null }))).toBeNull();
    expect(validatePassPlanInput(plan({ terms: "สั้นไป" }))).toContain("เงื่อนไข");
    expect(validatePassPlanInput(plan({ productIds: [] }))).toContain("เมนู");
  });

  it("เงื่อนไขเริ่มต้นบอกชัดเรื่องไม่คืนเงิน ห้ามโอน ต้องใช้รหัส และหมดอายุ", () => {
    expect(DEFAULT_PREPAID_PASS_TERMS).toContain("ไม่สามารถขอคืนเงิน");
    expect(DEFAULT_PREPAID_PASS_TERMS).toContain("โอนหรือแบ่งให้ผู้อื่นไม่ได้");
    expect(DEFAULT_PREPAID_PASS_TERMS).toContain("รหัสใช้สิทธิ์ 5 นาที");
    expect(DEFAULT_PREPAID_PASS_TERMS).toContain("หมดอายุ");
    expect(DEFAULT_PREPAID_PASS_TERMS.split("\n")).toHaveLength(6);
  });

  it("แสดงวันหมดอายุ", () => {
    expect(formatPassExpiry(null)).toBe("ไม่หมดอายุ");
    expect(formatPassExpiry("2027-02-01T00:00:00Z")).toContain("ใช้ได้ถึง");
  });
});

describe("บรรทัดใช้แพ็กในตะกร้า", () => {
  it("รวมจำนวนต่อ (แพ็ก, เมนู) ก่อนจองสิทธิ์", () => {
    const items = [
      line({ key: "a", prepaidPassId: "pass-1", productId: "p-1" }),
      line({ key: "b", prepaidPassId: "pass-1", productId: "p-1" }),
      line({ key: "c", prepaidPassId: "pass-1", productId: "p-2" }),
      line({ key: "d", productId: "p-1", unitPrice: 65, totalPrice: 65 }),
    ];
    expect(groupPassRedemptions(items)).toEqual([
      { passId: "pass-1", productId: "p-1", quantity: 2 },
      { passId: "pass-1", productId: "p-2", quantity: 1 },
    ]);
    expect(isPassCartItem(items[3])).toBe(false);
    expect(cartHasPassItems({ items })).toBe(true);
    expect(cartHasPassItems({ items: [items[3]] })).toBe(false);
  });

  it("เปลี่ยนระดับราคาลูกค้าแล้วบรรทัดแพ็ก (฿0) ยังอยู่ ไม่ถูก reprice", () => {
    const cart: Cart = {
      storeId: "s",
      items: [line({ key: "pass:1", prepaidPassId: "pass-1" })],
      subtotal: 0,
      discount: 0,
      total: 0,
    };
    const next = repriceCartForTier(cart, [], "retail");
    expect(next.items).toHaveLength(1);
    expect(next.items[0].prepaidPassId).toBe("pass-1");
    expect(next.items[0].totalPrice).toBe(0);
  });
});

describe("migration แพ็ก — ความถูกต้องของเงินและสิทธิ์", () => {
  const sql = read(MIGRATION);

  it("ทุกตารางเปิด RLS และเขียนได้ผ่าน RPC/trigger เท่านั้น", () => {
    for (const table of ["prepaid_pass_plans", "prepaid_pass_plan_products", "prepaid_passes", "prepaid_pass_redemptions", "prepaid_pass_events"]) {
      expect(sql).toContain(`alter table public.${table} enable row level security;`);
      expect(sql).toContain(`revoke all on table public.${table} from anon, authenticated;`);
      expect(sql).toContain(`grant select on table public.${table} to authenticated;`);
    }
  });

  it("ขายแพ็กต้องมีสมาชิกที่มีเบอร์ และออกแพ็กครั้งเดียวต่อบรรทัด", () => {
    expect(sql).toContain("raise exception 'ขายแพ็กล่วงหน้าต้องผูกสมาชิกที่มีเบอร์โทรในบิล'");
    expect(sql).toContain("unique (order_item_id, order_item_seq)");
    expect(sql).toContain("on conflict (order_item_id, order_item_seq) do nothing");
    expect(sql).toContain("v_pass_id := null;");
  });

  it("มูลค่าต่อสิทธิ์คิดจาก total_price ที่หักส่วนลดบรรทัดแล้ว (ไม่หักซ้ำ)", () => {
    expect(sql).toContain("round((v_item.total_price / greatest(v_item.quantity, 1)) / v_item.credits, 4)");
    expect(sql).not.toContain("total_price - coalesce");
  });

  it("ไม่คืนเงิน: void บิลขายแพ็กได้เฉพาะแพ็กที่ยังไม่ถูกใช้", () => {
    expect(sql).toContain("if v_pass.credits_remaining <> v_pass.credits_total then");
    expect(sql).toContain("ยกเลิกบิลนี้ไม่ได้ เพราะแพ็ก");
  });

  it("void บิลที่ใช้แพ็ก → คืนสิทธิ์", () => {
    expect(sql).toContain("if new.status in ('voided', 'cancelled', 'refunded') then");
    expect(sql).toContain("set status = 'reversed'");
    expect(sql).toContain("after update of status on public.orders");
  });

  it("จองสิทธิ์ต้องมีผลยืนยันรหัสที่ยังไม่หมดอายุ/ยังไม่ใช้ และแพ็กเป็นของคนนั้น", () => {
    const reserve = sql.slice(sql.indexOf("function public.reserve_prepaid_pass_redemption"), sql.indexOf("function public.find_pos_order_by_idempotency_key"));
    expect(reserve).toContain("if v_ver.expires_at <= now() then");
    expect(reserve).toContain("if v_ver.consumed_at is not null");
    // ล็อกผลยืนยัน + ผูกกับ idempotency key ของบิล กันสองบิลใช้รหัสเดียว (review CRIT-1)
    expect(reserve).toMatch(/where id = p_verification_id and store_id = p_store_id\s+for update;/);
    expect(reserve).toContain("v_ver.checkout_key <> trim(p_checkout_key)");
    expect(reserve).toContain("v_pass.member_identity_id <> v_ver.member_identity_id");
    expect(reserve).toContain("for update;");
    expect(reserve).toContain("prepaid_pass_covers_product(p_pass_id, p_store_id, p_product_id)");
    expect(reserve).toContain("if v_pass.credits_remaining < p_quantity then");
  });

  it("แนบซ้ำ (ส่งบิลซ้ำ) ไม่ตัดแพ็กซ้ำ", () => {
    expect(sql).toContain("return 'already_attached';");
    expect(sql).toContain("from public.pos_order_idempotency_keys");
  });

  it("ปิดบิล ฿0 ตัดสต็อกแบบเดียวกับ close_pos_order_payment และไม่มีแถว payments", () => {
    const zero = sql.slice(sql.indexOf("function public.close_pos_order_zero_total"), sql.indexOf("function public.prepaid_passes_on_order_status"));
    expect(zero).toContain("perform public.snapshot_order_item_stock_pools(p_order_id, p_store_id, v_order.organization_id);");
    expect(zero).toContain("perform public.deduct_order_stock_pools(p_order_id, p_store_id, v_order.organization_id, p_processed_by_user_id);");
    expect(zero).toContain("raise exception 'สินค้าเหลือไม่พอ';");
    expect(zero).toContain("if v_order.total <> 0 then");
    expect(zero).toContain("if v_order.coupon_id is not null then");
    expect(zero).toContain("บิลยอด ฿0 ปิดได้เฉพาะบิลที่ใช้แพ็กล่วงหน้า");
    expect(zero).not.toContain("insert into public.payments");

    const close = read("supabase/migrations/20260918030000_qr_stock_reservation.sql");
    expect(close).toContain("perform public.snapshot_order_item_stock_pools(");
    expect(close).toContain("perform public.deduct_order_stock_pools(");
  });

  it("ตั้งแบบแพ็กได้เฉพาะ owner/admin", () => {
    expect(sql).toContain("auth_user_role_in_store(v_store.organization_id, p_store_id, 'admin')");
  });
});

describe("ทางเข้าโค้ด POS", () => {
  const actions = read("src/app/pos/actions.ts");

  it("พักบิล/ตั๋วที่มีบรรทัดใช้แพ็กไม่ได้", () => {
    const submit = actions.slice(actions.indexOf("export async function submitOrderAction"), actions.indexOf("async function createPosOrderCore"));
    expect(submit).toContain("if (cartHasPassItems(cart))");
  });

  it("สร้างออเดอร์: ต้องมีผลยืนยัน จองเป็นขั้นสุดท้าย คืนสิทธิ์เมื่อพัง และเช็กสมาชิกตรงกัน", () => {
    const core = actions.slice(actions.indexOf("async function createPosOrderCore"), actions.indexOf("export async function collectPaymentAction"));
    expect(core).toContain('error: "ต้องยืนยันรหัสสมาชิกก่อนใช้แพ็ก"');
    expect(core).toContain("บิลที่ใช้แพ็กทั้งบิลใช้คูปองร่วมไม่ได้");
    expect(core).toContain("checkoutKey: opts!.idempotencyKey!.trim()");
    expect(core).toContain("findOrderIdByIdempotencyKey(ctx.storeId, opts.idempotencyKey)");
    expect(core).toContain("reserved.data.customerId !== opts?.customerId?.trim()");
    expect(core).toContain("await releaseReservedVouchers();");
    expect(core).toContain("releasePassRedemption(ctx.storeId, redemptionId)");
    expect(core).toContain("attachPassRedemptions(ctx.storeId, result.data.id, passIds)");
    expect(core.indexOf("reservePassRedemption(")).toBeGreaterThan(core.indexOf("reserveProductRewardVoucher("));
  });

  it("บิล ฿0 ต้องมีบรรทัดแพ็ก ไม่งั้นปฏิเสธ", () => {
    const checkout = actions.slice(actions.indexOf("export async function checkoutAndPayAction"));
    expect(checkout).toContain("if (payment.amount === 0) {");
    expect(checkout).toContain("if (!cartHasPassItems(cart)) {");
    expect(checkout).toContain("closeZeroTotalAndLoad(createdZero.orderId, createdZero.orderNumber, ctx, user.id)");
  });

  it("หน้าจอ POS: ขายแพ็กต้องมีสมาชิกที่มีเบอร์ + ยืนยันเงื่อนไข และบิล ฿0 มีปุ่มยืนยันใช้แพ็ก", () => {
    const ui = read("src/app/pos/PosTerminal.tsx");
    expect(ui).toContain("if (!selectedCustomer?.phone) {");
    expect(ui).toContain('confirmLabel: "ลูกค้ารับทราบเงื่อนไข · ใส่ตะกร้า"');
    expect(ui).toContain("const zeroTotalPass = cart.total === 0 && cartHasPassItems(cart);");
    expect(ui).toContain("memberVerificationId: activeMemberVerification?.verificationId ?? null");
  });
});

describe("P1b ซื้อแพ็กออนไลน์ผ่าน Beam + หมดอายุ", () => {
  const sql = read("supabase/migrations/20261116130000_prepaid_pass_online.sql");

  it("trigger ออกแพ็กครั้งเดียวต่อคำสั่งซื้อ และยอดไม่ตรง → ให้ร้านตรวจ", () => {
    // เงินเข้าหลังยกเลิก/หมดอายุ (LATE_PAID) ก็ต้องออกแพ็ก — review P1b Major-1
    expect(sql).toContain("and new.status in ('PAID', 'LATE_PAID')");
    expect(sql).toContain("and old.status not in ('PAID', 'LATE_PAID')");
    expect(sql).toContain("if new.status = 'LATE_PAID' then");
    expect(sql).toContain("on conflict (purchase_id) do nothing");
    expect(sql).toContain("add column if not exists purchase_id uuid unique");
    expect(sql).toContain("new.status := 'REVIEW_REQUIRED';");
    expect(sql).toContain("'online', null");
  });

  it("ตาราง/ฟังก์ชันใหม่ปิดสิทธิ์ anon และ RLS เปิด", () => {
    expect(sql).toContain("alter table public.prepaid_pass_purchases enable row level security;");
    expect(sql).toContain("revoke all on table public.prepaid_pass_purchases from anon, authenticated;");
    expect(sql).toContain("revoke all on function public.issue_prepaid_pass_on_gateway_paid() from public, anon, authenticated;");
    expect(sql).toContain("revoke all on function public.expire_prepaid_passes() from public, anon, authenticated;");
  });

  it("cron หมดอายุทุกวัน 00:10 เวลาไทย และรันซ้ำได้", () => {
    expect(sql).toContain("select cron.schedule('expire-prepaid-passes', '10 17 * * *'");
    expect(sql).toContain("perform cron.unschedule('expire-prepaid-passes');");
    expect(sql).toContain("for update skip locked");
  });

  it("คืนสิทธิ์เข้าแพ็กเฉพาะแพ็กที่ยังใช้ได้ (แพ็กหมดอายุไม่ได้สิทธิ์คืน)", () => {
    const p1a = read(MIGRATION);
    expect(p1a.match(/where id = v_red\.pass_id and status = 'active'/g)?.length).toBe(3);
  });

  it("หน้าสมาชิก: ต้องติ๊กยอมรับเงื่อนไข (ไม่คืนเงิน) ก่อนสร้าง QR และร้านไม่มี Beam ซื้อออนไลน์ไม่ได้", () => {
    const portal = read("src/modules/prepaid-passes/member-portal.ts");
    expect(portal).toContain('if (!input.termsAccepted) return { data: null, error: "กรุณาอ่านและติ๊กยอมรับเงื่อนไขก่อนซื้อ" };');
    expect(portal).toContain("prepaidPassPurchaseId: purchase.id");
    expect(portal).toContain("minLookupIntervalMs: 10_000");
    // แพ็กที่ยังใช้ได้แยก query จากประวัติ — review P1b Major-2
    expect(portal).toContain('.gt("credits_remaining", 0)');
    const card = read("src/app/member/[storeSlug]/MemberPassesCard.tsx");
    expect(card).toContain("ไม่สามารถขอคืนเงินได้ทุกกรณี");
    expect(card).toContain("disabled={!accepted || isPending}");
    expect(card).toContain("disabled={!view.canBuyOnline || isPending}");
  });

  it("ประวัติ Beam นับรายการซื้อแพ็กเป็น attached", () => {
    const beam = read("src/modules/payments/beam-service.ts");
    expect(beam).toContain("attached: Boolean(r.pos_payment_id || r.music_request_id || r.prepaid_pass_purchase_id || r.online_order_id || r.ad_order_id)");
  });
});

describe("O1 หมด Enterprise ยังใช้แพ็กที่จ่ายแล้วได้", () => {
  it("grace = ไม่ใช่ Enterprise แต่มีแพ็กใช้ได้ค้างในองค์กร", () => {
    const grace = read("src/modules/prepaid-passes/grace.ts");
    expect(grace).toContain('.eq("status", "active")');
    expect(grace).toContain('.gt("credits_remaining", 0)');
    expect(grace).toContain("if (canUseMemberPrivileges(billing)) return { privileges: true, grace: false };");
  });

  it("POS: ยืนยันรหัส/ดูแพ็ก/ใช้แพ็กผ่าน grace ได้ แต่ขายแพ็กใหม่ต้อง Enterprise", () => {
    const actions = read("src/app/pos/actions.ts");
    expect(actions.match(/canRedeemPasses\(/g)?.length).toBeGreaterThanOrEqual(3);
    expect(actions).toContain('if (customerId && passGroups.length === 0) await requireFeature("loyaltyPoints");');
    // บิลผูกลูกค้าช่วงแพ็กค้าง: ปิดแบบไม่ให้แต้ม ไม่โยน error (review O1 Critical/Major)
    expect(actions.match(/await customerRewardsCloseAllowed\(ctx\.organizationId\)/g)?.length).toBe(2);
    expect(actions).toContain("if (access.grace) return false;");
    expect(read(MIGRATION)).toContain("create index if not exists prepaid_passes_org_active_idx");
    const page = read("src/app/pos/page.tsx");
    expect(page).toContain("const memberCodeEnabled = memberCodeSwitch && ((loyaltyEnabled && passAccess.privileges) || passGraceMode);");
    expect(page).toContain("loyaltyEnabled && canUseMemberPrivileges(resolvedBillingState) ? await listPassSaleProducts(ctx.storeId) : []");
    const ui = read("src/app/pos/PosTerminal.tsx");
    expect(ui).toContain("codeOnly={passGraceMode && !loyaltyEnabled}");
  });

  it("หน้าสมาชิก: เปิดได้แบบแพ็กอย่างเดียว ไม่มีแลกรางวัล/รับแต้ม และไม่ขายแพ็กใหม่", () => {
    const repo = read("src/modules/customers/member-repository.ts");
    expect(repo).toContain("if (passesOnly && !passGrace) {");
    expect(repo).toContain('if (portal.passesOnly && input.mode === "register") {');
    expect(repo).toContain("memberCodeEnabled: (portal.memberPrivileges || portal.passGrace) && memberCodeSwitch,");
    const actions = read("src/app/member/[storeSlug]/actions.ts");
    expect(actions).toContain('if (portalData.passesOnly) return { error: "ร้านปิดระบบแลกของรางวัลแล้ว" };');
    expect(actions).toContain('if (portalData.passesOnly) return { error: "ร้านปิดระบบสะสมแต้มแล้ว", claimed: null };');
    expect(actions).toContain('if (!portalData.memberPrivileges) return { error: "ร้านนี้ยังไม่เปิดขายแพ็กออนไลน์" };');
  });
});
