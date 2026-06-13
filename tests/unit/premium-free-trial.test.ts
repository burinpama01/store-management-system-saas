import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildPremiumFreeTrialOffer,
  PREMIUM_FREE_TRIAL_DAYS,
  PREMIUM_FREE_TRIAL_PROMO_CODE,
} from "@/modules/billing/premium-trial";

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");

function migrationSource(): string {
  const migration = readdirSync(join(root, "supabase/migrations"))
    .filter((name) => name.endsWith(".sql"))
    .map((name) => ({ name, source: read(`supabase/migrations/${name}`) }))
    .find((entry) => entry.source.includes("billing_premium_trial_redemptions"));
  return migration?.source ?? "";
}

describe("premium free trial offer", () => {
  it("offers Premium 30-day checkout at 0 baht only once", () => {
    const offer = buildPremiumFreeTrialOffer({
      plan: "premium",
      duration: "30d",
      basePrice: 2290,
      alreadyRedeemed: false,
    });

    expect(offer).toEqual({
      selectionMatches: true,
      available: true,
      basePrice: 2290,
      finalAmount: 0,
      credit: 0,
      days: PREMIUM_FREE_TRIAL_DAYS,
      promotionCode: PREMIUM_FREE_TRIAL_PROMO_CODE,
      promotionLabel: "Premium ฟรี 30 วัน (ใช้ได้ 1 ครั้ง)",
      unavailableReason: null,
    });
  });

  it("does not offer the free trial for other plans, yearly Premium, or redeemed IDs", () => {
    expect(buildPremiumFreeTrialOffer({
      plan: "standard",
      duration: "30d",
      basePrice: 1290,
      alreadyRedeemed: false,
    }).available).toBe(false);

    expect(buildPremiumFreeTrialOffer({
      plan: "premium",
      duration: "1y",
      basePrice: 22900,
      alreadyRedeemed: false,
    }).available).toBe(false);

    expect(buildPremiumFreeTrialOffer({
      plan: "premium",
      duration: "30d",
      basePrice: 2290,
      alreadyRedeemed: true,
    })).toMatchObject({
      selectionMatches: true,
      available: false,
      unavailableReason: "already_redeemed",
      finalAmount: 2290,
    });
  });
});

describe("premium free trial wiring", () => {
  it("persists one-time redemption per user and tenant", () => {
    const migration = migrationSource();

    expect(migration).toContain("create table if not exists billing_premium_trial_redemptions");
    expect(migration).toContain("unique (user_id, promotion_code)");
    expect(migration).toContain("unique (organization_id, promotion_code)");
    expect(migration).toContain("alter table billing_premium_trial_redemptions enable row level security");
  });

  it("claims the promo through an atomic database RPC with active-subscription guard", () => {
    const migration = migrationSource();
    const service = read("src/modules/billing/subscription-service.ts");

    expect(migration).toContain("create or replace function claim_premium_free_trial");
    expect(migration).toContain("for update");
    expect(migration).toContain("if v_current_end is not null and v_current_end > v_now then");
    expect(migration).toContain("return query select false, 'active_subscription'");
    expect(migration).toContain("insert into billing_premium_trial_redemptions");
    expect(migration).toContain("insert into subscriptions");
    expect(migration).toContain("insert into audit_logs");
    expect(service).toContain('supabase.rpc("claim_premium_free_trial"');
    expect(service).not.toContain('.from("billing_premium_trial_redemptions").insert');
  });

  it("uses a no-slip server action and service guard for 0-baht Premium activation", () => {
    const service = read("src/modules/billing/subscription-service.ts");
    const actions = read("src/app/(dashboard)/settings/billing/actions.ts");
    const ui = read("src/app/(dashboard)/settings/billing/BillingManager.tsx");

    expect(service).toContain("claimPremiumFreeTrial");
    expect(service).toContain('supabase.rpc("claim_premium_free_trial"');
    expect(actions).toContain("claimPremiumTrialAction");
    expect(actions).toContain("getPremiumFreeTrialEligibility");
    expect(ui).toContain("ใช้ Premium ฟรี 30 วัน");
    expect(ui).toContain("handlePremiumTrial");
    expect(ui).toContain("ไม่ต้องอัปโหลดสลิป");
  });

  it("signup grants the 30-day Premium promo once and consumes the redemption", () => {
    const source = read("src/app/(auth)/register/actions.ts");

    expect(source).toContain("PREMIUM_FREE_TRIAL_DAYS");
    expect(source).toContain("Premium ฟรี 30 วัน");
    expect(source).toContain('svc.rpc("claim_premium_free_trial"');
    expect(source).not.toContain("14 * 86_400_000");
  });
});
