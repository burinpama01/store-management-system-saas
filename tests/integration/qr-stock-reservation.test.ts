import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getLocalSupabase, type LocalSupabase } from "./helpers/local-supabase";

// จองสต๊อกออเดอร์ QR จนครัวรับ (migration 20260918030000) — ร้านที่ไม่เปิด unified_pos_enabled
// ต้องตั้ง env ก่อนรัน (ขาด = skip): LOCAL_SUPABASE_URL / LOCAL_SUPABASE_PUBLISHABLE_KEY / LOCAL_SUPABASE_SERVICE_KEY
// และ migration ต้องอยู่ใน local DB แล้ว (supabase migration up --local)

const envReady =
  !!process.env.LOCAL_SUPABASE_URL &&
  !!process.env.LOCAL_SUPABASE_PUBLISHABLE_KEY &&
  !!process.env.LOCAL_SUPABASE_SERVICE_KEY;

const ORG_A = "aaaaaaaa-0000-0000-0000-000000000001";
const STORE_A = "cccccccc-0000-0000-0000-000000000001";
const TABLE_1 = "eeeeeeee-0000-0000-0000-000000000001";
const PRODUCT_1 = "22222222-0000-0000-0000-000000000001";
const VARIANT_1 = "33333333-0000-0000-0000-000000000001";
const PRODUCT_2 = "22222222-0000-0000-0000-000000000002";
const VARIANT_2 = "33333333-0000-0000-0000-000000000003";
const OPTION_1 = "55555555-0000-0000-0000-000000000001";
const OPTION_2 = "55555555-0000-0000-0000-000000000005";
const OWNER_ID = "00000000-0000-0000-0000-000000000001";

