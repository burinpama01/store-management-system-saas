import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildFreeTrialOffer,
  isFreeTrialCampaignOpen,
  FREE_TRIAL_DAYS,
  FREE_TRIAL_PROMO_CODE,
  type FreeTrialCampaign,
} from "@/modules/billing/free-trial";
import { getPlanFeatures } from "@/modules/billing/types";
import { hasBillingAccess } from "@/modules/billing/pricing";

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");

function migrationSource(): string {
  const migration = readdirSync(join(root, "supabase/migrations"))
    .filter((name) => name.endsWith(".sql"))
    .map((name) => ({ name, source: read(`supabase/migrations/${name}`) }))
    .find((entry) => entry.source.includes("create or replace function claim_free_trial"));
  return migration?.source ?? "";
}

const OPEN: FreeTrialCampaign = { enabled: true, startsAt: null, endsAt: null };

describe("free trial campaign window", () => {
  const now = new Date("2026-08-19T00:00:00.000Z");

  it("is open when enabled and now sits inside the configured window", () => {
    expect(isFreeTrialCampaignOpen(OPEN, now)).toBe(true);
    expect(
      isFreeTrialCampaignOpen(
        { enabled: true, startsAt: "2026-08-01T00:00:00.000Z", endsAt: "2026-09-30T00:00:00.000Z" },
        now,
      ),
    ).toBe(true);
  });

  it("is closed when disabled, not started yet, or already ended", () => {
    expect(isFreeTrialCampaignOpen({ ...OPEN, enabled: false }, now)).toBe(false);
    expect(
      isFreeTrialCampaignOpen({ enabled: true, startsAt: "2026-09-01T00:00:00.000Z", endsAt: null }, now),
    ).toBe(false);
    expect(
      isFreeTrialCampaignOpen({ enabled: true, startsAt: null, endsAt: "2026-08-18T00:00:00.000Z" }, now),
    ).toBe(false);
  });
});

describe("free trial offer", () => {
  it("offers a 30-day Enterprise trial once while the campaign is open", () => {
    const offer = buildFreeTrialOffer({ campaign: OPEN, alreadyRedeemed: false });

    expect(offer).toMatchObject({
      available: true,
      campaignOpen: true,
      days: FREE_TRIAL_DAYS,
      plan: "enterprise",
      promotionCode: FREE_TRIAL_PROMO_CODE,
      unavailableReason: null,
    });
  });

  it("blocks a closed campaign, a used redemption, or an active subscription", () => {
    expect(
      buildFreeTrialOffer({ campaign: { ...OPEN, enabled: false }, alreadyRedeemed: false }),
    ).toMatchObject({ available: false, unavailableReason: "campaign_closed" });

    expect(buildFreeTrialOffer({ campaign: OPEN, alreadyRedeemed: true })).toMatchObject({
      available: false,
      unavailableReason: "already_redeemed",
    });

    expect(
      buildFreeTrialOffer({ campaign: OPEN, alreadyRedeemed: false, activeSubscription: true }),
    ).toMatchObject({ available: false, unavailableReason: "active_subscription" });
  });
});

describe("promo Enterprise trial expires; every other Enterprise row does not", () => {
  const now = new Date("2026-08-19T00:00:00.000Z");

  it("keeps every feature while the 30-day promo window is still open", () => {
    const state = {
      plan: "enterprise" as const,
      status: "trialing" as const,
      currentPeriodEnd: "2026-09-10T00:00:00.000Z",
      cancelAtPeriodEnd: false,
      trialEnd: "2026-09-10T00:00:00.000Z",
      promoTrial: true,
    };
    expect(getPlanFeatures(state, now).qrOrdering).toBe(true);
    expect(getPlanFeatures(state, now).apiIntegration).toBe(true);
    expect(hasBillingAccess(state, now)).toBe(true);
  });

  it("degrades to free features and blocks access once the promo trial lapses", () => {
    const state = {
      plan: "enterprise" as const,
      status: "trialing" as const,
      currentPeriodEnd: "2026-08-01T00:00:00.000Z",
      cancelAtPeriodEnd: false,
      trialEnd: "2026-08-01T00:00:00.000Z",
      promoTrial: true,
    };
    expect(getPlanFeatures(state, now).qrOrdering).toBe(false);
    expect(getPlanFeatures(state, now).multiBranchReporting).toBe(false);
    expect(hasBillingAccess(state, now)).toBe(false);
  });

  it("leaves an Enterprise contract (status=active) untouched", () => {
    const state = {
      plan: "enterprise" as const,
      status: "active" as const,
      currentPeriodEnd: "2099-12-31T23:59:59Z",
      cancelAtPeriodEnd: false,
      trialEnd: null,
    };
    expect(getPlanFeatures(state, now).apiIntegration).toBe(true);
    expect(hasBillingAccess(state, now)).toBe(true);
  });

  // Regression 2026-08-20: prod มีแถวเก่า plan=enterprise + status=trialing +
  // period_end หมดไปแล้ว (ตั้งไว้ตอนที่ enterprise ผ่านด่านบิลตลอด) การใช้ status
  // ตัดสินว่าเป็นสิทธิ์ทดลอง ทำให้ทั้งองค์กรถูกตัดสิทธิ์ทันทีตอน deploy
  it("does NOT expire a legacy enterprise/trialing row that has no promo marker", () => {
    const legacy = {
      plan: "enterprise" as const,
      status: "trialing" as const,
      currentPeriodEnd: "2026-07-21T05:32:21.088866+00:00",
      cancelAtPeriodEnd: false,
      trialEnd: "2026-07-21T05:32:21.088866+00:00",
    };
    expect(hasBillingAccess(legacy, now)).toBe(true);
    expect(getPlanFeatures(legacy, now).apiIntegration).toBe(true);
    expect(getPlanFeatures(legacy, now).multiBranchReporting).toBe(true);
  });
});

