import { describe, it, expect } from "vitest";
import {
  signConnectPayload,
  verifyConnectSignature,
  isFreshTimestamp,
} from "@/modules/connect/hmac";
import {
  fulfillmentToJdcStatus,
  jdcStatusToFulfillment,
  canPosCancel,
  canPosTransition,
} from "@/modules/connect/types";
import {
  buildMenuItemPayload,
  computeMenuSyncHash,
  resolveDeliveryPrice,
  type ProductForDelivery,
} from "@/modules/connect/menu-payload";

describe("connect hmac", () => {
  it("verifies a signature it produced", () => {
    const body = JSON.stringify({ a: 1, b: "x" });
    const sig = signConnectPayload(body, "secret");
    expect(verifyConnectSignature(body, "secret", sig)).toBe(true);
  });

  it("rejects wrong secret / tampered body / missing header", () => {
    const body = JSON.stringify({ a: 1 });
    const sig = signConnectPayload(body, "secret");
    expect(verifyConnectSignature(body, "other", sig)).toBe(false);
    expect(verifyConnectSignature(body + "x", "secret", sig)).toBe(false);
    expect(verifyConnectSignature(body, "secret", null)).toBe(false);
  });

  it("accepts header with or without sha256= prefix", () => {
    const body = "{}";
    const sig = signConnectPayload(body, "s");
    expect(verifyConnectSignature(body, "s", sig.replace("sha256=", ""))).toBe(true);
  });

  it("timestamp freshness window", () => {
    const now = 1_000_000;
    expect(isFreshTimestamp(now, now)).toBe(true);
    expect(isFreshTimestamp(now - 299, now)).toBe(true);
    expect(isFreshTimestamp(now - 301, now)).toBe(false);
    expect(isFreshTimestamp(undefined, now)).toBe(true); // optional
  });
});

describe("connect status mapping", () => {
  it("fulfillment → jdc (push) and null where JDC owns the status", () => {
    expect(fulfillmentToJdcStatus("accepted")).toBe("preparing");
    expect(fulfillmentToJdcStatus("ready")).toBe("ready_for_pickup");
    expect(fulfillmentToJdcStatus("cancelled")).toBe("cancelled");
    expect(fulfillmentToJdcStatus("received")).toBeNull();
    expect(fulfillmentToJdcStatus("completed")).toBeNull();
  });

  it("jdc → fulfillment", () => {
    expect(jdcStatusToFulfillment("pending_merchant")).toBe("received");
    expect(jdcStatusToFulfillment("preparing")).toBe("preparing");
    expect(jdcStatusToFulfillment("ready_for_pickup")).toBe("ready");
    expect(jdcStatusToFulfillment("in_transit")).toBe("completed");
    expect(jdcStatusToFulfillment("cancelled")).toBe("cancelled");
    expect(jdcStatusToFulfillment("weird")).toBe("received");
  });
});

describe("cancellation rule (ร้านกดรับแล้วยกเลิกไม่ได้)", () => {
  it("POS can cancel only while received", () => {
    expect(canPosCancel("received")).toBe(true);
    expect(canPosCancel("accepted")).toBe(false);
    expect(canPosCancel("preparing")).toBe(false);
  });

  it("transition gate enforces cancel + forward-only", () => {
    expect(canPosTransition("received", "cancelled").ok).toBe(true);
    expect(canPosTransition("accepted", "cancelled").ok).toBe(false);
    expect(canPosTransition("received", "accepted").ok).toBe(true);
    expect(canPosTransition("preparing", "accepted").ok).toBe(false); // ถอยหลัง
    expect(canPosTransition("completed", "ready").ok).toBe(false); // ปิดแล้ว
    expect(canPosTransition("received", "completed").ok).toBe(false); // POS set ไม่ได้
  });
});

describe("menu payload & sync hash", () => {
  const base: ProductForDelivery = {
    id: "p1",
    name: "ข้าวกะเพรา",
    description: "เผ็ด",
    image_url: null,
    base_price: 50,
    delivery_price: null,
    is_active: true,
    available_for_delivery: true,
  };

  it("uses delivery_price when set, else base_price", () => {
    expect(resolveDeliveryPrice({ base_price: 50, delivery_price: null })).toBe(50);
    expect(resolveDeliveryPrice({ base_price: 50, delivery_price: 65 })).toBe(65);
    expect(buildMenuItemPayload({ ...base, delivery_price: 65 }, "อาหาร").price).toBe(65);
  });

  it("maps is_available from is_active + external_ref from id", () => {
    const p = buildMenuItemPayload({ ...base, is_active: false }, "อาหาร");
    expect(p.is_available).toBe(false);
    expect(p.external_ref).toBe("p1");
    expect(p.category).toBe("อาหาร");
  });

  it("hash is stable for same data and changes when price changes", () => {
    const a = computeMenuSyncHash(buildMenuItemPayload(base, "อาหาร"));
    const b = computeMenuSyncHash(buildMenuItemPayload(base, "อาหาร"));
    const c = computeMenuSyncHash(buildMenuItemPayload({ ...base, delivery_price: 99 }, "อาหาร"));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});
