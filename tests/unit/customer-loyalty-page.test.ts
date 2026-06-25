import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");
const section = (source: string, start: string, end?: string) => {
  const startIndex = source.indexOf(start);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  const endIndex = end ? source.indexOf(end, startIndex + start.length) : -1;
  return source.slice(startIndex, endIndex >= 0 ? endIndex : undefined);
};

describe("customer loyalty admin page", () => {
  it("adds a dashboard customer page wired to loyalty, coupons, and package gates", () => {
    const layout = read("src/app/(dashboard)/layout.tsx");
    const page = read("src/app/(dashboard)/customers/page.tsx");
    const manager = read("src/app/(dashboard)/customers/CustomerLoyaltyManager.tsx");

    expect(layout).toContain('href: "/customers"');
    expect(layout).toContain('label: "ลูกค้า"');

    expect(page).toContain("CustomerLoyaltyManager");
    expect(page).toContain("listCustomersForStore");
    expect(page).toContain("listCouponsForStore");
    expect(page).toContain("getLoyaltySettingsForStore");
    expect(page).toContain("getOrganizationBillingState");
    expect(page).toContain("getPlanFeatures");
    expect(page).toContain('resolved.can("pos.use")');
    expect(page).toContain("canManageCustomers");
    expect(page).toContain("canManageCoupons");
    expect(page).toContain("canManageLoyaltySettings");

    expect(manager).toContain("saveCustomerAction");
    expect(manager).toContain("deleteCustomerAction");
    expect(manager).toContain("saveCouponAction");
    expect(manager).toContain("deleteCouponAction");
    expect(manager).toContain("saveLoyaltySettingsAction");
    expect(manager).toContain("ลูกค้า");
    expect(manager).toContain("คูปอง");
    expect(manager).toContain("สะสมแต้ม");
  });

  it("keeps customer/coupon CRUD server-gated and store-scoped", () => {
    const actions = read("src/app/(dashboard)/customers/actions.ts");
    const customerRepository = read("src/modules/customers/repository.ts");
    const couponRepository = read("src/modules/promotions/repository.ts");
    const loyaltyRepository = read("src/modules/loyalty/repository.ts");

    expect(actions).toContain("saveCustomerAction");
    expect(actions).toContain("deleteCustomerAction");
    expect(actions).toContain("saveCouponAction");
    expect(actions).toContain("deleteCouponAction");
    expect(actions).toContain("saveLoyaltySettingsAction");
    expect(actions).toContain('requirePermission("pos.use")');
    expect(actions).toContain('requirePermission("catalog.manage")');
    expect(actions).toContain('requirePermission("settings.manage_store")');
    expect(actions).toContain('requireFeature("loyaltyPoints")');
    expect(actions).toContain('requireFeature("couponManagement")');
    expect(actions).toContain('revalidatePath("/customers", "page")');

    expect(customerRepository).toContain("listCustomersForStore");
    expect(customerRepository).toContain("saveCustomer");
    expect(customerRepository).toContain("deleteCustomer");
    expect(customerRepository).toContain('.from("customers")');
    expect(customerRepository).toContain("organization_id: input.organizationId");
    expect(customerRepository).toContain("store_id: input.storeId");

    expect(couponRepository).toContain("listCouponsForStore");
    expect(couponRepository).toContain("saveCoupon");
    expect(couponRepository).toContain("deleteCoupon");
    expect(couponRepository).toContain('.from("coupons")');
    expect(couponRepository).toContain("normalizeCouponCode(input.code)");
    expect(couponRepository).toContain("store_id: input.storeId");

    expect(loyaltyRepository).toContain("getLoyaltySettingsForStore");
    expect(loyaltyRepository).toContain("saveLoyaltySettings");
    expect(loyaltyRepository).toContain('.from("loyalty_settings")');
    expect(loyaltyRepository).toContain("points_per_currency");
    expect(loyaltyRepository).toContain("redeem_enabled");
  });

  it("guards review findings for customer and coupon data integrity", () => {
    const actions = read("src/app/(dashboard)/customers/actions.ts");
    const customerRepository = read("src/modules/customers/repository.ts");
    const couponRepository = read("src/modules/promotions/repository.ts");
    const saveCustomerSource = section(
      customerRepository,
      "export async function saveCustomer",
      "export async function deleteCustomer",
    );
    const deleteCustomerSource = section(customerRepository, "export async function deleteCustomer");
    const saveCouponSource = section(
      couponRepository,
      "export async function saveCoupon",
      "export async function deleteCoupon",
    );
    const deleteCouponSource = section(couponRepository, "export async function deleteCoupon");

    expect(saveCustomerSource).not.toContain(".from(\"loyalty_accounts\")");
    expect(saveCustomerSource).not.toContain(".upsert(");
    expect(saveCouponSource).toContain("existingCoupon");
    expect(saveCouponSource).toContain("input.startsAt !== undefined");
    expect(saveCouponSource).toContain("existingCoupon?.starts_at");
    expect(saveCouponSource).toContain("input.maxRedemptions !== undefined");
    expect(saveCouponSource).toContain("existingCoupon?.max_redemptions");
    expect(saveCouponSource).toContain("input.customerIds !== undefined");
    expect(saveCouponSource).toContain("existingCoupon?.customer_ids");
    expect(actions).toContain("if (!formData.has(key)) return undefined");
    expect(deleteCustomerSource).toContain(".select(\"id\")");
    expect(deleteCustomerSource).toContain(".single()");
    expect(deleteCouponSource).toContain(".select(\"id\")");
    expect(deleteCouponSource).toContain(".single()");
  });

  it("returns generated member QR data to the client and updates the QR panel immediately", () => {
    const actions = read("src/app/(dashboard)/customers/actions.ts");
    const manager = read("src/app/(dashboard)/customers/CustomerLoyaltyManager.tsx");
    const qrActionSource = section(actions, "export async function generateMemberPortalQrAction");

    expect(qrActionSource).toContain("QRCode.toDataURL");
    expect(qrActionSource).toContain("memberPortalUrl");
    expect(qrActionSource).toContain("memberPortalQrDataUrl");
    expect(manager).toContain("currentMemberPortalUrl");
    expect(manager).toContain("setMemberPortalQr");
    expect(manager).toContain("result.memberPortalUrl");
    expect(manager).toContain("result.memberPortalQrDataUrl");
  });

  it("keeps long customer loyalty forms collapsed behind explicit open buttons", () => {
    const manager = read("src/app/(dashboard)/customers/CustomerLoyaltyManager.tsx");

    expect(manager).toContain("ToggleSection");
    expect(manager).toContain("openSections");
    expect(manager).toContain("toggleSection");
    expect(manager).toContain('sectionKey="rewards"');
    expect(manager).toContain('sectionKey="customers"');
    expect(manager).toContain('sectionKey="points"');
    expect(manager).toContain('sectionKey="coupons"');
    expect(manager).toContain("เปิดฟอร์ม");
  });
});
