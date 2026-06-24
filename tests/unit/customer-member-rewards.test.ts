import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");
const migrationPath = "supabase/migrations/20260624103000_customer_member_rewards.sql";

describe("customer member rewards", () => {
  it("adds the database contract for member login, rewards, and safe redemption", () => {
    expect(existsSync(join(root, migrationPath))).toBe(true);
    const migration = read(migrationPath);

    expect(migration).toContain("create table if not exists loyalty_rewards");
    expect(migration).toContain("create table if not exists loyalty_reward_redemptions");
    expect(migration).toContain("create table if not exists customer_member_portal_links");
    expect(migration).toContain("create table if not exists customer_member_otps");
    expect(migration).toContain("create table if not exists customer_member_sessions");
    expect(migration).toContain("alter table loyalty_ledger add constraint loyalty_ledger_type_check");
    expect(migration).toContain("create or replace function adjust_customer_loyalty_points");
    expect(migration).toContain("create or replace function redeem_loyalty_reward");
    expect(migration).toContain("for update");
    expect(migration).toContain("session_token_hash");
    expect(migration).toContain("revoke all on table customer_member_otps from authenticated");
    expect(migration).toContain("revoke execute on function redeem_loyalty_reward");
    expect(migration).toContain("revoke execute on function adjust_customer_loyalty_points");
    expect(migration).toContain("grant execute on function adjust_customer_loyalty_points");
    expect(migration).toContain("to service_role");
    expect(migration).toContain("customer_member_portal_links: manager+ can write");
    expect(migration).toContain("coupon_redemptions_customer_limit_guard");
    expect(migration).toContain("and new.customer_id is null then");
  });

  it("wires admin controls for manual points, rewards, and coupon user limits", () => {
    const actions = read("src/app/(dashboard)/customers/actions.ts");
    const manager = read("src/app/(dashboard)/customers/CustomerLoyaltyManager.tsx");
    const page = read("src/app/(dashboard)/customers/page.tsx");
    const loyaltyRepository = read("src/modules/loyalty/repository.ts");
    const promotionRepository = read("src/modules/promotions/repository.ts");

    expect(page).toContain("listLoyaltyRewardsForStore");
    expect(page).toContain("getActiveMemberPortalLinkForStore");
    expect(manager).toContain("adjustCustomerPointsAction");
    expect(manager).toContain("saveRewardAction");
    expect(manager).toContain("deleteRewardAction");
    expect(manager).toContain("generateMemberPortalQrAction");
    expect(manager).toContain("maxRedemptionsPerCustomer");
    expect(manager).toContain("1 user ใช้ได้");
    expect(manager).toContain("QR สมัครสมาชิก");
    expect(actions).toContain('requirePermission("settings.manage_store")');
    expect(actions).toContain("adjustCustomerPoints");
    expect(actions).toContain("saveLoyaltyReward");
    expect(actions).toContain("deleteLoyaltyReward");
    expect(actions).toContain("generateMemberPortalLink");
    expect(loyaltyRepository).toContain("listLoyaltyRewardsForStore");
    expect(loyaltyRepository).toContain("adjustCustomerPoints");
    expect(loyaltyRepository).toContain("saveLoyaltyReward");
    expect(loyaltyRepository).toContain("redeemRewardForCurrentCustomer");
    expect(promotionRepository).toContain("maxRedemptionsPerCustomer");
  });

  it("adds a QR-only public customer member portal that uses SMSKUB OTP before showing points", () => {
    const page = read("src/app/member/[storeSlug]/page.tsx");
    const actions = read("src/app/member/[storeSlug]/actions.ts");
    const portal = read("src/app/member/[storeSlug]/MemberPortal.tsx");
    const repository = read("src/modules/customers/member-repository.ts");
    const sms = read("src/modules/notifications/smskub.ts");

    expect(page).toContain("MemberPortal");
    expect(page).toContain("getStoreBySlug");
    expect(page).toContain("portalCode");
    expect(actions).toContain("requestMemberOtpAction");
    expect(actions).toContain("verifyMemberOtpAction");
    expect(actions).toContain("getCustomerPortalData");
    expect(actions).toContain("redeemRewardForCurrentCustomer");
    expect(actions).toContain("sendSmskubOtp");
    expect(actions).not.toContain("signInWithOtp");
    expect(portal).toContain("สมัครสมาชิก");
    expect(portal).toContain("เข้าสู่ระบบ");
    expect(portal).toContain("แต้มของฉัน");
    expect(portal).toContain("แลกของรางวัล");
    expect(portal).toContain("ต้องเปิดจาก QR ของร้าน");
    expect(repository).toContain("customer_member_sessions");
    expect(repository).toContain("customer_member_portal_links");
    expect(repository).toContain("getCustomerPortalData");
    expect(repository).toContain("createOrFindMemberCustomer");
    expect(repository).toContain("findCustomerByEmail");
    expect(repository).toContain("กรุณาเข้าสู่ระบบหรือแจ้งร้านเพื่อยืนยันข้อมูลสมาชิก");
    const createOrFindBlock = repository.slice(
      repository.indexOf("export async function createOrFindMemberCustomer"),
      repository.indexOf("export async function requestMemberOtp"),
    );
    expect(createOrFindBlock).not.toContain("existingByEmail");
    expect(createOrFindBlock).not.toContain('.ilike("email", email)');
    expect(sms).toContain("SMSKUB_API_KEY");
    expect(sms).toContain("SMSKUB_SENDER_NAME");
    expect(sms).toContain("SMSKUB_API_URL");
  });
});
