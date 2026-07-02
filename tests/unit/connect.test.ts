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
  buildOptionGroups,
  computeMenuSyncHash,
  resolveDeliveryPrice,
  VARIANT_GROUP_NAME,
  type ModifierGroupForDelivery,
  type ProductForDelivery,
  type VariantForDelivery,
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
    delivery_out_of_stock: false,
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

  it("out-of-stock (กดปิดเอง) forces is_available false even when active", () => {
    expect(buildMenuItemPayload({ ...base, delivery_out_of_stock: true }, "อาหาร").is_available).toBe(false);
    expect(buildMenuItemPayload({ ...base, delivery_out_of_stock: false }, "อาหาร").is_available).toBe(true);
  });

  it("hash is stable for same data and changes when price changes", () => {
    const a = computeMenuSyncHash(buildMenuItemPayload(base, "อาหาร"));
    const b = computeMenuSyncHash(buildMenuItemPayload(base, "อาหาร"));
    const c = computeMenuSyncHash(buildMenuItemPayload({ ...base, delivery_price: 99 }, "อาหาร"));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe("option groups sync (#12 variants/modifiers → JDC)", () => {
  const variants: VariantForDelivery[] = [
    { name: "ธรรมดา", price_adjustment: 0, is_active: true, sort_order: 0 },
    { name: "พิเศษ", price_adjustment: 10, is_active: true, sort_order: 1 },
    { name: "จัมโบ้", price_adjustment: 25, is_active: false, sort_order: 2 },
  ];
  const modifierGroups: ModifierGroupForDelivery[] = [
    {
      name: "ระดับความเผ็ด",
      selection_type: "single",
      is_required: true,
      min_selections: 0,
      max_selections: 1,
      sort_order: 1,
      options: [
        { name: "ไม่เผ็ด", price_adjustment: 0, is_active: true, sort_order: 0 },
        { name: "เผ็ดมาก", price_adjustment: 0, is_active: true, sort_order: 1 },
      ],
    },
    {
      name: "ท็อปปิ้ง",
      selection_type: "multiple",
      is_required: false,
      min_selections: 0,
      max_selections: 3,
      sort_order: 0,
      options: [
        { name: "ไข่ดาว", price_adjustment: 10, is_active: true, sort_order: 0 },
        { name: "ไข่เจียว (เลิกขาย)", price_adjustment: 10, is_active: false, sort_order: 1 },
      ],
    },
    {
      name: "กลุ่มว่าง",
      selection_type: "single",
      is_required: false,
      min_selections: 0,
      max_selections: 1,
      sort_order: 2,
      options: [],
    },
  ];

  it("maps 2+ active variants to a required single-select group", () => {
    const groups = buildOptionGroups({ variants, modifier_groups: [] });
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      name: VARIANT_GROUP_NAME,
      min_selection: 1,
      max_selection: 1,
    });
    // ตัด variant ที่ inactive ออก
    expect(groups[0].options.map((o) => o.name)).toEqual(["ธรรมดา", "พิเศษ"]);
    expect(groups[0].options[1].price).toBe(10);
  });

  it("skips variant group when 0-1 variants (default variant)", () => {
    expect(buildOptionGroups({ variants: [variants[0]], modifier_groups: [] })).toEqual([]);
    expect(buildOptionGroups({ variants: [], modifier_groups: [] })).toEqual([]);
  });

  it("maps modifier groups with rules, sorts by sort_order, drops empty/inactive", () => {
    const groups = buildOptionGroups({ variants: [], modifier_groups: modifierGroups });
    expect(groups.map((g) => g.name)).toEqual(["ท็อปปิ้ง", "ระดับความเผ็ด"]); // กลุ่มว่างถูกข้าม
    const toppings = groups[0];
    expect(toppings).toMatchObject({ min_selection: 0, max_selection: 3 });
    expect(toppings.options.map((o) => o.name)).toEqual(["ไข่ดาว"]); // ตัด option inactive
    const spice = groups[1];
    // is_required + min_selections 0 → บังคับเลือกอย่างน้อย 1 ฝั่ง JDC
    expect(spice).toMatchObject({ min_selection: 1, max_selection: 1 });
  });

  it("variant group comes before modifier groups in payload", () => {
    const p: ProductForDelivery = {
      id: "p1",
      name: "ข้าวกะเพรา",
      description: null,
      image_url: null,
      base_price: 50,
      delivery_price: null,
      is_active: true,
      available_for_delivery: true,
      delivery_out_of_stock: false,
      variants,
      modifier_groups: modifierGroups,
    };
    const payload = buildMenuItemPayload(p, "อาหาร");
    expect(payload.option_groups.map((g) => g.name)).toEqual([
      VARIANT_GROUP_NAME,
      "ท็อปปิ้ง",
      "ระดับความเผ็ด",
    ]);
  });

  it("hash changes when an option price or name changes", () => {
    const p: ProductForDelivery = {
      id: "p1",
      name: "ข้าวกะเพรา",
      description: null,
      image_url: null,
      base_price: 50,
      delivery_price: null,
      is_active: true,
      available_for_delivery: true,
      delivery_out_of_stock: false,
      variants,
      modifier_groups: [],
    };
    const a = computeMenuSyncHash(buildMenuItemPayload(p, "อาหาร"));
    const changed = {
      ...p,
      variants: variants.map((v) => (v.name === "พิเศษ" ? { ...v, price_adjustment: 15 } : v)),
    };
    const b = computeMenuSyncHash(buildMenuItemPayload(changed, "อาหาร"));
    expect(a).not.toBe(b);
    // payload ไม่มี option เลย hash ก็ต่างจากมี option
    const c = computeMenuSyncHash(buildMenuItemPayload({ ...p, variants: [] }, "อาหาร"));
    expect(a).not.toBe(c);
  });
});
