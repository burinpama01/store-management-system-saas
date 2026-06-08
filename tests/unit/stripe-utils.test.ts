import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import {
  mapStripePlan,
  mapStripeStatus,
  toTimestamp,
} from "@/modules/billing/stripe-service";

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");

describe("mapStripePlan", () => {
  it("maps by lookup key when env vars not set", () => {
    expect(mapStripePlan(null, "starter")).toBe("starter");
    expect(mapStripePlan(null, "standard")).toBe("standard");
    expect(mapStripePlan(null, "premium")).toBe("premium");
    expect(mapStripePlan(null, "enterprise")).toBe("enterprise");
  });

  it("throws on unknown price/key", () => {
    expect(() => mapStripePlan("price_unknown", null)).toThrow();
    expect(() => mapStripePlan(null, "unknown_key")).toThrow();
    expect(() => mapStripePlan(null, null)).toThrow();
  });
});

describe("mapStripeStatus", () => {
  const cases: Array<[Parameters<typeof mapStripeStatus>[0], string]> = [
    ["active", "active"],
    ["trialing", "trialing"],
    ["past_due", "past_due"],
    ["incomplete", "incomplete"],
    ["incomplete_expired", "incomplete_expired"],
    ["unpaid", "unpaid"],
    ["canceled", "canceled"],
    ["paused", "paused"],
  ];
  for (const [input, expected] of cases) {
    it(`maps "${input}" → "${expected}"`, () => {
      expect(mapStripeStatus(input)).toBe(expected);
    });
  }
});

describe("toTimestamp", () => {
  it("converts epoch to ISO string", () => {
    expect(toTimestamp(0)).toBe("1970-01-01T00:00:00.000Z");
    expect(toTimestamp(1_000_000_000)).toBe("2001-09-09T01:46:40.000Z");
  });

  it("returns null for null/undefined", () => {
    expect(toTimestamp(null)).toBeNull();
    expect(toTimestamp(undefined)).toBeNull();
  });
});

describe("Stripe webhook idempotency", () => {
  it("does not mark webhook events processed before handler success", () => {
    const route = read("src/app/api/stripe/webhook/route.ts");
    const service = read("src/modules/billing/billing-service.ts");
    const migration = read("supabase/migrations/20260601000003_billing_event_processing_state.sql");

    expect(route).toContain("beginWebhookEventProcessing(event.id, event.type)");
    expect(route).toContain("await handleEvent(event)");
    expect(route.indexOf("await handleEvent(event)")).toBeLessThan(route.indexOf("await markWebhookEventProcessed("));
    expect(route).toContain("await markWebhookEventFailed(");
    expect(route).not.toContain("claimWebhookEvent(event.id");
    expect(service).toContain('WebhookEventProcessingDecision = "process" | "skip" | "retry_later"');
    expect(service).toContain("processingAttemptId");
    expect(service).toContain("begin_billing_event_processing");
    expect(service).toContain("p_processing_attempt_id");
    expect(service).not.toContain(".select(\"status, processing_started_at\")");
    expect(migration).toContain("create or replace function begin_billing_event_processing");
    expect(migration).toContain("processing_attempt_id");
    expect(migration).toContain("p_processing_attempt_id uuid");
    expect(migration).toContain("'processing'");
    expect(migration).toContain("'processed'");
    expect(migration).toContain("'failed'");
    expect(migration).toContain("for update");
    expect(migration).toContain("return 'retry_later'");
    expect(service).not.toContain('existing.data.status === "processed" || existing.data.status === "processing"');
    expect(route).toContain('decision === "retry_later"');
    expect(route).toContain("processingAttemptId");
    expect(route).toContain("Webhook already processing");
    expect(route).toContain("{ status: 500 }");
    expect(migration).toContain("status in ('processing', 'processed', 'failed')");
    expect(migration).toContain("alter column processed_at drop not null");
  });

  it("throws when billing writes fail inside webhook handlers", () => {
    const route = read("src/app/api/stripe/webhook/route.ts");
    const service = read("src/modules/billing/billing-service.ts");

    expect(route).toContain("function assertBillingWrite");
    expect(route).toContain('assertBillingWrite(await upsertSubscription');
    expect(route).toContain('assertBillingWrite(await upsertStripeCustomer');
    expect(route).toContain('assertBillingWrite(await setSubscriptionStatus');
    expect(route).toContain("markWebhookEventProcessed(");
    expect(route).toContain("event.id,\n        processingAttemptId");
    expect(route).toContain("markWebhookEventFailed(");
    expect(service).toContain('.eq("processing_attempt_id", processingAttemptId)');
    expect(service).toContain('.eq("status", "processing")');
  });
});
