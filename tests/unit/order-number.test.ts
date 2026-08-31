import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { generateOrderNumber } from "@/modules/pos/order-number";

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");

afterEach(() => {
  vi.restoreAllMocks();
});

describe("generateOrderNumber", () => {
  it("uses the store timezone for the date and time prefix", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);

    const orderNumber = generateOrderNumber({
      now: new Date("2026-05-18T18:30:05Z"),
      timeZone: "Asia/Bangkok",
    });

    expect(orderNumber).toMatch(/^260519-013005-/);
  });

  it("falls back to Asia/Bangkok when timezone is invalid", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);

    const orderNumber = generateOrderNumber({
      now: new Date("2026-05-18T18:30:05Z"),
      timeZone: "Not/AZone",
    });

    expect(orderNumber).toMatch(/^260519-013005-/);
  });

  it("wires the store timezone into POS and QR order creation paths", () => {
    const posAction = read("src/app/pos/actions.ts");
    const posRepository = read("src/modules/pos/order-repository.ts");
    const qrAction = read("src/app/qr/[storeSlug]/[tableId]/actions.ts");

    expect(posAction).toContain("storeTimezone: ctx.storeTimezone");
    expect(posRepository).toContain("generateOrderNumber({ timeZone: input.storeTimezone })");
    expect(qrAction).toContain(".select(\"id, organization_id, qr_ordering_enabled, is_active, timezone, qr_ordering_mode, table_open_policy, unified_pos_enabled\")");
    // U4: flag-routed v2/v1 — QR action ต้องเดิน v2 เมื่อ flag เปิดและคง v1 ไว้ตอนปิด
    expect(qrAction).toContain("create_qr_order_with_items_v2");
    expect(qrAction).toContain("unified_pos_enabled");
    expect(qrAction).toContain("generateOrderNumber({ timeZone: store.timezone })");
  });
});
