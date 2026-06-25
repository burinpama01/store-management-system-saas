import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");
const migrationPath = "supabase/migrations/20260625130000_loyalty_reward_vouchers.sql";

describe("loyalty reward vouchers", () => {
  it("adds the migration contract: typed rewards, voucher fields, coupon issuance, guards", () => {
    expect(existsSync(join(root, migrationPath))).toBe(true);
    const migration = read(migrationPath);

    // typed rewards + image + product link + manual code mode
    expect(migration).toContain("add column if not exists reward_type text not null default 'product'");
    expect(migration).toContain("add column if not exists discount_kind text");
    expect(migration).toContain("add column if not exists discount_value numeric(12,2)");
    expect(migration).toContain("add column if not exists reward_product_id uuid");
    expect(migration).toContain("add column if not exists image_url text");
    expect(migration).toContain("add column if not exists code_mode text not null default 'auto'");
    expect(migration).toContain("loyalty_rewards_discount_fields_check");
    expect(migration).toContain("references products(id) on delete set null");

    // voucher columns on redemptions
    expect(migration).toContain("add column if not exists voucher_code text");
    expect(migration).toContain("add column if not exists coupon_id uuid");
    expect(migration).toContain("add column if not exists expires_at timestamptz");
    expect(migration).toContain("loyalty_reward_redemptions_voucher_code_idx");

    // redeem now returns a voucher (jsonb) and issues a single-use 30-day coupon for discounts
    expect(migration).toContain("drop function if exists redeem_loyalty_reward(uuid, uuid, uuid, uuid, text)");
    expect(migration).toContain("returns jsonb");
    expect(migration).toContain("now() + interval '30 days'");
    expect(migration).toContain("if v_reward.reward_type = 'discount' then");
    expect(migration).toContain("max_redemptions");
    expect(migration).toContain("jsonb_build_object");
    expect(migration).toContain("grant execute on function redeem_loyalty_reward(uuid, uuid, uuid, uuid, text) to service_role");

    // single-use sync trigger marks the voucher used when its coupon is redeemed at POS
    expect(migration).toContain("create or replace function sync_reward_voucher_on_coupon_redemption");
    expect(migration).toContain("coupon_redemptions_sync_reward_voucher");
    expect(migration).toContain("status = 'fulfilled'");

    // unpredictable voucher token (anti brute-force) + attempt log table
    expect(migration).toContain("create or replace function gen_loyalty_voucher_token");
    expect(migration).toContain("excludes 0 O 1 I L");
    expect(migration).toContain("create table if not exists pos_coupon_code_attempts");
    expect(migration).toContain("alter table pos_coupon_code_attempts enable row level security");
  });

  it("models typed rewards + voucher result in the loyalty repository", () => {
    const repo = read("src/modules/loyalty/repository.ts");

    expect(repo).toContain("export type LoyaltyRewardType = \"discount\" | \"product\"");
    expect(repo).toContain("rewardType: LoyaltyRewardType");
    expect(repo).toContain("imageUrl?: string | null");
    expect(repo).toContain("codeMode: LoyaltyRewardCodeMode");
    expect(repo).toContain("reward_product_id: isDiscount ? null");
    expect(repo).toContain("manual_code: input.codeMode === \"manual\"");

    // redeem returns a typed voucher parsed from the jsonb RPC result
    expect(repo).toContain("export interface RewardVoucherResult");
    expect(repo).toContain("function parseRewardVoucher");
    expect(repo).toContain("data: parseRewardVoucher(data)");
  });

  it("validates the new reward fields in the admin action", () => {
    const actions = read("src/app/(dashboard)/customers/actions.ts");

    expect(actions).toContain('text(formData, "rewardType")');
    expect(actions).toContain('text(formData, "discountValue")');
    expect(actions).toContain('text(formData, "rewardProductId")');
    expect(actions).toContain('text(formData, "imageUrl")');
    expect(actions).toContain('text(formData, "manualCode")');
    expect(actions).toContain("กรุณาระบุมูลค่าส่วนลดของรางวัล");
    expect(actions).toContain("กรุณาเลือกสินค้าในระบบสำหรับของรางวัลแบบสินค้า");
    expect(actions).toContain("รหัสที่กำหนดเองต้องยาว 3–24 ตัวอักษร");
  });

  it("renders the typed reward form with image upload + product picker", () => {
    const manager = read("src/app/(dashboard)/customers/CustomerLoyaltyManager.tsx");

    expect(manager).toContain("import { ImageUpload }");
    expect(manager).toContain("function RewardForm");
    expect(manager).toContain('name="rewardType"');
    expect(manager).toContain('name="discountValue"');
    expect(manager).toContain('name="rewardProductId"');
    expect(manager).toContain('name="codeMode"');
    expect(manager).toContain("rewardProducts");
  });

  it("exposes voucher data to the member portal redeem flow", () => {
    const memberRepo = read("src/modules/customers/member-repository.ts");
    const memberActions = read("src/app/member/[storeSlug]/actions.ts");
    const portal = read("src/app/member/[storeSlug]/MemberPortal.tsx");

    expect(memberRepo).toContain("voucherCode: string | null");
    expect(memberRepo).toContain("rewardType: \"discount\" | \"product\"");
    expect(memberRepo).toContain("rewardImageUrl: string | null");
    expect(memberRepo).toContain("reward_type, discount_kind, discount_value, image_url");

    expect(memberActions).toContain("RedeemRewardActionResult");
    expect(memberActions).toContain("voucher: result.data");

    // portal: voucher confirmation modal, history tab, clickable detail modal, reward image
    expect(portal).toContain("โค้ดแลกรับ");
    expect(portal).toContain("รายการแลกของรางวัล");
    expect(portal).toContain("setDetail(redemption)");
    expect(portal).toContain("closeVoucher");
    expect(portal).toContain("redemptionStatusBadge");
    expect(portal).toContain("reward.imageUrl");
  });

  it("guards POS coupon entry against brute-force guessing", () => {
    const guard = read("src/modules/promotions/coupon-attempt-guard.ts");
    const posActions = read("src/app/pos/actions.ts");

    expect(guard).toContain("isCouponAttemptBlocked");
    expect(guard).toContain("recordCouponAttempt");
    expect(guard).toContain("pos_coupon_code_attempts");
    expect(guard).toContain("MAX_FAILED_ATTEMPTS");
    expect(posActions).toContain("isCouponAttemptBlocked");
    expect(posActions).toContain("recordCouponAttempt");
    expect(posActions).toContain("กรอกรหัสคูปองผิดบ่อยเกินไป");
  });

  it("resolves + consumes product reward vouchers at POS as a ฿0 line", () => {
    const repo = read("src/modules/loyalty/repository.ts");
    const posActions = read("src/app/pos/actions.ts");
    const terminal = read("src/app/pos/PosTerminal.tsx");
    const posTypes = read("src/modules/pos/types.ts");

    // repository: find by code (product reward only) + single-use atomic consume
    expect(repo).toContain("export async function findProductRewardVoucher");
    expect(repo).toContain("export async function consumeProductRewardVoucher");
    expect(repo).toContain('.is("used_at", null)');

    // POS coupon action also recognises product reward vouchers
    expect(posActions).toContain("findProductRewardVoucher");
    expect(posActions).toContain("rewardProduct");

    // checkout validates voucher↔product, appends a ฿0 line, consumes after order exists
    expect(posActions).toContain("rewardItems");
    expect(posActions).toContain("โค้ดของรางวัลใช้ไม่ได้หรือหมดอายุ");
    expect(posActions).toContain("โค้ดของรางวัลไม่ตรงกับสินค้า");
    expect(posActions).toContain("consumeProductRewardVoucher");

    // cart line model + terminal wiring
    expect(posTypes).toContain("rewardVoucherCode?: string");
    expect(terminal).toContain("appendRewardLine");
    expect(terminal).toContain("result.rewardProduct");
  });
});
