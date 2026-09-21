import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getLocalSupabase, type LocalSupabase } from "./helpers/local-supabase";

// บิลรวมโต๊ะ (migration 20260918040000) — ตั๋วอัตโนมัติ atomic + consolidate_table_bill
// ต้องตั้ง env ก่อนรัน (ขาด = skip): LOCAL_SUPABASE_URL / LOCAL_SUPABASE_PUBLISHABLE_KEY / LOCAL_SUPABASE_SERVICE_KEY

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

describe.skipIf(!envReady)("table bill consolidation (local supabase)", () => {
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
    const { data: station } = await service
      .from("kitchen_stations")
      .insert({ organization_id: ORG_A, store_id: STORE_A, name: `Bill Station ${Date.now()}` })
      .select("id")
      .single();
    stationId = station!.id;
    await service
      .from("products")
      .update({ available_for_qr: true, is_active: true, kitchen_station_id: stationId })
      .in("id", [PRODUCT_1, PRODUCT_2]);
    await service
      .from("product_variants")
      .update({ track_stock: true, stock_quantity: 50, reserved_quantity: 0 })
      .eq("id", VARIANT_1);
    const { data: pool } = await service
      .from("stock_pools")
      .insert({ organization_id: ORG_A, store_id: STORE_A, name: `นม bill ${Date.now()}`, unit_label: "ช็อต", quantity: 40 })
      .select("id")
      .single();
    poolId = pool!.id;
    await service.from("variant_stock_links").insert({ variant_id: VARIANT_2, stock_pool_id: poolId, consumption_quantity: 2 });
    await clearTable();
  });

  afterAll(async () => {
    if (!service) return;
    await clearTable();
    if (orderIds.length > 0) {
      await service.from("stock_movements").delete().in("reference_id", orderIds);
      await service.from("orders").update({ merged_into_order_id: null }).in("id", orderIds);
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

  /** ปิดออเดอร์เปิดค้างของโต๊ะ (จาก test อื่น/รอบก่อน) ไม่ให้ปนกับการรวมบิล */
  async function clearTable() {
    const { data } = await service
      .from("orders")
      .select("id")
      .eq("table_id", TABLE_1)
      .in("status", ["open", "pending_payment"]);
    for (const row of (data ?? []) as { id: string }[]) {
      await service.from("orders").update({ status: "cancelled" }).eq("id", row.id);
    }
    await service.from("pos_saved_tickets").delete().eq("table_id", TABLE_1);
  }

  function coffee(quantity: number) {
    return {
      product_id: PRODUCT_1, product_name: "กาแฟดำ", variant_id: VARIANT_1, variant_name: "เล็ก (S)",
      modifiers: [{ option: { id: OPTION_1, name: "ไม่หวาน", priceAdjustment: 0 } }],
      quantity, unit_price: 45, total_price: 45 * quantity, note: null,
    };
  }
  function latte(quantity: number) {
    return {
      product_id: PRODUCT_2, product_name: "ลาเต้", variant_id: VARIANT_2, variant_name: "เล็ก (S)",
      modifiers: [{ option: { id: OPTION_2, name: "ไม่หวาน", priceAdjustment: 0 } }],
      quantity, unit_price: 55, total_price: 55 * quantity, note: null,
    };
  }

  async function qrOrder(items: ReturnType<typeof coffee>[], accept = true) {
    seq += 1;
    const { data, error } = await service.rpc("create_qr_order_with_items", {
      p_organization_id: ORG_A, p_store_id: STORE_A, p_table_id: TABLE_1,
      p_order_number: `TB-${Date.now()}-${seq}`,
      p_subtotal: items.reduce((s, i) => s + i.total_price, 0), p_items: items,
    });
    expect(error, error?.message).toBeNull();
    orderIds.push(data as string);
    if (accept) {
      const res = await owner.from("orders").update({ prep_status: "served" }).eq("id", data as string);
      expect(res.error, res.error?.message).toBeNull();
    }
    return data as string;
  }

  async function posOrder(qty: number, discount = 0) {
    seq += 1;
    const { data, error } = await service
      .from("orders")
      .insert({
        organization_id: ORG_A, store_id: STORE_A, order_number: `TB-POS-${Date.now()}-${seq}`,
        status: "pending_payment", cashier_id: OWNER_ID, table_id: TABLE_1, table_number: "1",
        subtotal: 45 * qty, discount, total: 45 * qty - discount, qr_order_source: false,
      })
      .select("id")
      .single();
    expect(error, error?.message).toBeNull();
    orderIds.push(data!.id);
    await service.from("order_items").insert({
      order_id: data!.id, product_id: PRODUCT_1, product_name: "กาแฟดำ", variant_id: VARIANT_1,
      quantity: qty, unit_price: 45, total_price: 45 * qty,
    });
    return data!.id as string;
  }

  /** ตั๋วของโต๊ะ (มีรายการ) — คืน id + updated_at ที่ RPC ใช้ตรวจเวอร์ชัน */
  async function tableTicket() {
    const { data, error } = await service
      .from("pos_saved_tickets")
      .insert({
        organization_id: ORG_A, store_id: STORE_A, ticket_number: `T-${seq}`, label: "โต๊ะ 1",
        cart_snapshot: { storeId: STORE_A, items: [{ key: "x" }], subtotal: 0, discount: 0, total: 0 },
        created_by_user_id: OWNER_ID, updated_by_user_id: OWNER_ID, table_id: TABLE_1, table_number: "1",
      })
      .select("id, updated_at")
      .single();
    expect(error, error?.message).toBeNull();
    return data as { id: string; updated_at: string };
  }

  async function consolidate(
    key: string,
    pos: string | null = null,
    ticket: { id: string; updated_at: string } | null = null,
  ) {
    seq += 1;
    const res = await owner.rpc("consolidate_table_bill", {
      p_store_id: STORE_A, p_table_id: TABLE_1, p_table_bill_key: key,
      p_order_number: `TB-BILL-${Date.now()}-${seq}`, p_pos_order_id: pos,
      p_ticket_id: ticket?.id ?? null, p_ticket_updated_at: ticket?.updated_at ?? null,
    });
    if (res.data) orderIds.push(res.data as string);
    return res as { data: string | null; error: { message: string } | null };
  }

  async function variant() {
    const { data } = await service.from("product_variants").select("stock_quantity, reserved_quantity").eq("id", VARIANT_1).single();
    return data as { stock_quantity: number; reserved_quantity: number };
  }
  async function pool() {
    const { data } = await service.from("stock_pools").select("quantity, reserved_units").eq("id", poolId!).single();
    return data as { quantity: number; reserved_units: number };
  }

  it("opening a table from two devices at once creates exactly one auto ticket", async () => {
    await clearTable();
    const call = () =>
      owner.rpc("ensure_table_auto_ticket", {
        p_ticket_id: randomUUID(), p_organization_id: ORG_A, p_store_id: STORE_A, p_table_id: TABLE_1,
        p_ticket_number: "T0000-0001", p_label: "โต๊ะ 1", p_table_number: "1",
        p_cart: { storeId: STORE_A, items: [], subtotal: 0, discount: 0, total: 0 },
      });
    const [a, b] = await Promise.all([call(), call()]);
    expect(a.error, a.error?.message).toBeNull();
    expect(b.error, b.error?.message).toBeNull();
    expect((a.data as { id: string }[])[0].id).toBe((b.data as { id: string }[])[0].id);
    const { count } = await service
      .from("pos_saved_tickets")
      .select("id", { count: "exact", head: true })
      .eq("table_id", TABLE_1)
      .eq("ticket_source", "table_auto");
    expect(count).toBe(1);
  });

  it("refuses to bill while the kitchen has not accepted an order", async () => {
    await clearTable();
    await qrOrder([coffee(1)], false);
    const res = await consolidate(`key-${randomUUID()}`);
    expect(res.error?.message).toContain("ครัวยังไม่รับ");
  });

  it("merges QR orders + the POS ticket into one bill, deducts ticket items once, payment does not deduct again", async () => {
    await clearTable();
    const start = await variant();
    const qrA = await qrOrder([coffee(2)]);
    const qrB = await qrOrder([coffee(1)]);
    const pos = await posOrder(3, 10);
    const ticket = await tableTicket();
    const afterAccept = await variant();
    expect(afterAccept.stock_quantity).toBe(start.stock_quantity - 3); // QR ตัดตอนครัวรับ

    const key = `key-${randomUUID()}`;
    const bill = await consolidate(key, pos, ticket);
    expect(bill.error, bill.error?.message).toBeNull();
    const again = await consolidate(key, pos, ticket);
    expect(again.data).toBe(bill.data); // idempotent

    expect((await variant()).stock_quantity).toBe(start.stock_quantity - 6); // ตั๋วตัดตอนรวมบิล
    const { data: target } = await service
      .from("orders")
      .select("status, subtotal, discount, total, qr_order_source, stock_state, table_id")
      .eq("id", bill.data!)
      .single();
    expect(target).toMatchObject({ status: "open", subtotal: 270, discount: 10, total: 260, qr_order_source: true, stock_state: "committed", table_id: TABLE_1 });
    const { data: sources } = await service
      .from("orders")
      .select("id, status, merged_into_order_id")
      .in("id", [qrA, qrB, pos]);
    for (const s of sources as { status: string; merged_into_order_id: string }[]) {
      expect(s).toMatchObject({ status: "cancelled", merged_into_order_id: bill.data });
    }
    const { count } = await service.from("order_items").select("id", { count: "exact", head: true }).eq("order_id", bill.data!);
    expect(count).toBe(3);
    // ตั๋วถูกใช้ใน transaction เดียวกับการรวมบิล
    const { data: consumed } = await service.from("pos_saved_tickets").select("cart_snapshot").eq("id", ticket.id).single();
    expect((consumed as { cart_snapshot: { items: unknown[] } }).cart_snapshot.items).toEqual([]);

    const paid = await owner.rpc("close_pos_order_payment", {
      p_order_id: bill.data, p_store_id: STORE_A, p_processed_by_user_id: OWNER_ID,
      p_method: "qr_promptpay", p_amount: 260,
    });
    expect(paid.error, paid.error?.message).toBeNull();
    expect((await variant()).stock_quantity).toBe(start.stock_quantity - 6); // ไม่ตัดซ้ำ
  });

  it("Stock Pool provenance follows the merged items: voiding a line on the bill restores the pool", async () => {
    await clearTable();
    const start = await pool();
    await qrOrder([latte(2)]); // 4 หน่วย
    await qrOrder([latte(1)]); // 2 หน่วย
    expect(await pool()).toEqual({ quantity: start.quantity - 6, reserved_units: 0 });

    const bill = await consolidate(`key-${randomUUID()}`);
    expect(bill.error, bill.error?.message).toBeNull();
    const { data: lines } = await service
      .from("order_items")
      .select("id, quantity")
      .eq("order_id", bill.data!)
      .order("quantity", { ascending: false });
    const big = (lines as { id: string; quantity: number }[])[0];
    expect(big.quantity).toBe(2);

    const v = await owner.rpc("void_qr_order_item", {
      p_store_id: STORE_A, p_order_id: bill.data, p_item_id: big.id, p_reason: "ลูกค้าไม่เอา",
    });
    expect(v.error, v.error?.message).toBeNull();
    expect(await pool()).toEqual({ quantity: start.quantity - 2, reserved_units: 0 });
    const { data: target } = await service.from("orders").select("total").eq("id", bill.data!).single();
    expect(target).toMatchObject({ total: 55 });
  });

  it("an unpaid bill can be re-consolidated with new orders and pool provenance still follows every level", async () => {
    await clearTable();
    const start = await pool();
    await qrOrder([latte(1)]);
    const first = await consolidate(`key-${randomUUID()}`);
    expect(first.error, first.error?.message).toBeNull();
    // พนักงานยกเลิกหน้าจ่ายเงิน ลูกค้าสั่งเพิ่ม แล้วเช็คบิลใหม่
    await qrOrder([latte(2)]);
    const second = await consolidate(`key-${randomUUID()}`);
    expect(second.error, second.error?.message).toBeNull();
    expect(second.data).not.toBe(first.data);
    const { data: old } = await service.from("orders").select("status, merged_into_order_id").eq("id", first.data!).single();
    expect(old).toMatchObject({ status: "cancelled", merged_into_order_id: second.data });

    const { data: lines } = await service.from("order_items").select("id, quantity").eq("order_id", second.data!);
    expect(lines).toHaveLength(2);
    const single = (lines as { id: string; quantity: number }[]).find((l) => l.quantity === 1)!;
    const v = await owner.rpc("void_qr_order_item", {
      p_store_id: STORE_A, p_order_id: second.data, p_item_id: single.id, p_reason: "แก้ไขก่อนชำระ",
    });
    expect(v.error, v.error?.message).toBeNull();
    expect(await pool()).toEqual({ quantity: start.quantity - 4, reserved_units: 0 });
  });

  it("a stale ticket version rolls the whole consolidation back (two devices / edited ticket)", async () => {
    await clearTable();
    await qrOrder([coffee(1)]);
    const pos = await posOrder(1);
    const ticket = await tableTicket();
    const stockBefore = await variant();
    const res = await consolidate(`key-${randomUUID()}`, pos, { id: ticket.id, updated_at: "2020-01-01T00:00:00Z" });
    expect(res.error?.message).toContain("ตั๋วถูกแก้ไข");
    // ไม่มีอะไรเปลี่ยน: ตั๋วยังมีรายการ, ออเดอร์ POS ยังไม่ตัดสต๊อก/ไม่ถูกรวม
    const { data: t } = await service.from("pos_saved_tickets").select("cart_snapshot").eq("id", ticket.id).single();
    expect((t as { cart_snapshot: { items: unknown[] } }).cart_snapshot.items).toHaveLength(1);
    expect(await variant()).toEqual(stockBefore);
    const { data: p } = await service.from("orders").select("status, merged_into_order_id").eq("id", pos).single();
    expect(p).toMatchObject({ status: "pending_payment", merged_into_order_id: null });
  });

  it("items from a ticket require the ticket", async () => {
    await clearTable();
    const pos = await posOrder(1);
    const res = await consolidate(`key-${randomUUID()}`, pos, null);
    expect(res.error?.message).toContain("ต้องระบุตั๋ว");
  });

  it("refuses an empty table", async () => {
    await clearTable();
    const res = await consolidate(`key-${randomUUID()}`);
    expect(res.error?.message).toContain("ไม่มีรายการ");
  });
});
