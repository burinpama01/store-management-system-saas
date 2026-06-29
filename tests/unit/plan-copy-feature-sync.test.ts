import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import {
  LANDING_FEATURE_LINES,
  FEATURE_LINE_KEYWORDS,
} from "@/modules/billing/landing-feature-lines";
import { getPlanFeatures, type BillingState, type PlanFeatures } from "@/modules/billing/types";

function featuresFor(plan: string): PlanFeatures {
  const state: BillingState = {
    plan: plan as BillingState["plan"],
    status: "active",
    currentPeriodEnd: "2099-12-31T23:59:59Z",
    cancelAtPeriodEnd: false,
    trialEnd: null,
  };
  return getPlanFeatures(state);
}

describe("landing feature copy stays in sync with PLAN_FEATURES", () => {
  for (const [tier, lines] of Object.entries(LANDING_FEATURE_LINES)) {
    it(`${tier} never advertises a feature the plan does not unlock`, () => {
      const text = lines.join(" | ");
      const features = featuresFor(tier);
      for (const { keyword, feature } of FEATURE_LINE_KEYWORDS) {
        if (text.includes(keyword)) {
          expect(
            features[feature],
            `${tier} advertises "${keyword}" → ${feature}, but PLAN_FEATURES does not unlock it`,
          ).toBe(true);
        }
      }
    });
  }

  it("the seed migration applies exactly the canonical copy", () => {
    const sql = readFileSync(
      join(process.cwd(), "supabase/migrations/20260629210000_plan_settings_canonical_copy.sql"),
      "utf8",
    );
    for (const lines of Object.values(LANDING_FEATURE_LINES)) {
      for (const line of lines) {
        expect(sql).toContain(line);
      }
    }
  });
});