describe.skipIf(!envReady)("QR stock reservation (local supabase)", () => {
  let local: LocalSupabase;
  let service: SupabaseClient;
  let owner: SupabaseClient;
  let poolId: string | null = null;
  let stationId: string | null = null;
  const orderIds: string[] = [];
  let seq = 0;

  beforeAll(async () => {
    local = getLocalSupabase();
    service = local.client;
    owner = createClient(local.url, local.publishableKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const { error } = await owner.auth.signInWithPassword({ email: "owner@demo.local", password: "demo1234" });
    expect(error).toBeNull();

    await service.from("stores").update({ unified_pos_enabled: false, qr_ordering_enabled: true }).eq("id", STORE_A);
    await service.from("tables").update({ qr_enabled: true, is_active: true }).eq("id", TABLE_1);
    const { data: station, error: stationErr } = await service
      .from("kitchen_stations")
      .insert({ organization_id: ORG_A, store_id: STORE_A, name: `Reservation Station ${Date.now()}` })
      .select("id")
      .single();
    expect(stationErr, stationErr?.message).toBeNull();
    stationId = station!.id;
    await service
      .from("products")
      .update({ available_for_qr: true, is_active: true, kitchen_station_id: stationId })
      .in("id", [PRODUCT_1, PRODUCT_2]);
    await service
      .from("product_variants")
      .update({ track_stock: true, stock_quantity: 10, reserved_quantity: 0 })
      .eq("id", VARIANT_1);

    // Pool: ลาเต้ S ใช้ 2 หน่วย/แก้ว จาก Pool 20 หน่วย
    const { data: pool, error: poolErr } = await service
      .from("stock_pools")
      .insert({ organization_id: ORG_A, store_id: STORE_A, name: `นม reservation ${Date.now()}`, unit_label: "ช็อต", quantity: 20 })
      .select("id")
      .single();
    expect(poolErr, poolErr?.message).toBeNull();
    poolId = pool!.id;
    const { error: linkErr } = await service
      .from("variant_stock_links")
      .insert({ variant_id: VARIANT_2, stock_pool_id: poolId, consumption_quantity: 2 });
    expect(linkErr, linkErr?.message).toBeNull();
  });

  afterAll(async () => {
    if (!service) return;
    if (orderIds.length > 0) {
      await service.from("stock_movements").delete().in("reference_id", orderIds);
      await service.from("orders").delete().in("id", orderIds);
    }
    await service.from("variant_stock_links").delete().eq("variant_id", VARIANT_2);
    if (poolId) {
      await service.from("stock_movements").delete().eq("stock_pool_id", poolId);
      await service.from("stock_pools").delete().eq("id", poolId);
    }
    await service
      .from("product_variants")
      .update({ track_stock: false, stock_quantity: null, reserved_quantity: 0 })
      .eq("id", VARIANT_1);
    await service
      .from("products")
      .update({ available_for_qr: false, kitchen_station_id: null })
      .in("id", [PRODUCT_1, PRODUCT_2]);
    if (stationId) await service.from("kitchen_stations").delete().eq("id", stationId);
    await service.from("tables").update({ qr_enabled: false }).eq("id", TABLE_1);
    await owner?.auth.signOut();
  });

  function coffee(quantity: number) {
    return {
      product_id: PRODUCT_1,
      product_name: "กาแฟดำ",
      variant_id: VARIANT_1,
      variant_name: "เล็ก (S)",
      modifiers: [{ option: { id: OPTION_1, name: "ไม่หวาน", priceAdjustment: 0 } }],
      quantity,
      unit_price: 45,
      total_price: 45 * quantity,
      note: null,
    };
  }

  function latte(quantity: number) {
    return {
      product_id: PRODUCT_2,
      product_name: "ลาเต้",
      variant_id: VARIANT_2,
      variant_name: "เล็ก (S)",
      modifiers: [{ option: { id: OPTION_2, name: "ไม่หวาน", priceAdjustment: 0 } }],
      quantity,
      unit_price: 55,
      total_price: 55 * quantity,
      note: null,
    };
  }

  async function order(items: ReturnType<typeof coffee>[]) {
    seq += 1;
    const { data, error } = await service.rpc("create_qr_order_with_items", {
      p_organization_id: ORG_A,
      p_store_id: STORE_A,
      p_table_id: TABLE_1,
      p_order_number: `RSV-${Date.now()}-${seq}`,
      p_subtotal: items.reduce((sum, item) => sum + item.total_price, 0),
      p_items: items,
    });
    if (data) orderIds.push(data as string);
    return { id: data as string | null, error };
  }

  async function variant() {
    const { data } = await service
      .from("product_variants")
      .select("stock_quantity, reserved_quantity")
      .eq("id", VARIANT_1)
      .single();
    return data as { stock_quantity: number; reserved_quantity: number };
  }

  async function pool() {
    const { data } = await service.from("stock_pools").select("quantity, reserved_units").eq("id", poolId!).single();
    return data as { quantity: number; reserved_units: number };
  }

  async function orderRow(id: string) {
    const { data } = await service.from("orders").select("status, prep_status, stock_state").eq("id", id).single();
    return data as { status: string; prep_status: string; stock_state: string | null };
  }

  async function items(id: string) {
    const { data } = await service.from("order_items").select("id").eq("order_id", id);
    return (data ?? []) as { id: string }[];
  }

  it("ordering reserves stock without touching real stock, and blocks overselling the reserved units", async () => {
    const first = await order([coffee(3)]);
    expect(first.error, first.error?.message).toBeNull();
    expect(await variant()).toEqual({ stock_quantity: 10, reserved_quantity: 3 });
    expect((await orderRow(first.id!)).stock_state).toBe("reserved");

    const oversell = await order([coffee(8)]);
    expect(oversell.error?.message).toContain("สินค้าเหลือไม่พอ");
    expect(await variant()).toEqual({ stock_quantity: 10, reserved_quantity: 3 });

    // ครัวรับ (prep new → preparing) = ตัดจริง + คืนยอดจอง
    const { error } = await owner.from("orders").update({ prep_status: "preparing" }).eq("id", first.id!);
    expect(error, error?.message).toBeNull();
    expect(await variant()).toEqual({ stock_quantity: 7, reserved_quantity: 0 });
    expect((await orderRow(first.id!)).stock_state).toBe("committed");
  });

  it("customer cancel before the kitchen accepts only releases the reservation", async () => {
    const before = await variant();
    const created = await order([coffee(2)]);
    expect(created.error, created.error?.message).toBeNull();
    expect(await variant()).toEqual({ ...before, reserved_quantity: before.reserved_quantity + 2 });

    const { error } = await service.rpc("cancel_qr_order_by_customer", {
      p_store_id: STORE_A,
      p_table_id: TABLE_1,
      p_order_id: created.id,
    });
    expect(error, error?.message).toBeNull();
    expect(await variant()).toEqual(before);
    expect(await orderRow(created.id!)).toMatchObject({ status: "cancelled", stock_state: "released" });
  });

  it("kitchen rejecting a reserved line releases just that line; rejecting the last line cancels the order", async () => {
    const before = await variant();
    const created = await order([coffee(1), coffee(2)]);
    expect(created.error, created.error?.message).toBeNull();
    const [lineA, lineB] = await items(created.id!);

    const r1 = await owner.rpc("void_qr_order_item", { p_store_id: STORE_A, p_order_id: created.id, p_item_id: lineA.id, p_reason: "ของหมด" });
    expect(r1.error, r1.error?.message).toBeNull();
    const mid = await variant();
    expect(mid.stock_quantity).toBe(before.stock_quantity);
    expect(mid.reserved_quantity).toBe(before.reserved_quantity + 3 - (await lineQty(lineA.id)));

    const r2 = await owner.rpc("void_qr_order_item", { p_store_id: STORE_A, p_order_id: created.id, p_item_id: lineB.id, p_reason: "ของหมด" });
    expect(r2.error, r2.error?.message).toBeNull();
    expect(await variant()).toEqual(before);
    expect(await orderRow(created.id!)).toMatchObject({ status: "cancelled", stock_state: "released" });
  });

  async function lineQty(itemId: string) {
    const { data } = await service.from("order_items").select("quantity").eq("id", itemId).single();
    return (data as { quantity: number }).quantity;
  }

  it("Stock Pool: reserve on order, commit on accept (sale movement), void after accept restores via provenance", async () => {
    const created = await order([latte(2)]);
    expect(created.error, created.error?.message).toBeNull();
    expect(await pool()).toEqual({ quantity: 20, reserved_units: 4 });

    // จองเต็ม Pool ที่เหลือ 16 หน่วย → สั่งอีก 9 แก้ว (18 หน่วย) ต้องไม่ผ่าน
    const oversell = await order([latte(9)]);
    expect(oversell.error?.message).toContain("สต๊อกไม่เพียงพอ");

    const { error } = await owner.from("orders").update({ prep_status: "preparing" }).eq("id", created.id!);
    expect(error, error?.message).toBeNull();
    expect(await pool()).toEqual({ quantity: 16, reserved_units: 0 });
    const { data: moves } = await service
      .from("stock_movements")
      .select("movement_type, quantity_delta")
      .eq("reference_id", created.id!);
    expect(moves).toEqual([{ movement_type: "sale", quantity_delta: -4 }]);

    const [line] = await items(created.id!);
    const v = await owner.rpc("void_qr_order_item", { p_store_id: STORE_A, p_order_id: created.id, p_item_id: line.id, p_reason: "ลูกค้าเปลี่ยนใจ" });
    expect(v.error, v.error?.message).toBeNull();
    expect(await pool()).toEqual({ quantity: 20, reserved_units: 0 });
  });

  it("customers (anon) see sellable units of pooled menu items net of reservations", async () => {
    const anon = createClient(local.url, local.publishableKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const before = await pool();
    const held = await order([latte(3)]); // จอง 6 หน่วย
    expect(held.error, held.error?.message).toBeNull();

    const { data, error } = await anon.rpc("qr_menu_pool_availability", { p_store_id: STORE_A });
    expect(error, error?.message).toBeNull();
    const row = (data as { variant_id: string; sellable_units: number }[]).find((r) => r.variant_id === VARIANT_2);
    expect(row?.sellable_units).toBe(Math.floor((before.quantity - before.reserved_units - 6) / 2));

    // anon อ่านตาราง Pool ตรงไม่ได้
    const direct = await anon.from("stock_pools").select("quantity").eq("id", poolId!);
    expect(direct.data ?? []).toEqual([]);

    await service.rpc("cancel_qr_order_by_customer", { p_store_id: STORE_A, p_table_id: TABLE_1, p_order_id: held.id });
    expect(await pool()).toEqual(before);
  });

  it("paying an order the kitchen never accepted commits the reservation", async () => {
    const before = await variant();
    const created = await order([coffee(1)]);
    expect(created.error, created.error?.message).toBeNull();

    const { error } = await owner.rpc("close_pos_order_payment", {
      p_order_id: created.id,
      p_store_id: STORE_A,
      p_processed_by_user_id: OWNER_ID,
      p_method: "qr_promptpay",
      p_amount: 45,
    });
    expect(error, error?.message).toBeNull();
    expect(await variant()).toEqual({ stock_quantity: before.stock_quantity - 1, reserved_quantity: before.reserved_quantity });
    expect(await orderRow(created.id!)).toMatchObject({ status: "paid", stock_state: "committed" });
  });

  it("POS-created orders cannot take stock that is reserved for QR orders", async () => {
    const current = await variant();
    // จองจนพร้อมขายเหลือ 0
    const hold = await order([coffee(current.stock_quantity - current.reserved_quantity)]);
    expect(hold.error, hold.error?.message).toBeNull();

    seq += 1;
    const { data: posOrder, error: insErr } = await service
      .from("orders")
      .insert({
        organization_id: ORG_A,
        store_id: STORE_A,
        order_number: `RSV-POS-${Date.now()}-${seq}`,
        status: "open",
        cashier_id: OWNER_ID,
        subtotal: 45,
        discount: 0,
        total: 45,
        qr_order_source: false,
      })
      .select("id")
      .single();
    expect(insErr, insErr?.message).toBeNull();
    orderIds.push(posOrder!.id);
    await service.from("order_items").insert({
      order_id: posOrder!.id,
      product_id: PRODUCT_1,
      product_name: "กาแฟดำ",
      variant_id: VARIANT_1,
      quantity: 1,
      unit_price: 45,
      total_price: 45,
    });

    const { error } = await owner.rpc("close_pos_order_payment", {
      p_order_id: posOrder!.id,
      p_store_id: STORE_A,
      p_processed_by_user_id: OWNER_ID,
      p_method: "qr_promptpay",
      p_amount: 45,
    });
    expect(error?.message).toContain("สินค้าเหลือไม่พอ");

    // คืนยอดจองให้ test อื่น
    await service.rpc("cancel_qr_order_by_customer", { p_store_id: STORE_A, p_table_id: TABLE_1, p_order_id: hold.id });
  });
});
