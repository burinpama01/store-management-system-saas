import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");
const migrationPath = "supabase/migrations/20260624103000_customer_member_rewards.sql";
const enterprisePackageMigrationPath =
  "supabase/migrations/20260624235000_enterprise_member_package_settings.sql";
const stableMemberQrMigrationPath =
  "supabase/migrations/20260625013000_member_portal_single_active_link.sql";

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
    expect(manager).toContain("QR ถาวรของร้าน");
    expect(manager).toContain("สร้าง/แสดง QR ถาวร");
    expect(manager).not.toContain("สร้าง QR ใหม่");
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
    const middleware = read("src/server/integrations/supabase/middleware.ts");
    const sms = read("src/modules/notifications/smskub.ts");

    expect(page).toContain("MemberPortal");
    expect(page).not.toContain("getStoreBySlug");
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
    expect(repository).toContain("getStoreForMemberPortal");
    expect(repository).toContain('from("stores")');
    expect(repository).toContain("mapStore(data)");
    expect(repository).toContain("getOrganizationBillingState");
    expect(repository).toContain("canUseFeature");
    expect(repository).toContain("แพ็กเกจ Enterprise");
    expect(repository).toContain("getCustomerPortalData");
    expect(repository).toContain("createOrFindMemberCustomer");
    expect(repository).toContain("findCustomerByEmail");
    expect(repository).toContain("กรุณาเข้าสู่ระบบหรือแจ้งร้านเพื่อยืนยันข้อมูลสมาชิก");
    expect(middleware).toContain('request.nextUrl.pathname === "/member"');
    expect(middleware).toContain('request.nextUrl.pathname.startsWith("/member/")');
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

  it("keeps the member signup QR stable for each store", () => {
    const repository = read("src/modules/customers/member-repository.ts");
    const actions = read("src/app/(dashboard)/customers/actions.ts");

    const generateBlock = repository.slice(
      repository.indexOf("export async function generateMemberPortalLink"),
      repository.length,
    );

    expect(generateBlock).toContain("getActiveMemberPortalLinkForStore(input.storeId)");
    expect(generateBlock).toContain("if (activeLink.data) return { data: activeLink.data, error: null };");
    expect(generateBlock).not.toContain(".update({ is_active: false");
    expect(generateBlock).toContain('token: randomUUID().replace(/-/g, "")');
    expect(actions).toContain("/member/${storeSlug}?code=");
    expect(actions).not.toContain("Date.now()");

    const stableQrMigration = read(stableMemberQrMigrationPath);
    expect(stableQrMigration).toContain("customer_member_portal_links_one_active_per_store_idx");
    expect(stableQrMigration).toContain("on customer_member_portal_links(store_id)");
    expect(stableQrMigration).toContain("where is_active = true");
    expect(stableQrMigration).toContain("row_number() over (partition by store_id order by created_at desc, id desc)");
  });

  it("keeps public member portal lookup errors generic while logging masked diagnostics server-side", () => {
    const repository = read("src/modules/customers/member-repository.ts");
    const portal = read("src/app/member/[storeSlug]/MemberPortal.tsx");

    const resolveBlock = repository.slice(
      repository.indexOf("async function resolvePortalLink"),
      repository.indexOf("async function listActiveRewards"),
    );

    expect(resolveBlock).toContain("MEMBER_PORTAL_LOOKUP_ERROR_MESSAGE");
    expect(resolveBlock).toContain("getStoreForMemberPortal(supabase, storeSlug)");
    expect(resolveBlock).toContain("store: null");
    expect(resolveBlock).toContain('console.warn("[member-portal] portal link lookup failed"');
    expect(resolveBlock).toContain("codePrefix: cleanCode.slice(0, 6)");
    expect(resolveBlock).not.toContain("return { store: storeRes.data, link: null, error: mapError(error).userMessage }");
    expect(resolveBlock).not.toContain("return { store: storeRes.data, link: null");
    expect(portal).toContain('{data.error ?? "ลิงก์นี้ใช้ได้เฉพาะ QR ที่ร้านสร้างให้เท่านั้น"}');
  });

  it("moves member-commerce pricing copy into Enterprise without overwriting edited copy", () => {
    const migration = read(enterprisePackageMigrationPath);

    expect(migration).toContain("Member QR + Loyalty + Coupons + Customer display");
    expect(migration).toContain("Preserve admin-edited package copy");
    expect(migration).toContain("ps.feature_lines = updates.old_feature_lines or ps.feature_lines = '[]'::jsonb");
  });
});
