import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isNewKitchenQrOrderEvent } from "@/modules/qr-ordering/incoming-order";

describe("isNewKitchenQrOrderEvent", () => {
  it("accepts a fresh QR order insert", () => {
    expect(isNewKitchenQrOrderEvent({ eventType: "INSERT", new: { qr_order_source: true, table_bill_key: null } })).toBe(true);
    expect(isNewKitchenQrOrderEvent({ eventType: "INSERT", new: { qr_order_source: true } })).toBe(true);
  });

  it("ignores the consolidated table bill order (already cooked items)", () => {
    expect(
      isNewKitchenQrOrderEvent({ eventType: "INSERT", new: { qr_order_source: true, table_bill_key: "tbl-abc12345" } }),
    ).toBe(false);
  });

  it("ignores non-QR inserts and non-insert events", () => {
    expect(isNewKitchenQrOrderEvent({ eventType: "INSERT", new: { qr_order_source: false } })).toBe(false);
    expect(isNewKitchenQrOrderEvent({ eventType: "UPDATE", new: { qr_order_source: true } })).toBe(false);
    expect(isNewKitchenQrOrderEvent({ eventType: "INSERT", new: null })).toBe(false);
  });

  it("is what the global QR notifier uses to gate alerts and kitchen tickets", () => {
    const notifier = readFileSync(join(process.cwd(), "src/app/(dashboard)/QrOrderGlobalNotifier.tsx"), "utf8");
    expect(notifier).toContain("if (!isNewKitchenQrOrderEvent(payload) || !payload.new) return;");
    expect(notifier).toContain('"table_bill_key"');
  });
});
