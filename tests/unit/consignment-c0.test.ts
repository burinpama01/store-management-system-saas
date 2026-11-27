import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CONSIGNMENT_PLAN_LOCK_MESSAGE,
  decideConsignmentAccess,
  isConsignmentNavVisible,
} from "@/modules/consignment/access-policy";
import { consignmentErrorMessage } from "@/modules/consignment/repository";
import { getPlanFeatures, type BillingState } from "@/modules/billing/types";
import { validateSupplier } from "@/modules/inventory/validate";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const migration = read("supabase/migrations/20261203120000_consignment_c0.sql").toLowerCase().replace(/\s+/g, " ");

const state = (patch: Partial<BillingState>): BillingState => ({
  plan: "enterprise",
  status: "active",
  currentPeriodEnd: "2099-12-31T23:59:59Z",
  cancelAtPeriodEnd: false,
  trialEnd: null,
  ...patch,
});

describe("consignment plan entitlement", () => {
  it("is enterprise-only", () => {
    for (const plan of ["free", "starter", "standard", "premium"] as const) {
      expect(getPlanFeatures(state({ plan })).consignment).toBe(false);
    }
    expect(getPlanFeatures(state({ plan: "enterprise" })).consignment).toBe(true);
  });

  it("cannot be bought through a business build-your-own config", () => {
    const features = getPlanFeatures(
      state({ plan: "business", business: { seats: 5, stores: 2, features: ["consignment" as never, "stockManagement"] } }),
    );
    expect(features.consignment).toBe(false);
    expect(features.stockManagement).toBe(true);
  });

  it("is lost when a limited enterprise expires or the subscription is canceled", () => {
    expect(getPlanFeatures(state({ enterpriseLimited: true, currentPeriodEnd: "2020-01-01T00:00:00Z" })).consignment).toBe(false);
    expect(getPlanFeatures(state({ status: "canceled" })).consignment).toBe(false);
  });
});

describe("consignment access", () => {
  it("requires the enterprise feature", () => {
    expect(decideConsignmentAccess({ hasConsignment: false, role: "owner", enabled: true })).toEqual({
      allowed: false,
      message: CONSIGNMENT_PLAN_LOCK_MESSAGE,
    });
  });

  it("requires manager or above", () => {
    for (const role of ["cashier", "staff", "kitchen"]) {
      expect(decideConsignmentAccess({ hasConsignment: true, role, enabled: true }).allowed).toBe(false);
    }
    expect(decideConsignmentAccess({ hasConsignment: true, role: "manager", enabled: true }).allowed).toBe(true);
  });

  it("lets only owner/admin toggle, and only operates when the store switch is on", () => {
    const manager = decideConsignmentAccess({ hasConsignment: true, role: "manager", enabled: false });
    expect(manager).toMatchObject({ allowed: true, canToggle: false, canManageSuppliers: true, canOperate: false });
    const owner = decideConsignmentAccess({ hasConsignment: true, role: "owner", enabled: true });
    expect(owner).toMatchObject({ allowed: true, canToggle: true, canOperate: true });
  });

  it("shows the nav item before the switch is on (so the owner can turn it on)", () => {
    expect(isConsignmentNavVisible({ hasConsignment: true, role: "admin" })).toBe(true);
    expect(isConsignmentNavVisible({ hasConsignment: false, role: "owner" })).toBe(false);
    expect(isConsignmentNavVisible({ hasConsignment: true, role: "cashier" })).toBe(false);
  });

  it("never leaks raw SQL errors", () => {
    expect(consignmentErrorMessage("only owner/admin can toggle consignment")).toBe("เปิด/ปิดได้เฉพาะเจ้าของหรือแอดมิน");
    expect(consignmentErrorMessage("consignment requires enterprise plan")).toContain("Enterprise");
    expect(consignmentErrorMessage('relation "x" does not exist')).toBe("บันทึกไม่สำเร็จ ลองใหม่อีกครั้ง");
  });
});

