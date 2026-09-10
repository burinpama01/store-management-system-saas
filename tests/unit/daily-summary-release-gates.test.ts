import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { requireExactCount } from "@/modules/reports/daily-summary-repository";
import { toSafeExactCount } from "@/modules/attendance/shift-status-repository";

const root = process.cwd();
const read = (relativePath: string) => readFileSync(resolve(root, relativePath), "utf8");

describe("daily summary release gates", () => {
  it("fail-closes exact counts when the database returns null or an error", () => {
    expect(toSafeExactCount(null, null)).toBeNull();
    expect(toSafeExactCount(0, new Error("count unavailable"))).toBeNull();
    expect(toSafeExactCount(3, null)).toBe(3);
    expect(() => requireExactCount({ count: 0, error: new Error("voided query failed") })).toThrow("voided query failed");
  });

  it("keeps high-volume cron queries paginated and fail-closed", () => {
    const activation = read("src/app/api/notifications/cron/activation/route.ts");
    const subscriptions = read("src/modules/billing/subscription-watch-runner.ts");
    expect(activation).toContain("loadAllRows");
    expect(activation).toContain(".range(from, to)");
    expect(subscriptions).toContain("loadAllRows");
    expect(subscriptions).toContain(".range(from, to)");
  });

  it("uses an atomic claim and records both sent and failed email delivery", () => {
    const runner = read("src/modules/reports/daily-summary-runner.ts");
    expect(runner).toContain('"claim_daily_summary_email"');
    expect(runner).toContain('delivery_status: input.delivered ? "sent" : "failed"');
    expect(runner).toContain('.eq("delivery_status", "claimed")');
    expect(runner).toContain("deliveryFinalized");
    expect(runner).toContain("claimAcquired");
    expect(runner).toContain('providerOutcome = "sent"');
    expect(runner).toContain("dailySummaryDeliveryOutcomeUnknown");
  });

  it("timestamps integration refunds so the daily void/refund count includes them", () => {
    const statusSync = read("src/modules/connect/status-sync.ts");
    const migration = read("supabase/migrations/20260909000000_daily_summary.sql");
    expect(statusSync).toContain('nextStatus === "refunded" ? { voided_at: now } : {}');
    expect(migration).toContain("where status = 'refunded'");
    expect(migration).toContain("and voided_at is null");
  });
});