describe("billing gate never traps a user in a redirect loop", () => {
  it("shows a locked notice instead of bouncing staff back to /dashboard", () => {
    const page = read("src/app/(dashboard)/settings/billing/page.tsx");
    const guards = read("src/modules/auth/guards.ts");

    // guards เด้งคนที่แพ็กเกจหมดอายุมาที่ /settings/billing
    expect(guards).toContain('redirect("/settings/billing?expired=1")');
    // หน้านี้จึงห้ามเด้งกลับ /dashboard แบบไม่มีเงื่อนไข ไม่งั้นวนไม่จบ = จอขาว
    expect(page).toContain("BillingLockedNotice");
    expect(page).toContain('if (hasBillingAccess(state)) redirect("/dashboard")');
    expect(page).toContain("ไม่มีสิทธิ์จัดการการชำระเงิน");
  });
});

describe("free trial wiring", () => {
  it("keeps the redemption one-time per user and per tenant, across promo codes", () => {
    const migration = migrationSource();

    expect(migration).toContain("billing_premium_trial_redemptions_user_once unique (user_id)");
    expect(migration).toContain("billing_premium_trial_redemptions_org_once unique (organization_id)");
    expect(migration).toContain("check (plan in ('premium', 'enterprise'))");
    // สิทธิ์นับรวมทุกโค้ดโปร: ไม่กรอง promotion_code ตอนเช็ค
    expect(read("src/modules/billing/pricing-repository.ts")).not.toContain('.eq("promotion_code"');
  });

  it("claims the promo through an atomic RPC guarded by campaign window and active subscription", () => {
    const migration = migrationSource();
    const service = read("src/modules/billing/subscription-service.ts");

    expect(migration).toContain("create or replace function claim_free_trial");
    expect(migration).toContain("free_trial_enabled");
    expect(migration).toContain("return query select false, 'campaign_closed'");
    expect(migration).toContain("return query select false, 'active_subscription'");
    expect(migration).toContain("for update");
    expect(migration).toContain("insert into billing_premium_trial_redemptions");
    expect(migration).toContain("insert into audit_logs");
    expect(service).toContain('supabase.rpc("claim_free_trial"');
    expect(service).not.toContain('.from("billing_premium_trial_redemptions").insert');
  });

  it("marks the promo subscription and clears the marker on purchase or override", () => {
    const marker = readdirSync(join(root, "supabase/migrations"))
      .filter((n) => n.endsWith(".sql"))
      .map((n) => read(`supabase/migrations/${n}`))
      .find((src) => src.includes("add column if not exists promo_trial_code")) ?? "";

    expect(marker).toContain("promo_trial_code");
    expect(marker).toContain("'enterprise_free_30d_once',");
    // อ่านค่ามาใช้จริง และล้างเมื่อจ่ายเงิน/super-admin ตั้งแพ็กเกจ
    expect(read("src/modules/billing/billing-service.ts")).toContain("promoTrial: Boolean(");
    expect(read("src/modules/billing/subscription-service.ts")).toContain("promo_trial_code: null");
    expect(read("src/modules/system/repository.ts")).toContain("promo_trial_code: null");
    // ห้ามกลับไปตัดสินด้วย status เปล่า ๆ
    expect(read("src/modules/billing/types.ts")).toContain('return state.promoTrial === true;');
  });

  it("exposes a no-slip claim action and a standalone promo panel in Billing", () => {
    const service = read("src/modules/billing/subscription-service.ts");
    const actions = read("src/app/(dashboard)/settings/billing/actions.ts");
    const ui = read("src/app/(dashboard)/settings/billing/BillingManager.tsx");

    expect(service).toContain("claimFreeTrial");
    expect(actions).toContain("claimFreeTrialAction");
    expect(ui).toContain("รับสิทธิ์ทดลองฟรี 30 วัน");
    expect(ui).toContain("handleFreeTrial");
    expect(ui).toContain("ไม่ต้องอัปโหลดสลิป");
    // ลูกค้าที่กำลังทดลอง Enterprise ต้องยังเลือกซื้อแพ็กเกจต่อได้
    expect(ui).toContain("isEnterpriseContract");
  });

  it("grants the promo at signup without failing registration when the campaign is closed", () => {
    const source = read("src/app/(auth)/register/actions.ts");

    expect(source).toContain("FREE_TRIAL_DAYS");
    expect(source).toContain('svc.rpc("claim_free_trial"');
    expect(source).toContain("trialClaimed");
    // แคมเปญปิดอยู่ต้องไม่ทำให้สมัครไม่ผ่าน (ห้าม rollback org/store เพราะ trial)
    expect(source).not.toContain("เปิดใช้งาน Premium ฟรี 30 วันไม่สำเร็จ");
  });

  it("lets super admins open/close the campaign window from /system/pricing", () => {
    const actions = read("src/app/system/pricing/actions.ts");
    const ui = read("src/app/system/pricing/PricingManager.tsx");

    expect(actions).toContain("updateFreeTrialCampaignAction");
    expect(actions).toContain("วันสิ้นสุดต้องหลังวันเริ่ม");
    expect(ui).toContain("FreeTrialCampaignForm");
    expect(read("src/modules/billing/platform-settings.ts")).toContain("updateFreeTrialCampaign");
  });
});