describe("supplier consignment fields", () => {
  const base = {
    id: null,
    name: "ร้านขนมบ้านแม่",
    taxId: null,
    branchCode: null,
    contactName: null,
    phone: null,
    lineId: null,
    address: null,
    note: null,
    leadDays: 1,
    paymentTermsDays: 0,
    isActive: true,
  };

  it("keeps consignment null when the caller does not send it", () => {
    const result = validateSupplier(base);
    expect("value" in result && result.value.consignment).toBe(null);
  });

  it("validates payout method and settle cycle, trims the account", () => {
    const ok = validateSupplier({ ...base, consignment: { payoutMethod: "transfer", settleCycle: "daily", payoutAccount: "  081-234-5678 " } });
    expect("value" in ok && ok.value.consignment).toEqual({ payoutMethod: "transfer", settleCycle: "daily", payoutAccount: "081-234-5678" });
    const blank = validateSupplier({ ...base, consignment: { payoutMethod: "cash", settleCycle: "restock", payoutAccount: " " } });
    expect("value" in blank && blank.value.consignment?.payoutAccount).toBe(null);
    expect(validateSupplier({ ...base, consignment: { payoutMethod: "crypto" as never, settleCycle: "daily", payoutAccount: null } })).toEqual({
      error: "วิธีรับเงินไม่ถูกต้อง",
    });
    expect(validateSupplier({ ...base, consignment: { payoutMethod: "cash", settleCycle: "weekly" as never, payoutAccount: null } })).toEqual({
      error: "รอบเคลียร์เงินไม่ถูกต้อง",
    });
  });

  it("the inventory supplier action never writes consignment fields", () => {
    const source = read("src/app/(dashboard)/costing/inventory-actions.ts");
    expect(source).toContain("{ ...validated.value, consignment: null }");
  });

  it("the repository writes consignment columns only when provided", () => {
    const source = read("src/modules/inventory/repository.ts");
    expect(source).toMatch(/\.\.\.\(input\.consignment\s*\?\s*\{\s*payout_method/);
    // อัปเดตผู้ขายต้องกรองทั้งสาขาและองค์กร (defense-in-depth นอกจาก RLS)
    expect(source).toMatch(/\.eq\("store_id", scope\.storeId\)\s*\.eq\("organization_id", scope\.organizationId\)/);
  });

  it("the consignment action is gated by consignment access and requires the fields", () => {
    const source = read("src/app/(dashboard)/consignment/actions.ts");
    expect(source).toContain("await getConsignmentAccess()");
    expect(source).toContain("if (!input.consignment)");
    expect(source).not.toContain('revalidatePath("/", "layout")');
  });
});

describe("consignment C0 migration", () => {
  it("adds a per-store switch that is off by default", () => {
    expect(migration).toContain("add column if not exists consignment_enabled boolean not null default false");
  });

  it("adds supplier payout + settle cycle with constrained values (restock default)", () => {
    expect(migration).toContain("payout_method text not null default 'cash' check (payout_method in ('cash', 'transfer'))");
    expect(migration).toContain("settle_cycle text not null default 'restock' check (settle_cycle in ('daily', 'restock'))");
    expect(migration).toContain("char_length(payout_account) <= 120");
  });

  it("checks enterprise in the database the same way as the app", () => {
    expect(migration).toContain("s.plan = 'enterprise'");
    expect(migration).toContain("s.status in ('active', 'trialing', 'past_due')");
    expect(migration).toContain("(coalesce(s.enterprise_limited, false) = false and s.promo_trial_code is null) or s.current_period_end > now()");
    expect(migration).toContain("revoke execute on function public.organization_has_consignment(uuid) from anon");
  });

  it("lets only owner/admin toggle, and only enterprise can turn it on", () => {
    expect(migration).toContain("auth_user_role_in_store(v_org, p_store_id, 'admin')");
    expect(migration).toContain("if coalesce(p_enabled, false) and not public.organization_has_consignment(v_org)");
    expect(migration).toContain("revoke all on function public.consignment_set_enabled(uuid, boolean) from public, anon");
  });
});
