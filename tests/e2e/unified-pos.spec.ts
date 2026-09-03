import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { readLocalSupabaseStatusEnv } from "./helpers/local-supabase-env";
import { computeRequestHash, createOperationKey } from "../../src/modules/unified-pos/envelope";

// U9 — unified POS shell e2e (chromium): feature flag / legacy fallback / responsive
// U10 — เพิ่มชุดคิวครัว (unified kitchen queue): realtime transition / conflict refetch / reconnect
// กฎ fail-loud: ทุก fixture ยิงผ่าน local stack env ที่ playwright.config.ts inject
// (จาก "supabase status -o env") — ถ้า local stack ไม่พร้อม ให้ทดสอบล้ม ห้าม fallback ไป remote
// Billing precondition: app gate (src/modules/auth/guards.ts → hasBillingAccess) อนุญาตเฉพาะ
// paid plan ที่ period ยังไม่หมด — seed ให้ plan=free ซึ่งเข้า /pos ไม่ได้ตาม design ของ gate
// จึงตั้ง subscription เป็น premium ชั่วคราวระหว่างรัน แล้วคืนค่าเดิมใน afterAll เสมอ (เหมือน flag)
// Cash-session precondition: legacy terminal force-open dialog "เปิดรอบเงินสด" เมื่อไม่มี session
// เปิด (บังการคลิกแท็กของ shell) — จึงเปิด session ไว้ก่อนและลบแถวที่สร้างเองทิ้งใน afterAll

const SEED_STORE_ID = "cccccccc-0000-0000-0000-000000000001"; // Main Branch (seed.sql)
const OWNER_AUTH_USER_ID = "00000000-0000-0000-0000-000000000001"; // owner (seed.sql)
const OWNER_EMAIL = "owner@demo.local";
const OWNER_PASSWORD = "demo1234";

let service: SupabaseClient;
let originalFlag: boolean | null = null;
let orgId: string | null = null;
let originalSubscription: { plan: string; status: string; current_period_end: string } | null = null;
let createdCashSessionId: string | null = null;

async function setUnifiedPosFlag(value: boolean): Promise<void> {
  // service client (bypass RLS) — อัปเดตเฉพาะ flag + updated_at ของ seed store
  const { error } = await service
    .from("stores")
    .update({ unified_pos_enabled: value, updated_at: new Date().toISOString() })
    .eq("id", SEED_STORE_ID);
  if (error) {
    throw new Error(`ตั้ง stores.unified_pos_enabled = ${value} (local) ไม่สำเร็จ: ${error.message}`);
  }
}

async function loginOwner(page: Page): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(OWNER_EMAIL);
  await page.locator("#password").fill(OWNER_PASSWORD);
  await page.getByRole("button", { name: "เข้าสู่ระบบ" }).click();
  // server action redirect ไป landing path ของ user — รอจนออกจากหน้า login
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
}

test.beforeAll(async () => {
  const env = readLocalSupabaseStatusEnv(); // throw ถ้า local stack ไม่พร้อม (fail-loud)
  service = createClient(env.apiUrl, env.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const { data, error } = await service
    .from("stores")
    .select("organization_id, unified_pos_enabled")
    .eq("id", SEED_STORE_ID)
    .single();
  if (error || !data) {
    throw new Error(`อ่าน seed store (local) ไม่สำเร็จ: ${error?.message ?? "ไม่พบแถว"}`);
  }
  originalFlag = data.unified_pos_enabled;
  orgId = data.organization_id;

  // Billing precondition (ดูหัวไฟล์): อ่านค่าเดิมก่อน แล้วตั้งเป็น paid plan ที่ยังไม่หมดอายุ
  // — ไม่เดาค่า seed ถ้าแถว subscription หายให้ล้มทันที (fail-loud)
  const sub = await service
    .from("subscriptions")
    .select("plan, status, current_period_end")
    .eq("organization_id", orgId)
    .maybeSingle();
  if (sub.error || !sub.data) {
    throw new Error(`อ่าน subscriptions เดิมของ seed org (local) ไม่สำเร็จ: ${sub.error?.message ?? "ไม่พบแถว"}`);
  }
  originalSubscription = {
    plan: String(sub.data.plan),
    status: String(sub.data.status),
    current_period_end: String(sub.data.current_period_end),
  };
  const { error: subUpdateError } = await service
    .from("subscriptions")
    .update({
      plan: "premium",
      status: "active",
      current_period_end: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    })
    .eq("organization_id", orgId);
  if (subUpdateError) {
    throw new Error(`ตั้ง subscription เป็น paid plan ชั่วคราว (local) ไม่สำเร็จ: ${subUpdateError.message}`);
  }

  // Cash-session precondition: legacy terminal force-open dialog "เปิดรอบเงินสด"
  // (forceOpenPrompt = ไม่มี session เปิด + ผู้ใช้มีสิทธิ์ cashflow.record) — overlay นี้
  // บังคลิกทุกแท็บของ shell จึงต้องมี session เปิดไว้ก่อน ถ้ามีอยู่แล้วใช้ของเดิม
  // (unique index 1 open session/store — ห้ามสร้างซ้ำ) และเก็บกวาดเฉพาะแถวที่สร้างเอง
  const openSession = await service
    .from("cash_sessions")
    .select("id")
    .eq("store_id", SEED_STORE_ID)
    .eq("status", "open")
    .maybeSingle();
  if (openSession.error) {
    throw new Error(`อ่าน cash_sessions (local) ไม่สำเร็จ: ${openSession.error.message}`);
  }
  if (!openSession.data) {
    const inserted = await service
      .from("cash_sessions")
      .insert({
        organization_id: orgId,
        store_id: SEED_STORE_ID,
        status: "open",
        opening_float: 0,
        opened_by_user_id: OWNER_AUTH_USER_ID,
        open_note: "U9 e2e fixture",
      })
      .select("id")
      .single();
    if (inserted.error || !inserted.data) {
      throw new Error(`เปิด cash session ชั่วคราว (local) ไม่สำเร็จ: ${inserted.error?.message ?? "ไม่ได้แถวที่ insert"}`);
    }
    createdCashSessionId = inserted.data.id;
  }
});

test.afterAll(async () => {
  // คืนค่าเดิมของ seed data เสมอ ไม่ว่า test จะผ่านหรือพัง — flag กับ subscription คืน
  // อิสระกัน (ถ้าคืนตัวใดตัวหนึ่งไม่ได้ ต้อง fail-loud ไม่ปล่อยเงียบ)
  const failures: string[] = [];
  if (service && originalFlag !== null) {
    const { error } = await service
      .from("stores")
      .update({ unified_pos_enabled: originalFlag, updated_at: new Date().toISOString() })
      .eq("id", SEED_STORE_ID);
    if (error) failures.push(`stores.unified_pos_enabled: ${error.message}`);
  }
  if (service && originalSubscription && orgId) {
    const { error } = await service
      .from("subscriptions")
      .update(originalSubscription)
      .eq("organization_id", orgId);
    if (error) failures.push(`subscriptions: ${error.message}`);
  }
  if (service && createdCashSessionId) {
    const { error } = await service
      .from("cash_sessions")
      .delete()
      .eq("id", createdCashSessionId);
    if (error) failures.push(`cash_sessions: ${error.message}`);
  }
  if (failures.length > 0) {
    throw new Error(`คืนค่า fixture เดิม (local) ไม่ครบ: ${failures.join(" | ")}`);
  }
});

test.describe("flag เปิด (unified shell)", () => {
  test.beforeAll(async () => {
    await setUnifiedPosFlag(true);
  });

  test("feature flag: /pos แสดง shell 4 แท็บ และ bridge หน้าขายเดิมไว้ในแท็บขาย", async ({ page }) => {
    await loginOwner(page);
    await page.goto("/pos");

    const tablist = page.getByRole("tablist", { name: "ส่วนของ POS รวม" });
    await expect(tablist).toBeVisible();
    for (const label of ["ขาย", "โต๊ะ", "ครัว", "บิล"]) {
      await expect(page.getByRole("tab", { name: label })).toBeVisible();
    }

    // แท็บโต๊ะ: แสดงบริบทโต๊ะจาก seed (3 โต๊ะ) และเลือกได้ — scope ใน panel กัน text ซ้ำ
    // จาก legacy terminal ที่ยัง mounted (hidden) อยู่ในแท็บขาย
    const tablesPanel = page.getByRole("tabpanel", { name: "โต๊ะ" });
    await page.getByRole("tab", { name: "โต๊ะ" }).click();
    await expect(tablesPanel.getByText("โต๊ะ 1")).toBeVisible();
    await expect(tablesPanel.getByText("โต๊ะ 2")).toBeVisible();
    await expect(tablesPanel.getByText("โต๊ะ 3")).toBeVisible();
    await tablesPanel.getByRole("button", { name: "เลือกโต๊ะ" }).first().click();

    // แท็บครัว (U10): เป็นคิวครัวจริงแบบเรียลไทม์แล้ว — ตรวจหัวข้อ + ตัวกรองสถานะ/โต๊ะ
    // (คิวว่างหรือมีข้อมูลค้างจาก dataset local ก็แสดงผลได้ จึงไม่ assert จำนวนการ์ดที่นี่
    //  — พฤติกรรมคิวครัวกับข้อมูลจริงครอบใน describe คิวครัว U10 ด้านล่าง)
    await page.getByRole("tab", { name: "ครัว" }).click();
    const kitchenPanel = page.getByRole("tabpanel", { name: "ครัว" });
    await expect(kitchenPanel.getByRole("heading", { name: "คิวครัว" })).toBeVisible();
    await expect(kitchenPanel.getByLabel("สถานะ")).toBeVisible();
    await expect(kitchenPanel.getByLabel("โต๊ะ")).toBeVisible();
    await page.getByRole("tab", { name: "บิล" }).click();
    await expect(page.getByRole("tabpanel", { name: "บิล" }).getByRole("heading", { name: "บิลและการพิมพ์" })).toBeVisible();
    // U11 — แท็บบิลจริงแล้ว: โต๊ะถูกเลือกไว้ (จากการคลิกแท็บโต๊ะด้านบน) และ seed ยังไม่มีบิลค้าง
    await expect(page.getByRole("tabpanel", { name: "บิล" }).getByText(/โต๊ะนี้ไม่มีบิลค้างชำระ/)).toBeVisible();

    // แท็บขาย: bridge หน้าขายเดิม + ชิปบริบทโต๊ะที่เพิ่งเลือก
    await page.getByRole("tab", { name: "ขาย" }).click();
    await expect(page.getByText(/โต๊ะที่เลือก:/)).toBeVisible();
    await expect(page.getByText("ขายหน้าร้าน · POS")).toBeVisible();
  });

  test("responsive: shell ไม่มี horizontal overflow ที่ความกว้าง 390/768/1440", async ({ page }) => {
    await loginOwner(page);
    for (const width of [390, 768, 1440]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto("/pos");
      await expect(page.getByRole("tablist", { name: "ส่วนของ POS รวม" })).toBeVisible();
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `ความกว้าง ${width}px ต้องไม่มี horizontal overflow`).toBeLessThanOrEqual(1);
    }
  });
});

test.describe("flag ปิด (legacy fallback)", () => {
  test.beforeAll(async () => {
    await setUnifiedPosFlag(false);
  });

  test("legacy fallback: /pos แสดง legacy POS terminal เหมือนเดิม โดยไม่มี shell", async ({ page }) => {
    await loginOwner(page);
    await page.goto("/pos");

    // legacy terminal ยังทำงานเหมือนเดิมทุกอย่าง (ไม่มี visual/behavioral change)
    await expect(page.getByText("ขายหน้าร้าน · POS")).toBeVisible();
    await expect(page.getByRole("button", { name: "เปิดโต๊ะ" })).toBeVisible();

    // และไม่มี unified shell ใดๆ
    await expect(page.getByRole("tablist", { name: "ส่วนของ POS รวม" })).toHaveCount(0);
    await expect(page.getByRole("tab", { name: "ครัว" })).toHaveCount(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// U10 — คิวครัว (unified kitchen queue): realtime transition / conflict refetch / reconnect
//
// fixture เพิ่มเติมของชุดนี้ (อ่านค่าเดิมก่อนแล้วคืนใน afterAll ของ describe เสมอ —
// fail-loud เหมือน fixture ชุดบน): เปิด QR submit policy (stores.qr_ordering_enabled +
// table_open_policy="customer_self"), session ของโต๊ะ 1 และ products.available_for_qr
// — เพราะ unified_pos_submit_table_order (U4) ตรวจเงื่อนไขพวกนี้ก่อนสร้างออเดอร์
// ออเดอร์ที่ seed (ผ่าน create_qr_order_with_items_v2 — service client) ถูกลบทิ้งใน afterAll
test.describe("คิวครัว U10 (unified kitchen queue)", () => {
  const PRODUCT_1 = "22222222-0000-0000-0000-000000000001"; // กาแฟดำ (seed.sql)
  const VARIANT_1 = "33333333-0000-0000-0000-000000000001"; // เล็ก (S)
  const TABLE_1 = "eeeeeeee-0000-0000-0000-000000000001";
  let runId: string;
  const createdOrderIds: string[] = [];
  let originalStoreQr: {
    qr_ordering_enabled: boolean;
    table_open_policy: "staff_only" | "customer_self";
  } | null = null;
  let originalTableSession: {
    qr_enabled: boolean;
    session_started_at: string | null;
    session_expires_at: string | null;
  } | null = null;
  let originalProductQr: { available_for_qr: boolean; kitchen_station_id: string | null } | null = null;
  let stationId: string | null = null;

  test.beforeAll(async () => {
    runId = randomUUID().slice(0, 8);
    await setUnifiedPosFlag(true);

    // อ่านค่าเดิมของ fixture ก่อนแก้ (fail-loud — ห้ามเดาค่า seed)
    const storeRow = await service
      .from("stores")
      .select("qr_ordering_enabled, table_open_policy")
      .eq("id", SEED_STORE_ID)
      .single();
    if (storeRow.error || !storeRow.data) {
      throw new Error(`อ่าน stores (local) ไม่สำเร็จ: ${storeRow.error?.message ?? "ไม่พบแถว"}`);
    }
    originalStoreQr = {
      qr_ordering_enabled: storeRow.data.qr_ordering_enabled,
      table_open_policy: storeRow.data.table_open_policy,
    };

    const tableRow = await service
      .from("tables")
      .select("qr_enabled, session_started_at, session_expires_at")
      .eq("id", TABLE_1)
      .single();
    if (tableRow.error || !tableRow.data) {
      throw new Error(`อ่าน tables (local) ไม่สำเร็จ: ${tableRow.error?.message ?? "ไม่พบแถว"}`);
    }
    originalTableSession = tableRow.data;

    const productRow = await service
      .from("products")
      .select("available_for_qr, kitchen_station_id")
      .eq("id", PRODUCT_1)
      .single();
    if (productRow.error || !productRow.data) {
      throw new Error(`อ่าน products (local) ไม่สำเร็จ: ${productRow.error?.message ?? "ไม่พบแถว"}`);
    }
    originalProductQr = {
      available_for_qr: productRow.data.available_for_qr,
      kitchen_station_id: productRow.data.kitchen_station_id,
    };

    // เปิดเส้นทาง submit QR ชั่วคราว (validation อยู่ใน unified_pos_submit_table_order)
    // — QR item ต้องผูก kitchen station (U4 validation) จึงสร้าง station ชั่วคราวเหมือน U5
    const insertedStation = await service
      .from("kitchen_stations")
      .insert({ organization_id: orgId, store_id: SEED_STORE_ID, name: `U10 Kitchen E2E ${runId}` })
      .select("id")
      .single();
    if (insertedStation.error || !insertedStation.data) {
      throw new Error(`สร้าง kitchen station ชั่วคราว (local) ไม่สำเร็จ: ${insertedStation.error?.message ?? "ไม่ได้แถวที่ insert"}`);
    }
    stationId = insertedStation.data.id;
    const { error: storeErr } = await service
      .from("stores")
      .update({ qr_ordering_enabled: true, table_open_policy: "customer_self" })
      .eq("id", SEED_STORE_ID);
    if (storeErr) throw new Error(`เปิด QR policy ชั่วคราว (local) ไม่สำเร็จ: ${storeErr.message}`);
    const { error: tableErr } = await service
      .from("tables")
      .update({
        qr_enabled: true,
        session_started_at: new Date().toISOString(),
        session_expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      })
      .eq("id", TABLE_1);
    if (tableErr) throw new Error(`เปิด session โต๊ะ 1 ชั่วคราว (local) ไม่สำเร็จ: ${tableErr.message}`);
    const { error: productErr } = await service
      .from("products")
      .update({ available_for_qr: true, kitchen_station_id: stationId })
      .eq("id", PRODUCT_1);
    if (productErr) throw new Error(`เปิด available_for_qr ชั่วคราว (local) ไม่สำเร็จ: ${productErr.message}`);
  });

  test.afterAll(async () => {
    // คืนค่า fixture เดิมเสมอ: ลบออเดอร์ที่ seed + คืน store policy / table session / product
    const failures: string[] = [];
    if (service && createdOrderIds.length > 0) {
      const { error } = await service.from("orders").delete().in("id", createdOrderIds);
      if (error) failures.push(`orders: ${error.message}`);
    }
    if (service && originalStoreQr) {
      const { error } = await service.from("stores").update(originalStoreQr).eq("id", SEED_STORE_ID);
      if (error) failures.push(`stores (qr/policy): ${error.message}`);
    }
    if (service && originalTableSession) {
      const { error } = await service.from("tables").update(originalTableSession).eq("id", TABLE_1);
      if (error) failures.push(`tables: ${error.message}`);
    }
    if (service && originalProductQr) {
      const { error } = await service.from("products").update(originalProductQr).eq("id", PRODUCT_1);
      if (error) failures.push(`products: ${error.message}`);
    }
    if (service && stationId) {
      const { error } = await service.from("kitchen_stations").delete().eq("id", stationId);
      if (error) failures.push(`kitchen_stations: ${error.message}`);
    }
    if (failures.length > 0) {
      throw new Error(`คืนค่า fixture คิวครัว U10 (local) ไม่ครบ: ${failures.join(" | ")}`);
    }
  });

  /** seed ออเดอร์ QR 1 เส้นผ่าน RPC submit (service client) — คืน order/item id */
  async function submitQrOrder(): Promise<{ orderId: string; itemId: string }> {
    // กาแฟดำมี modifier group "ความหวาน" แบบ required (min 1) — ต้องแนบ option มาด้วย
    // (รูปทรงเดียวกับ makeItems ของ integration test U5; ราคา 45 = base + variant + modifier)
    const line = {
      product_id: PRODUCT_1,
      product_name: "กาแฟดำ",
      variant_id: VARIANT_1,
      variant_name: "เล็ก (S)",
      modifiers: [{ option: { id: "55555555-0000-0000-0000-000000000001", name: "ไม่หวาน", priceAdjustment: 0 } }],
      quantity: 1,
      unit_price: 45,
      total_price: 45,
      note: `U10-kitchen-e2e-${runId}`,
    };
    const { data, error } = await service.rpc("create_qr_order_with_items_v2", {
      p_organization_id: orgId,
      p_store_id: SEED_STORE_ID,
      p_table_id: TABLE_1,
      p_order_number: `U10-${runId}-${createdOrderIds.length + 1}`,
      p_operation_key: createOperationKey(),
      p_request_hash: computeRequestHash({ storeId: SEED_STORE_ID, tableId: TABLE_1, subtotal: 45, items: [line] }),
      p_subtotal: 45,
      p_items: [line],
    });
    if (error) {
      throw new Error(`submit QR order (local) ไม่สำเร็จ: ${error.message}`);
    }
    const outcome = data as { status: string; result?: { order_id: string } } | null;
    if (!outcome || outcome.status !== "executed" || !outcome.result?.order_id) {
      throw new Error(`submit QR order (local) คืนสถานะไม่คาดคิด: ${JSON.stringify(outcome)}`);
    }
    const orderId = outcome.result.order_id;
    createdOrderIds.push(orderId);
    const itemRow = await service.from("order_items").select("id").eq("order_id", orderId).limit(1).single();
    if (itemRow.error || !itemRow.data) {
      throw new Error(`อ่าน order_items ของออเดอร์ seed (local) ไม่สำเร็จ: ${itemRow.error?.message ?? "ไม่พบแถว"}`);
    }
    return { orderId, itemId: itemRow.data.id };
  }

  /** เครื่องอื่นเปลี่ยนสถานะโดยตรงผ่าน governed RPC (service client) — ใช้ทำ conflict/pre-bump */
  async function advanceItemDirect(
    orderId: string,
    itemId: string,
    expectedVersion: number,
    target: string,
  ): Promise<void> {
    const { data, error } = await service.rpc("unified_pos_update_item_fulfillment", {
      p_organization_id: orgId,
      p_store_id: SEED_STORE_ID,
      p_order_id: orderId,
      p_item_id: itemId,
      p_expected_fulfillment_version: expectedVersion,
      p_target_fulfillment_status: target,
      p_operation_key: createOperationKey(),
      p_request_hash: computeRequestHash({
        storeId: SEED_STORE_ID,
        orderId,
        itemId,
        target,
        expectedVersion,
      }),
      p_actor_user_id: OWNER_AUTH_USER_ID,
    });
    if (error) {
      throw new Error(`pre-bump ผ่าน service client (local) ไม่สำเร็จ: ${error.message}`);
    }
    const outcome = data as { status: string } | null;
    if (!outcome || (outcome.status !== "executed" && outcome.status !== "replayed")) {
      throw new Error(`pre-bump (local) คืนสถานะไม่คาดคิด: ${JSON.stringify(outcome)}`);
    }
  }

  test("kitchen: คิวครัวแสดงรายการออเดอร์ QR ที่ส่งแล้ว และเปลี่ยนสถานะผ่าน realtime", async ({ page }) => {
    const seeded = await submitQrOrder();
    await loginOwner(page);
    await page.goto("/pos");
    await page.getByRole("tab", { name: "ครัว" }).click();

    const card = page.locator(`[data-kitchen-item="${seeded.itemId}"]`);
    await expect(card).toBeVisible();
    await expect(card).toHaveAttribute("data-kitchen-state", "new");
    await expect(card.getByText("กาแฟดำ (เล็ก (S))")).toBeVisible();
    await expect(card.getByText("QR")).toBeVisible(); // source
    await expect(card.getByText("โต๊ะ 1")).toBeVisible();
    await expect(card.getByText("v1")).toBeVisible(); // fulfillment_version
    await expect(card.getByText(`“U10-kitchen-e2e-${runId}”`)).toBeVisible();

    // transition ผ่านปุ่ม — สถานะ/version ที่แสดงต้องมาจาก server (ผล action/realtime)
    await card.getByRole("button", { name: "รับรายการ" }).click();
    await expect(card).toHaveAttribute("data-kitchen-state", "preparing");
    await expect(card.getByText("v2")).toBeVisible();
    await expect(card.getByRole("button", { name: "พร้อมเสิร์ฟ" })).toBeVisible();
  });

  test("conflict: เครื่องอื่นเปลี่ยน version ก่อน กดปุ่มซ้ำ → UI refetch แสดงสถานะจาก server", async ({ page }) => {
    const seeded = await submitQrOrder();
    await loginOwner(page);
    // ตัด realtime websocket ของหน้านี้ (routeWebSocket: ไม่ต่อ server จริง) — UI ค้างที่
    // snapshot v1 และต้อง fallback เป็น polling 5s (chip "ออฟไลน์") ตามดีไซน์ U3
    await page.routeWebSocket(/\/realtime\//, () => {});
    await page.goto("/pos");
    await page.getByRole("tab", { name: "ครัว" }).click();

    const kitchenPanel = page.getByRole("tabpanel", { name: "ครัว" });
    const card = page.locator(`[data-kitchen-item="${seeded.itemId}"]`);
    await expect(card.getByText("v1")).toBeVisible();
    await expect(kitchenPanel.getByText("ออฟไลน์")).toBeVisible();

    // เครื่องอื่น (service client) ขยับ 2 ขั้น: v2 preparing → v3 ready
    await advanceItemDirect(seeded.orderId, seeded.itemId, 1, "preparing");
    await advanceItemDirect(seeded.orderId, seeded.itemId, 2, "ready");

    // กดปุ่มด้วย expected v1 → server ปฏิเสธ (up_stale_version / up_invalid_state_transition)
    // → UI ต้อง refetch snapshot และแสดง server truth (ready v3) ไม่ใช่ค่า optimistic (preparing)
    await card.getByRole("button", { name: "รับรายการ" }).click();
    await expect(card).toHaveAttribute("data-kitchen-state", "ready");
    await expect(card.getByText("v3")).toBeVisible();
    await expect(page.getByRole("status")).toContainText(/ถูกอัปเดตจากเครื่องอื่นก่อนหน้า/);
  });

  test("reconnect: ตัดการเชื่อมต่อชั่วคราว แล้วเชื่อมใหม่ → UI converge กับ server ผ่าน refetch snapshot", async ({ page }) => {
    const seeded = await submitQrOrder();
    await loginOwner(page);
    // หมายเหตุวิธีทดสอบ (ไม่ fake pass): ตัด ws ของ realtime ด้วย routeWebSocket (UI แสดง
    // ออฟไลน์ + polling fallback) แล้ว "หลุดชั่วคราว" ด้วย context.setOffline — ช่วง offline
    // server เดินหน้าเองผ่าน service client; ตอนกลับมา UI ต้อง converge ด้วย refetch snapshot
    // (window online / poll 5s) เท่านั้น เพราะไม่มี realtime event ให้ฟัง
    await page.routeWebSocket(/\/realtime\//, () => {});
    await page.goto("/pos");
    await page.getByRole("tab", { name: "ครัว" }).click();

    const kitchenPanel = page.getByRole("tabpanel", { name: "ครัว" });
    const card = page.locator(`[data-kitchen-item="${seeded.itemId}"]`);
    await expect(card.getByText("v1")).toBeVisible();
    await expect(kitchenPanel.getByText("ออฟไลน์")).toBeVisible();

    await page.context().setOffline(true);
    await advanceItemDirect(seeded.orderId, seeded.itemId, 1, "preparing");
    await page.context().setOffline(false);

    // กลับมาออนไลน์ → refetch snapshot → แสดงสถานะจริงล่าสุดจาก server
    await expect(card).toHaveAttribute("data-kitchen-state", "preparing", { timeout: 20_000 });
    await expect(card.getByText("v2")).toBeVisible();
    await expect(card.getByRole("button", { name: "พร้อมเสิร์ฟ" })).toBeVisible();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// U11 — แท็บบิล + settlement→print replay contract (v0.37.2)
//
// fixture ของชุดนี้ (อ่านค่าเดิมก่อนแล้วคืนใน afterAll ของ describe — fail-loud
// เหมือนชุดอื่น): เปิด QR submit policy + session โต๊ะ 1 + product ผูก station
// (เหมือน U10) และตั้ง receipt_settings.auto_print_receipt = true ชั่วคราว
// (ถ้าเป็น false ไม่มีงานพิมพ์อัตโนมัติให้ assert) — ออเดอร์ งานพิมพ์ และ audit
// ที่ชุดนี้สร้าง ถูกลบทิ้งใน afterAll
//
// หมายเหตุ permission/cash: settle ผ่าน UI ใช้วิธี qr_promptpay (cash session ที่
// เปิดไว้ระดับไฟล์ไม่เกี่ยวข้อง) — เหตุผลคือทดสอบ replay/print contract ไม่ใช่เงินสด
test.describe("บิลและการพิมพ์ U11 (bill + payment replay + print)", () => {
  const PRODUCT_1 = "22222222-0000-0000-0000-000000000001"; // กาแฟดำ (seed.sql)
  const VARIANT_1 = "33333333-0000-0000-0000-000000000001"; // เล็ก (S)
  const TABLE_1 = "eeeeeeee-0000-0000-0000-000000000001";
  let runId: string;
  const createdOrderIds: string[] = [];
  /** opkey ของ settle ที่ผ่าน UI (cleanup receipts + settle audit + print jobs) */
  const settledReferences: string[] = [];
  let originalStoreQr: {
    qr_ordering_enabled: boolean;
    table_open_policy: "staff_only" | "customer_self";
  } | null = null;
  let originalTableSession: {
    qr_enabled: boolean;
    session_started_at: string | null;
    session_expires_at: string | null;
  } | null = null;
  let originalProductQr: { available_for_qr: boolean; kitchen_station_id: string | null } | null = null;
  let originalReceiptSettings: {
    auto_print_receipt: boolean;
    auto_print_station_tickets: boolean;
    paper_width: string;
    print_copies: number;
  } | null = null;
  let stationId: string | null = null;
  let printerId: string | null = null;

  test.beforeAll(async () => {
    runId = randomUUID().slice(0, 8);
    await setUnifiedPosFlag(true);

    const storeRow = await service.from("stores").select("qr_ordering_enabled, table_open_policy").eq("id", SEED_STORE_ID).single();
    if (storeRow.error || !storeRow.data) throw new Error(`อ่าน stores (local) ไม่สำเร็จ: ${storeRow.error?.message}`);
    originalStoreQr = storeRow.data;

    const tableRow = await service.from("tables").select("qr_enabled, session_started_at, session_expires_at").eq("id", TABLE_1).single();
    if (tableRow.error || !tableRow.data) throw new Error(`อ่าน tables (local) ไม่สำเร็จ: ${tableRow.error?.message}`);
    originalTableSession = tableRow.data;

    const productRow = await service.from("products").select("available_for_qr, kitchen_station_id").eq("id", PRODUCT_1).single();
    if (productRow.error || !productRow.data) throw new Error(`อ่าน products (local) ไม่สำเร็จ: ${productRow.error?.message}`);
    originalProductQr = productRow.data;

    const settingsRow = await service
      .from("receipt_settings")
      .select("auto_print_receipt, auto_print_station_tickets, paper_width, print_copies")
      .eq("store_id", SEED_STORE_ID)
      .maybeSingle();
    if (settingsRow.error || !settingsRow.data) {
      throw new Error(`อ่าน receipt_settings (local) ไม่สำเร็จ: ${settingsRow.error?.message ?? "ไม่พบแถว"}`);
    }
    originalReceiptSettings = settingsRow.data;

    const insertedStation = await service
      .from("kitchen_stations")
      .insert({ organization_id: orgId, store_id: SEED_STORE_ID, name: `U11 Bill E2E ${runId}` })
      .select("id")
      .single();
    if (insertedStation.error || !insertedStation.data) {
      throw new Error(`สร้าง kitchen station ชั่วคราว (local) ไม่สำเร็จ: ${insertedStation.error?.message}`);
    }
    stationId = insertedStation.data.id;

    // เครื่องพิมพ์ default ผ่าน Print Hub ได้ (IP LAN เอกชน) — print intent ต้องมี
    // target ถึงจะสร้างงานพิมพ์ใบเสร็จ; ลบทิ้งใน afterAll (kitchen_stations.printer_id
    // เป็น on delete set null จึงปลอดภัยกับ station fixture)
    const insertedPrinter = await service
      .from("printers")
      .insert({
        organization_id: orgId,
        store_id: SEED_STORE_ID,
        name: `U11 Bill E2E Printer ${runId}`,
        type: "ip",
        is_default: true,
        ip_address: "192.168.1.250",
        port: 9100,
        paper_width: "80mm",
      })
      .select("id")
      .single();
    if (insertedPrinter.error || !insertedPrinter.data) {
      throw new Error(`สร้าง printer ชั่วคราว (local) ไม่สำเร็จ: ${insertedPrinter.error?.message}`);
    }
    printerId = insertedPrinter.data.id;

    await setStoreField({ qr_ordering_enabled: true, table_open_policy: "customer_self" }, "เปิด QR policy ชั่วคราว");
    const { error: tableErr } = await service.from("tables").update({
      qr_enabled: true,
      session_started_at: new Date().toISOString(),
      session_expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    }).eq("id", TABLE_1);
    if (tableErr) throw new Error(`เปิด session โต๊ะ 1 ชั่วคราว (local) ไม่สำเร็จ: ${tableErr.message}`);
    const { error: productErr } = await service.from("products").update({ available_for_qr: true, kitchen_station_id: stationId }).eq("id", PRODUCT_1);
    if (productErr) throw new Error(`เปิด available_for_qr ชั่วคราว (local) ไม่สำเร็จ: ${productErr.message}`);
    // auto receipt ON (station tickets OFF — ชุดนี้ assert งานใบเสร็จอย่างเดียว)
    const { error: settingsErr } = await service.from("receipt_settings").update({ auto_print_receipt: true, auto_print_station_tickets: false }).eq("store_id", SEED_STORE_ID);
    if (settingsErr) throw new Error(`ตั้ง auto_print_receipt ชั่วคราว (local) ไม่สำเร็จ: ${settingsErr.message}`);
  });

  async function setStoreField(patch: Record<string, unknown>, label: string): Promise<void> {
    const { error } = await service.from("stores").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", SEED_STORE_ID);
    if (error) throw new Error(`ตั้งค่า ${label} (local) ไม่สำเร็จ: ${error.message}`);
  }

  test.afterAll(async () => {
    const failures: string[] = [];
    if (service) {
      if (createdOrderIds.length > 0) {
        await service.from("transactions").delete().in("order_id", createdOrderIds);
        await service.from("cash_ledger_entries").delete().in("order_id", createdOrderIds);
        const { error } = await service.from("orders").delete().in("id", createdOrderIds);
        if (error) failures.push(`orders: ${error.message}`);
      }
      for (const reference of settledReferences) {
        const opKey = reference.replace("unified_pos_settlement:", "");
        const { data: jobs } = await service
          .from("print_jobs")
          .select("id")
          .eq("store_id", SEED_STORE_ID)
          .like("source_key", `${reference}%`);
        for (const job of jobs ?? []) {
          const { error } = await service.from("print_jobs").delete().eq("id", (job as { id: string }).id);
          if (error) failures.push(`print_jobs: ${error.message}`);
        }
        // audit: settle (request_id = opkey) + reprint (request_id = คีย์ reprint ที่ต่อท้าย reference)
        const { error: auditSettleErr } = await service.from("audit_logs").delete().eq("store_id", SEED_STORE_ID).eq("request_id", opKey);
        if (auditSettleErr) failures.push(`audit(settle): ${auditSettleErr.message}`);
        const { error: auditReprintErr } = await service
          .from("audit_logs")
          .delete()
          .eq("store_id", SEED_STORE_ID)
          .like("request_id", `${reference}:receipt:reprint:%`);
        if (auditReprintErr) failures.push(`audit(reprint): ${auditReprintErr.message}`);
        const { error: receiptErr } = await service.from("unified_pos_operation_receipts").delete().eq("store_id", SEED_STORE_ID).eq("operation_key", opKey);
        if (receiptErr) failures.push(`receipts: ${receiptErr.message}`);
      }
      if (originalStoreQr) {
        const { error } = await service.from("stores").update(originalStoreQr).eq("id", SEED_STORE_ID);
        if (error) failures.push(`stores (qr/policy): ${error.message}`);
      }
      if (originalTableSession) {
        const { error } = await service.from("tables").update(originalTableSession).eq("id", TABLE_1);
        if (error) failures.push(`tables: ${error.message}`);
      }
      if (originalProductQr) {
        const { error } = await service.from("products").update(originalProductQr).eq("id", PRODUCT_1);
        if (error) failures.push(`products: ${error.message}`);
      }
      if (originalReceiptSettings) {
        const { error } = await service.from("receipt_settings").update(originalReceiptSettings).eq("store_id", SEED_STORE_ID);
        if (error) failures.push(`receipt_settings: ${error.message}`);
      }
      if (stationId) {
        const { error } = await service.from("kitchen_stations").delete().eq("id", stationId);
        if (error) failures.push(`kitchen_stations: ${error.message}`);
      }
      if (printerId) {
        const { error } = await service.from("printers").delete().eq("id", printerId);
        if (error) failures.push(`printers: ${error.message}`);
      }
      // หมายเหตุ: ไม่ force flag ที่นี่ — top-level afterAll เป็นคนคืน unified_pos_enabled
      // ตามค่าเดิมที่อ่านไว้ก่อนรันทั้งไฟล์ (fixture ระดับไฟล์)
    }
    if (failures.length > 0) {
      throw new Error(`คืนค่า fixture บิล U11 (local) ไม่ครบ: ${failures.join(" | ")}`);
    }
  });

  /** seed QR order 1 บิล (RPC v2 จริง) — orderNumber prefix U11B- */
  async function submitQrOrder(): Promise<string> {
    // isolation ระหว่างเทสใน describe: เก็บกวาดออเดอร์ของเทสก่อนหน้าก่อนเสมอ
    // (บิลโต๊ะ 1 ต้องมีบิลเดียวต่อเทส — ไม่งั้น partial จะ settle บิลค้างของเทสก่อนหน้า)
    if (createdOrderIds.length > 0) {
      const staleIds = [...createdOrderIds];
      createdOrderIds.length = 0;
      await service.from("transactions").delete().in("order_id", staleIds);
      await service.from("cash_ledger_entries").delete().in("order_id", staleIds);
      const { error: sweepErr } = await service.from("orders").delete().in("id", staleIds);
      if (sweepErr) throw new Error(`เก็บกวาดออเดอร์เทสก่อนหน้า (local) ไม่สำเร็จ: ${sweepErr.message}`);
    }
    const line = {
      product_id: PRODUCT_1,
      product_name: "กาแฟดำ",
      variant_id: VARIANT_1,
      variant_name: "เล็ก (S)",
      modifiers: [{ option: { id: "55555555-0000-0000-0000-000000000001", name: "ไม่หวาน", priceAdjustment: 0 } }],
      quantity: 1,
      unit_price: 45,
      total_price: 45,
      note: `U11B-bill-e2e-${runId}`,
    };
    const { data, error } = await service.rpc("create_qr_order_with_items_v2", {
      p_organization_id: orgId,
      p_store_id: SEED_STORE_ID,
      p_table_id: TABLE_1,
      p_order_number: `U11B-${runId}-${createdOrderIds.length + 1}`,
      p_operation_key: createOperationKey(),
      p_request_hash: computeRequestHash({ storeId: SEED_STORE_ID, tableId: TABLE_1, subtotal: 45, items: [line] }),
      p_subtotal: 45,
      p_items: [line],
    });
    if (error) throw new Error(`submit QR order (local) ไม่สำเร็จ: ${error.message}`);
    const outcome = data as { status: string; result?: { order_id: string } } | null;
    if (!outcome || outcome.status !== "executed" || !outcome.result?.order_id) {
      throw new Error(`submit QR order (local) คืนสถานะไม่คาดคิด: ${JSON.stringify(outcome)}`);
    }
    createdOrderIds.push(outcome.result.order_id);
    return outcome.result.order_id;
  }

  /** เปิดหน้าบิลของโต๊ะ 1 (เลือกโต๊ะจากแท็บโต๊ะ แล้วไปแท็บบิล) */
  async function openTableOneBill(page: Page): Promise<void> {
    await page.goto("/pos");
    await page.getByRole("tab", { name: "โต๊ะ" }).click();
    const tablesPanel = page.getByRole("tabpanel", { name: "โต๊ะ" });
    await expect(tablesPanel.getByText("โต๊ะ 1")).toBeVisible();
    await tablesPanel.getByRole("button", { name: "เลือกโต๊ะ" }).first().click();
    await page.getByRole("tab", { name: "บิล" }).click();
    await expect(page.getByRole("tabpanel", { name: "บิล" }).getByTestId("unified-bill-view")).toBeVisible();
  }

  /**
   * settle ผ่าน UI (qr_promptpay) — mode:
   *   - "partial"  = กดปุ่ม "ชำระบิลนี้" ของบิลแรก (replay ได้ deterministic: retry ใช้
   *                  key+hash เดิม เพราะ facade อ่าน order by ids โดยไม่กรองสถานะ)
   *   - "whole_table" = กด "ชำระทั้งโต๊ะ" (server derive ชุดบิลเอง)
   */
  async function settleViaUiOnce(page: Page, opts?: { dblclick?: boolean; mode?: "partial" | "whole_table" }): Promise<void> {
    const billPanel = page.getByRole("tabpanel", { name: "บิล" });
    await billPanel.getByRole("checkbox").check();
    const settleButton =
      opts?.mode === "whole_table"
        ? billPanel.getByTestId("settle-whole-table")
        : billPanel.getByTestId("settle-order").first();
    if (opts?.dblclick) {
      await settleButton.dblclick();
    } else {
      await settleButton.click();
    }
    await expect(billPanel.getByTestId("settle-result")).toBeVisible({ timeout: 20_000 });
  }

  test("bill: แท็บบิลแสดงบิลจาก server (รายการ non-voided + ยอดรวม) สำหรับโต๊ะที่เลือก", async ({ page }) => {
    await submitQrOrder();
    await loginOwner(page);
    await openTableOneBill(page);
    const billPanel = page.getByRole("tabpanel", { name: "บิล" });

    // ข้อมูลมาจาก server action (บิลของโต๊ะ 1) — รายการ + ยอดต่อบิล + ยอดรวมทั้งโต๊ะ
    await expect(billPanel.locator("[data-bill-order]")).toHaveCount(1);
    await expect(billPanel.getByText(/x1 กาแฟดำ \(เล็ก \(S\)\) · ไม่หวาน/)).toBeVisible();
    await expect(billPanel.getByText("ยอดชำระ: 45.00 บาท")).toBeVisible();
    await expect(billPanel.getByText("ยอดรวมทั้งโต๊ะ: 45.00 บาท")).toBeVisible();
    const billOrder = billPanel.locator("[data-bill-order]").first();
    await expect(billOrder).toHaveAttribute("data-bill-total", "45");
  });

  test("payment replay: ส่งคำขอชำระซ้ำ (key เดิม) → ผลเดิม + งานพิมพ์เดิม ไม่มีใบเสร็จซ้ำ และไม่ auto-print จาก browser", async ({ page }) => {
    const orderId = await submitQrOrder();
    const enqueueRequests: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/api/print/enqueue")) enqueueRequests.push(request.url());
    });
    await loginOwner(page);
    await openTableOneBill(page);
    // partial settle (ชำระบิลนี้) — dblclick = retry คำขอเดิม (key+hash เดิม) →
    // คำขอที่สอง replay ด้วยผลลัพธ์เดิม deterministic ไม่ว่าจะจบ timing แบบไหน
    await settleViaUiOnce(page, { dblclick: true, mode: "partial" });

    const billPanel = page.getByRole("tabpanel", { name: "บิล" });
    const result = billPanel.getByTestId("settle-result");
    // double-submit = retry ของคำขอเดิม → คำขอที่สองถูก replay (ผลสุดท้าย = replay)
    await expect(result).toHaveAttribute("data-replayed", "true", { timeout: 20_000 });
    const reference = await result.getAttribute("data-receipt-reference");
    expect(reference).toBeTruthy();
    settledReferences.push(reference!);

    // ผ่าน service client: จ่ายแค่ครั้งเดียว (1 payment) และงานพิมพ์ใบเสร็จ 1 งาน (replay ไม่สร้างซ้ำ)
    const { count: paymentCount } = await service.from("payments").select("id", { count: "exact", head: true }).eq("order_id", orderId);
    expect(paymentCount).toBe(1);
    const { data: jobs } = await service
      .from("print_jobs")
      .select("id, job_kind, status, source_key")
      .eq("store_id", SEED_STORE_ID)
      .like("source_key", `${reference!}%`);
    expect(jobs ?? []).toHaveLength(1);
    expect((jobs![0] as { job_kind: string }).job_kind).toBe("receipt");
    expect((jobs![0] as { status: string }).status).toBe("pending");
    expect((jobs![0] as { source_key: string }).source_key).toBe(`${reference!}:receipt`);

    // client ไม่เคย browser-auto-print (ไม่มีการเรียก /api/print/enqueue)
    expect(enqueueRequests).toHaveLength(0);
  });

  test("print: settle สร้างงานพิมพ์เดียว (assert ผ่าน service client) + พิมพ์ซ้ำแบบ explicit ทำงานครั้งเดียว + มี audit", async ({ page }) => {
    const orderId = await submitQrOrder();
    await loginOwner(page);
    await openTableOneBill(page);
    // partial settle ครั้งเดียว — ยอด 45 (บิลเดียวของโต๊ะ)
    await settleViaUiOnce(page, { mode: "partial" });

    const billPanel = page.getByRole("tabpanel", { name: "บิล" });
    const result = billPanel.getByTestId("settle-result");
    await expect(result).toHaveAttribute("data-replayed", "false");
    const reference = await result.getAttribute("data-receipt-reference");
    expect(reference).toBeTruthy();
    settledReferences.push(reference!);
    const receiptJobId = await result.getAttribute("data-receipt-job-id");
    expect(receiptJobId).toBeTruthy();

    // print intent สร้างงานพิมพ์เดียวพอดี (receipt 1 งาน — station tickets ปิดใน fixture)
    const { data: jobs } = await service
      .from("print_jobs")
      .select("id, job_kind, source_key")
      .eq("store_id", SEED_STORE_ID)
      .like("source_key", `${reference!}%`);
    expect(jobs ?? []).toHaveLength(1);
    expect((jobs![0] as { id: string }).id).toBe(receiptJobId);

    // reprint: กดครั้งเดียว → 1 งานใหม่ + audit 1 แถว
    await billPanel.getByTestId("reprint-receipt").click();
    await expect(billPanel.getByTestId("reprint-done")).toBeVisible();
    const { data: reprints } = await service
      .from("print_jobs")
      .select("id, source_key")
      .eq("store_id", SEED_STORE_ID)
      .like("source_key", `${reference!}:receipt:reprint:%`);
    expect(reprints ?? []).toHaveLength(1);
    expect((reprints![0] as { source_key: string }).source_key).toBe(`${reference!}:receipt:reprint:1`);

    const { data: audits } = await service
      .from("audit_logs")
      .select("action, request_id, after")
      .eq("store_id", SEED_STORE_ID)
      .eq("action", "unified_pos.reprint_receipt")
      .like("request_id", `${reference!}:receipt:reprint:%`);
    expect(audits ?? []).toHaveLength(1);
    const auditAfter = audits![0] as { after: { reprint_job_id?: string } | null };
    expect(auditAfter.after?.reprint_job_id ?? "").toBe((reprints![0] as { id: string }).id);

    // หลังชำระทั้งโต๊ะ: บิลหลุดจากมุมมอง (ไม่มีบิลค้าง) — ตรวจผ่าน service client ด้วย
    const { count: openCount } = await service
      .from("orders")
      .select("id", { count: "exact", head: true })
      .eq("store_id", SEED_STORE_ID)
      .eq("id", orderId)
      .eq("status", "open");
    expect(openCount).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// U12 — ลูกค้า QR: fulfillment timeline + cancel (v0.37.3)
//
// ชุด "customer QR" (flag on): seed ออเดอร์ผ่าน RPC v2 (fixture เดียวกับคิวครัว U10)
// แล้วเปิดหน้าลูกค้า /qr/{slug}/{tableId} ตรวจ timeline + ยกเลิก
//   - ยกเลิกก่อนครัวรับ → สำเร็จ (governed unified_pos_cancel_table_order)
//   - stale cancel (ครัวรับก่อนผ่าน service client แล้ว UI ยังแสดงปุ่ม) → ปฏิเสธ
//     และ UI ต้องแสดงสถานะปัจจุบัน (ข้อความ + การ์ด converge ทันที)
// ชุด "legacy order" (flag off): seed ผ่าน RPC v1 + ขยับ orders.prep_status ตรง
// (พฤติกรรมครัว legacy — items คง default 'new') → timeline ต้อง fallback ตาม
// prep_status และยกเลิกก่อนครัวรับผ่าน legacy RPC ได้
//
// หมายเหตุ: แถว legacy "แท้" (ไม่มีคอลัมน์ fulfillment_status) แทรกผ่าน schema
// ปัจจุบันไม่ได้ เพราะ U2 เพิ่มคอลัมน์แบบ NOT NULL DEFAULT 'new' — รูปแบบเดิมจึง
// จำลองด้วยค่า default + prep_status เดินหน้า (ตรงกับแถวจริงหลัง migration แล้ว)
// ส่วนเคส "ก่อนมีคอลัมน์" ครอบด้วย mapping unit test (qr-order-fulfillment.test.ts)
test.describe("customer QR U12 (ลูกค้า QR: timeline + cancel)", () => {
  const PRODUCT_1 = "22222222-0000-0000-0000-000000000001"; // กาแฟดำ (seed.sql)
  const VARIANT_1 = "33333333-0000-0000-0000-000000000001"; // เล็ก (S)
  const TABLE_1 = "eeeeeeee-0000-0000-0000-000000000001";
  let runId: string;
  const createdOrderIds: string[] = [];
  let storeSlug: string | null = null;
  let originalStoreQr: {
    qr_ordering_enabled: boolean;
    table_open_policy: "staff_only" | "customer_self";
  } | null = null;
  let originalTableSession: {
    qr_enabled: boolean;
    session_started_at: string | null;
    session_expires_at: string | null;
  } | null = null;
  let originalProductQr: { available_for_qr: boolean; kitchen_station_id: string | null } | null = null;
  let stationId: string | null = null;

  test.beforeAll(async () => {
    runId = randomUUID().slice(0, 8);
    await setUnifiedPosFlag(true);

    const storeRow = await service
      .from("stores")
      .select("slug, qr_ordering_enabled, table_open_policy")
      .eq("id", SEED_STORE_ID)
      .single();
    if (storeRow.error || !storeRow.data) {
      throw new Error(`อ่าน stores (local) ไม่สำเร็จ: ${storeRow.error?.message ?? "ไม่พบแถว"}`);
    }
    storeSlug = String(storeRow.data.slug);
    originalStoreQr = {
      qr_ordering_enabled: storeRow.data.qr_ordering_enabled,
      table_open_policy: storeRow.data.table_open_policy,
    };

    const tableRow = await service
      .from("tables")
      .select("qr_enabled, session_started_at, session_expires_at")
      .eq("id", TABLE_1)
      .single();
    if (tableRow.error || !tableRow.data) {
      throw new Error(`อ่าน tables (local) ไม่สำเร็จ: ${tableRow.error?.message ?? "ไม่พบแถว"}`);
    }
    originalTableSession = tableRow.data;

    const productRow = await service
      .from("products")
      .select("available_for_qr, kitchen_station_id")
      .eq("id", PRODUCT_1)
      .single();
    if (productRow.error || !productRow.data) {
      throw new Error(`อ่าน products (local) ไม่สำเร็จ: ${productRow.error?.message ?? "ไม่พบแถว"}`);
    }
    originalProductQr = {
      available_for_qr: productRow.data.available_for_qr,
      kitchen_station_id: productRow.data.kitchen_station_id,
    };

    // fixture เดียวกับคิวครัว U10: station ชั่วคราว + เปิด QR policy/session/product
    const insertedStation = await service
      .from("kitchen_stations")
      .insert({ organization_id: orgId, store_id: SEED_STORE_ID, name: `U12 Customer E2E ${runId}` })
      .select("id")
      .single();
    if (insertedStation.error || !insertedStation.data) {
      throw new Error(`สร้าง kitchen station ชั่วคราว (local) ไม่สำเร็จ: ${insertedStation.error?.message ?? "ไม่ได้แถวที่ insert"}`);
    }
    stationId = insertedStation.data.id;

    const { error: storeErr } = await service
      .from("stores")
      .update({ qr_ordering_enabled: true, table_open_policy: "customer_self" })
      .eq("id", SEED_STORE_ID);
    if (storeErr) throw new Error(`เปิด QR policy ชั่วคราว (local) ไม่สำเร็จ: ${storeErr.message}`);
    const { error: tableErr } = await service
      .from("tables")
      .update({
        qr_enabled: true,
        session_started_at: new Date().toISOString(),
        session_expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      })
      .eq("id", TABLE_1);
    if (tableErr) throw new Error(`เปิด session โต๊ะ 1 ชั่วคราว (local) ไม่สำเร็จ: ${tableErr.message}`);
    const { error: productErr } = await service
      .from("products")
      .update({ available_for_qr: true, kitchen_station_id: stationId })
      .eq("id", PRODUCT_1);
    if (productErr) throw new Error(`เปิด available_for_qr ชั่วคราว (local) ไม่สำเร็จ: ${productErr.message}`);
  });

  test.afterAll(async () => {
    const failures: string[] = [];
    if (service && createdOrderIds.length > 0) {
      const { error } = await service.from("orders").delete().in("id", createdOrderIds);
      if (error) failures.push(`orders: ${error.message}`);
    }
    if (service && originalStoreQr) {
      const { error } = await service.from("stores").update(originalStoreQr).eq("id", SEED_STORE_ID);
      if (error) failures.push(`stores (qr/policy): ${error.message}`);
    }
    if (service && originalTableSession) {
      const { error } = await service.from("tables").update(originalTableSession).eq("id", TABLE_1);
      if (error) failures.push(`tables: ${error.message}`);
    }
    if (service && originalProductQr) {
      const { error } = await service.from("products").update(originalProductQr).eq("id", PRODUCT_1);
      if (error) failures.push(`products: ${error.message}`);
    }
    if (service && stationId) {
      const { error } = await service.from("kitchen_stations").delete().eq("id", stationId);
      if (error) failures.push(`kitchen_stations: ${error.message}`);
    }
    if (failures.length > 0) {
      throw new Error(`คืนค่า fixture customer QR U12 (local) ไม่ครบ: ${failures.join(" | ")}`);
    }
  });

  /** seed ออเดอร์ QR ผ่าน RPC v2 (service client) — คืน order/item/orderNumber */
  async function submitQrOrder(): Promise<{ orderId: string; itemId: string; orderNumber: string }> {
    const line = {
      product_id: PRODUCT_1,
      product_name: "กาแฟดำ",
      variant_id: VARIANT_1,
      variant_name: "เล็ก (S)",
      modifiers: [{ option: { id: "55555555-0000-0000-0000-000000000001", name: "ไม่หวาน", priceAdjustment: 0 } }],
      quantity: 1,
      unit_price: 45,
      total_price: 45,
      note: `U12-customer-e2e-${runId}`,
    };
    const orderNumber = `U12A-${runId}-${createdOrderIds.length + 1}`;
    const { data, error } = await service.rpc("create_qr_order_with_items_v2", {
      p_organization_id: orgId,
      p_store_id: SEED_STORE_ID,
      p_table_id: TABLE_1,
      p_order_number: orderNumber,
      p_operation_key: createOperationKey(),
      p_request_hash: computeRequestHash({ storeId: SEED_STORE_ID, tableId: TABLE_1, subtotal: 45, items: [line] }),
      p_subtotal: 45,
      p_items: [line],
    });
    if (error) throw new Error(`submit QR order (local) ไม่สำเร็จ: ${error.message}`);
    const outcome = data as { status: string; result?: { order_id: string } } | null;
    if (!outcome || outcome.status !== "executed" || !outcome.result?.order_id) {
      throw new Error(`submit QR order (local) คืนสถานะไม่คาดคิด: ${JSON.stringify(outcome)}`);
    }
    const orderId = outcome.result.order_id;
    createdOrderIds.push(orderId);
    const itemRow = await service.from("order_items").select("id").eq("order_id", orderId).limit(1).single();
    if (itemRow.error || !itemRow.data) {
      throw new Error(`อ่าน order_items ของออเดอร์ seed (local) ไม่สำเร็จ: ${itemRow.error?.message ?? "ไม่พบแถว"}`);
    }
    return { orderId, itemId: (itemRow.data as { id: string }).id, orderNumber };
  }

  /** เครื่องครัว (service client) ขยับ item — ใช้จำลอง "ครัวรับก่อน" ที่ UI ยังไม่เห็น */
  async function advanceItemDirect(
    orderId: string,
    itemId: string,
    expectedVersion: number,
    target: string,
  ): Promise<void> {
    const { data, error } = await service.rpc("unified_pos_update_item_fulfillment", {
      p_organization_id: orgId,
      p_store_id: SEED_STORE_ID,
      p_order_id: orderId,
      p_item_id: itemId,
      p_expected_fulfillment_version: expectedVersion,
      p_target_fulfillment_status: target,
      p_operation_key: createOperationKey(),
      p_request_hash: computeRequestHash({
        storeId: SEED_STORE_ID,
        orderId,
        itemId,
        target,
        expectedVersion,
      }),
      p_actor_user_id: OWNER_AUTH_USER_ID,
    });
    if (error) throw new Error(`advance item ผ่าน service client (local) ไม่สำเร็จ: ${error.message}`);
    const outcome = data as { status: string } | null;
    if (!outcome || (outcome.status !== "executed" && outcome.status !== "replayed")) {
      throw new Error(`advance item (local) คืนสถานะไม่คาดคิด: ${JSON.stringify(outcome)}`);
    }
  }

  async function openCustomerTrack(page: Page): Promise<void> {
    await page.goto(`/qr/${storeSlug}/${TABLE_1}`);
    await page.getByRole("button", { name: "ออร์เดอร์โต๊ะนี้" }).click();
  }

  async function assertOrderStatus(orderId: string, expected: string): Promise<void> {
    const row = await service.from("orders").select("status").eq("id", orderId).single();
    if (row.error || !row.data) {
      throw new Error(`อ่านสถานะออเดอร์ (local) ไม่สำเร็จ: ${row.error?.message ?? "ไม่พบแถว"}`);
    }
    expect((row.data as { status: string }).status).toBe(expected);
  }

  test("customer QR: หน้าติดตามแสดงสถานะ timeline และยกเลิกได้ก่อนครัวรับ", async ({ page }) => {
    const seeded = await submitQrOrder();
    await openCustomerTrack(page);

    const card = page.locator(`[data-qr-order-card="${seeded.orderId}"]`);
    await expect(card).toBeVisible();
    await expect(card.getByText("ได้รับออเดอร์แล้ว")).toBeVisible();
    await expect(card.getByText(`#${seeded.orderNumber}`)).toBeVisible();
    await expect(card.getByText(/กาแฟดำ/)).toBeVisible();

    // ยกเลิกก่อนครัวรับ → governed cancel สำเร็จ (มี confirm dialog กันกดพลาด)
    await card.getByRole("button", { name: "ยกเลิกออเดอร์" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "ยกเลิกออเดอร์" }).click();
    await expect(page.getByText("ยกเลิกออเดอร์แล้ว")).toBeVisible();

    // ออเดอร์ถูกยกเลิกจริงใน DB + หลุดจากลิสต์ออเดอร์เปิดของโต๊ะ
    await assertOrderStatus(seeded.orderId, "cancelled");
    await expect(card).toHaveCount(0);
  });

  test("cancel: ครัวรับออเดอร์ก่อน (stale) → ปฏิเสธและแสดงสถานะปัจจุบัน", async ({ page }) => {
    const seeded = await submitQrOrder();
    await openCustomerTrack(page);

    const card = page.locator(`[data-qr-order-card="${seeded.orderId}"]`);
    await expect(card).toBeVisible();
    await expect(card.getByText("ได้รับออเดอร์แล้ว")).toBeVisible();
    await expect(card.getByRole("button", { name: "ยกเลิกออเดอร์" })).toBeVisible();

    // ครัวรับรายการ (service client) ขณะ UI ของลูกค้ายังแสดง snapshot เดิม
    await advanceItemDirect(seeded.orderId, seeded.itemId, 1, "preparing");

    // ลูกค้ากดยกเลิกจาก snapshot stale → server ปฏิเสธ + คืนสถานะปัจจุบัน
    await card.getByRole("button", { name: "ยกเลิกออเดอร์" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "ยกเลิกออเดอร์" }).click();

    // ข้อความไทยที่ระบุสถานะปัจจุบัน (ไม่ใช่ error ทั่วไป)
    await expect(page.getByText(/ครัวรับออเดอร์แล้ว ยกเลิกไม่ได้ \(สถานะปัจจุบัน: กำลังเตรียม\)/)).toBeVisible();
    // การ์ด converge กับ server ทันที (stage จาก currentOrder ที่ action คืน)
    await expect(card.getByText("กำลังเตรียม")).toBeVisible();
    await expect(card.getByRole("button", { name: "ยกเลิกออเดอร์" })).toHaveCount(0);

    // ออเดอร์ยังเปิดอยู่ (ไม่ถูกยกเลิก)
    await assertOrderStatus(seeded.orderId, "open");
  });
});

test.describe("legacy order U12 (ออเดอร์รูปแบบเดิม flag ปิด)", () => {
  const PRODUCT_1 = "22222222-0000-0000-0000-000000000001"; // กาแฟดำ (seed.sql)
  const VARIANT_1 = "33333333-0000-0000-0000-000000000001"; // เล็ก (S)
  const TABLE_1 = "eeeeeeee-0000-0000-0000-000000000001";
  let runId: string;
  const createdOrderIds: string[] = [];
  let storeSlug: string | null = null;
  let originalStoreQr: {
    qr_ordering_enabled: boolean;
    table_open_policy: "staff_only" | "customer_self";
  } | null = null;
  let originalTableSession: {
    qr_enabled: boolean;
    session_started_at: string | null;
    session_expires_at: string | null;
  } | null = null;
  let originalProductQr: { available_for_qr: boolean; kitchen_station_id: string | null } | null = null;
  let stationId: string | null = null;

  test.beforeAll(async () => {
    runId = randomUUID().slice(0, 8);
    await setUnifiedPosFlag(false); // legacy path จนกว่า final cutover

    const storeRow = await service
      .from("stores")
      .select("slug, qr_ordering_enabled, table_open_policy")
      .eq("id", SEED_STORE_ID)
      .single();
    if (storeRow.error || !storeRow.data) {
      throw new Error(`อ่าน stores (local) ไม่สำเร็จ: ${storeRow.error?.message ?? "ไม่พบแถว"}`);
    }
    storeSlug = String(storeRow.data.slug);
    originalStoreQr = {
      qr_ordering_enabled: storeRow.data.qr_ordering_enabled,
      table_open_policy: storeRow.data.table_open_policy,
    };

    const tableRow = await service
      .from("tables")
      .select("qr_enabled, session_started_at, session_expires_at")
      .eq("id", TABLE_1)
      .single();
    if (tableRow.error || !tableRow.data) {
      throw new Error(`อ่าน tables (local) ไม่สำเร็จ: ${tableRow.error?.message ?? "ไม่พบแถว"}`);
    }
    originalTableSession = tableRow.data;

    const productRow = await service
      .from("products")
      .select("available_for_qr, kitchen_station_id")
      .eq("id", PRODUCT_1)
      .single();
    if (productRow.error || !productRow.data) {
      throw new Error(`อ่าน products (local) ไม่สำเร็จ: ${productRow.error?.message ?? "ไม่พบแถว"}`);
    }
    originalProductQr = {
      available_for_qr: productRow.data.available_for_qr,
      kitchen_station_id: productRow.data.kitchen_station_id,
    };

    const insertedStation = await service
      .from("kitchen_stations")
      .insert({ organization_id: orgId, store_id: SEED_STORE_ID, name: `U12 Legacy E2E ${runId}` })
      .select("id")
      .single();
    if (insertedStation.error || !insertedStation.data) {
      throw new Error(`สร้าง kitchen station ชั่วคราว (local) ไม่สำเร็จ: ${insertedStation.error?.message ?? "ไม่ได้แถวที่ insert"}`);
    }
    stationId = insertedStation.data.id;

    const { error: storeErr } = await service
      .from("stores")
      .update({ qr_ordering_enabled: true, table_open_policy: "customer_self" })
      .eq("id", SEED_STORE_ID);
    if (storeErr) throw new Error(`เปิด QR policy ชั่วคราว (local) ไม่สำเร็จ: ${storeErr.message}`);
    const { error: tableErr } = await service
      .from("tables")
      .update({
        qr_enabled: true,
        session_started_at: new Date().toISOString(),
        session_expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      })
      .eq("id", TABLE_1);
    if (tableErr) throw new Error(`เปิด session โต๊ะ 1 ชั่วคราว (local) ไม่สำเร็จ: ${tableErr.message}`);
    const { error: productErr } = await service
      .from("products")
      .update({ available_for_qr: true, kitchen_station_id: stationId })
      .eq("id", PRODUCT_1);
    if (productErr) throw new Error(`เปิด available_for_qr ชั่วคราว (local) ไม่สำเร็จ: ${productErr.message}`);
  });

  test.afterAll(async () => {
    // flag ไม่ force ที่นี่ — top-level afterAll เป็นคนคืน unified_pos_enabled
    const failures: string[] = [];
    if (service && createdOrderIds.length > 0) {
      const { error } = await service.from("orders").delete().in("id", createdOrderIds);
      if (error) failures.push(`orders: ${error.message}`);
    }
    if (service && originalStoreQr) {
      const { error } = await service.from("stores").update(originalStoreQr).eq("id", SEED_STORE_ID);
      if (error) failures.push(`stores (qr/policy): ${error.message}`);
    }
    if (service && originalTableSession) {
      const { error } = await service.from("tables").update(originalTableSession).eq("id", TABLE_1);
      if (error) failures.push(`tables: ${error.message}`);
    }
    if (service && originalProductQr) {
      const { error } = await service.from("products").update(originalProductQr).eq("id", PRODUCT_1);
      if (error) failures.push(`products: ${error.message}`);
    }
    if (service && stationId) {
      const { error } = await service.from("kitchen_stations").delete().eq("id", stationId);
      if (error) failures.push(`kitchen_stations: ${error.message}`);
    }
    if (failures.length > 0) {
      throw new Error(`คืนค่า fixture legacy order U12 (local) ไม่ครบ: ${failures.join(" | ")}`);
    }
  });

  /** seed ออเดอร์แบบ legacy ผ่าน RPC v1 (พฤติกรรมก่อน U4 — ไม่มี envelope) */
  async function submitLegacyOrder(): Promise<{ orderId: string; orderNumber: string }> {
    const line = {
      product_id: PRODUCT_1,
      product_name: "กาแฟดำ",
      variant_id: VARIANT_1,
      variant_name: "เล็ก (S)",
      modifiers: [{ option: { id: "55555555-0000-0000-0000-000000000001", name: "ไม่หวาน", priceAdjustment: 0 } }],
      quantity: 1,
      unit_price: 45,
      total_price: 45,
      note: `U12-legacy-e2e-${runId}`,
    };
    const orderNumber = `U12L-${runId}-${createdOrderIds.length + 1}`;
    const { data, error } = await service.rpc("create_qr_order_with_items", {
      p_organization_id: orgId,
      p_store_id: SEED_STORE_ID,
      p_table_id: TABLE_1,
      p_order_number: orderNumber,
      p_subtotal: 45,
      p_items: [line],
    });
    if (error) throw new Error(`submit legacy QR order (local) ไม่สำเร็จ: ${error.message}`);
    const orderId = data as string | null;
    if (!orderId) throw new Error("submit legacy QR order (local) ไม่ได้ order id กลับมา");
    createdOrderIds.push(orderId);
    return { orderId, orderNumber };
  }

  async function openCustomerTrack(page: Page): Promise<void> {
    await page.goto(`/qr/${storeSlug}/${TABLE_1}`);
    await page.getByRole("button", { name: "ออร์เดอร์โต๊ะนี้" }).click();
  }

  async function assertOrderStatus(orderId: string, expected: string): Promise<void> {
    const row = await service.from("orders").select("status").eq("id", orderId).single();
    if (row.error || !row.data) {
      throw new Error(`อ่านสถานะออเดอร์ (local) ไม่สำเร็จ: ${row.error?.message ?? "ไม่พบแถว"}`);
    }
    expect((row.data as { status: string }).status).toBe(expected);
  }

  test("legacy order: เรนเดอร์ timeline จาก prep_status รูปแบบเดิมได้ไม่พัง (ครัวรับแล้วจึงไม่มีปุ่มยกเลิก)", async ({ page }) => {
    const seeded = await submitLegacyOrder();
    // ครัว legacy เดินหน้า orders.prep_status ตรง (items คง default 'new' — รูปแบบเดิม)
    const { error } = await service
      .from("orders")
      .update({ prep_status: "preparing" })
      .eq("id", seeded.orderId);
    if (error) throw new Error(`ตั้ง prep_status รูปแบบเดิม (local) ไม่สำเร็จ: ${error.message}`);

    await openCustomerTrack(page);

    const card = page.locator(`[data-qr-order-card="${seeded.orderId}"]`);
    await expect(card).toBeVisible();
    // timeline ต้อง fallback ตาม prep_status (items ไม่มีการเดินหน้าของตัวเอง)
    await expect(card.getByText("กำลังเตรียม")).toBeVisible();
    await expect(card.getByText(`#${seeded.orderNumber}`)).toBeVisible();
    await expect(card.getByText(/กาแฟดำ/)).toBeVisible();
    // ครัวรับแล้ว → ไม่มีปุ่มยกเลิก (server ตัดสิน canCancel)
    await expect(card.getByRole("button", { name: "ยกเลิกออเดอร์" })).toHaveCount(0);
    await assertOrderStatus(seeded.orderId, "open");
  });

  test("legacy order: ยกเลิกก่อนครัวรับผ่าน legacy cancel path", async ({ page }) => {
    const seeded = await submitLegacyOrder();
    await openCustomerTrack(page);

    const card = page.locator(`[data-qr-order-card="${seeded.orderId}"]`);
    await expect(card).toBeVisible();
    await expect(card.getByText("ได้รับออเดอร์แล้ว")).toBeVisible();
    await expect(card.getByRole("button", { name: "ยกเลิกออเดอร์" })).toBeVisible();

    await card.getByRole("button", { name: "ยกเลิกออเดอร์" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "ยกเลิกออเดอร์" }).click();
    await expect(page.getByText("ยกเลิกออเดอร์แล้ว")).toBeVisible();

    await assertOrderStatus(seeded.orderId, "cancelled");
    await expect(card).toHaveCount(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// U14 — Voice Tier A navigation: สั่งงานด้วยเสียงเปิดแท็บของ POS รวม
//
// เบราว์เซอร์ทดสอบไม่มีบริการรู้จำเสียงจริง จึงฉีด SpeechRecognition ปลอมผ่าน
// addInitScript (adapter ของแอปอ่าน window.SpeechRecognition ตอน runtime อยู่แล้ว
// — ไม่มี backdoor ใน production code) แล้วกำหนดข้อความที่ "ได้ยิน" ต่อเคส
// fixture: เปิด stores.voice_command_enabled ชั่วคราวและคืนค่าเดิมเสมอ (fail-loud)
test.describe("voice navigation U14 (สั่งงานด้วยเสียง Tier A)", () => {
  let originalVoiceFlag: boolean | null = null;

  test.beforeAll(async () => {
    const { data, error } = await service
      .from("stores")
      .select("voice_command_enabled")
      .eq("id", SEED_STORE_ID)
      .single();
    if (error || !data) {
      throw new Error(`อ่าน stores.voice_command_enabled (local) ไม่สำเร็จ: ${error?.message ?? "ไม่พบแถว"}`);
    }
    originalVoiceFlag = data.voice_command_enabled;
    await setUnifiedPosFlag(true);
    const { error: updateError } = await service
      .from("stores")
      .update({ voice_command_enabled: true, updated_at: new Date().toISOString() })
      .eq("id", SEED_STORE_ID);
    if (updateError) {
      throw new Error(`ตั้ง stores.voice_command_enabled = true (local) ไม่สำเร็จ: ${updateError.message}`);
    }
  });

  test.afterAll(async () => {
    if (originalVoiceFlag === null) return;
    const { error } = await service
      .from("stores")
      .update({ voice_command_enabled: originalVoiceFlag, updated_at: new Date().toISOString() })
      .eq("id", SEED_STORE_ID);
    if (error) throw new Error(`คืน stores.voice_command_enabled เดิม (local) ไม่สำเร็จ: ${error.message}`);
  });

  /** ฉีด engine ปลอม: start() → ส่ง final transcript ตามค่าที่เทสต์ตั้งไว้ */
  async function installFakeSpeechEngine(page: Page): Promise<void> {
    await page.addInitScript(() => {
      class FakeSpeechRecognition {
        lang = "";
        continuous = true;
        interimResults = false;
        maxAlternatives = 0;
        onstart: ((event: unknown) => void) | null = null;
        onresult: ((event: unknown) => void) | null = null;
        onerror: ((event: unknown) => void) | null = null;
        onend: ((event: unknown) => void) | null = null;

        start(): void {
          this.onstart?.({});
          const transcript = (window as unknown as { __voiceTranscript?: string }).__voiceTranscript ?? "";
          setTimeout(() => {
            this.onresult?.({
              resultIndex: 0,
              results: { length: 1, 0: { isFinal: true, length: 1, 0: { transcript, confidence: 0.95 } } },
            });
            this.onend?.({});
          }, 10);
        }

        stop(): void {}
        abort(): void {}
      }
      (window as unknown as { SpeechRecognition: unknown }).SpeechRecognition = FakeSpeechRecognition;
    });
  }

  async function speak(page: Page, phrase: string): Promise<void> {
    await page.evaluate((text) => {
      (window as unknown as { __voiceTranscript?: string }).__voiceTranscript = text;
    }, phrase);
    await page.getByRole("button", { name: "สั่งงานด้วยเสียง" }).click();
  }

  test("voice navigation: พูด 'เปิดครัว' แล้วแท็บครัวถูกเลือก และประกาศสถานะโดยไม่อ่านคำพูดผู้ใช้", async ({ page }) => {
    await installFakeSpeechEngine(page);
    await loginOwner(page);
    await page.goto("/pos");

    const voiceButton = page.getByRole("button", { name: "สั่งงานด้วยเสียง" });
    await expect(voiceButton).toBeVisible();
    await expect(page.getByRole("tab", { name: "ขาย" })).toHaveAttribute("aria-selected", "true");

    await speak(page, "เปิดครัว");

    await expect(page.getByRole("tab", { name: "ครัว" })).toHaveAttribute("aria-selected", "true");
    const status = page.getByRole("status").filter({ hasText: "แท็บครัว" });
    await expect(status).toHaveText("เปิดแท็บครัวแล้ว");
    // ประกาศต้องไม่มีคำพูดของผู้ใช้อยู่ในนั้น
    await expect(status).not.toHaveText(/เปิดครัว$/);

    // และสั่งกลับไปแท็บบิลได้
    await speak(page, "ไปที่แท็บบิล");
    await expect(page.getByRole("tab", { name: "บิล" })).toHaveAttribute("aria-selected", "true");
  });

  test("voice navigation: คำสั่งต้องห้ามและคำที่ไม่รู้จัก ต้องไม่เปลี่ยนหน้าจอ", async ({ page }) => {
    await installFakeSpeechEngine(page);
    await loginOwner(page);
    await page.goto("/pos");

    await speak(page, "เปิดครัว");
    await expect(page.getByRole("tab", { name: "ครัว" })).toHaveAttribute("aria-selected", "true");

    await speak(page, "ชำระเงิน");
    await expect(page.getByRole("status").filter({ hasText: "ต้องทำบนหน้าจอ" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "ครัว" })).toHaveAttribute("aria-selected", "true");
    await expect(page).toHaveURL(/\/pos$/);

    await speak(page, "เปิดยานอวกาศ");
    await expect(page.getByRole("status").filter({ hasText: "ยังไม่รองรับคำสั่งนี้" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "ครัว" })).toHaveAttribute("aria-selected", "true");
    await expect(page).toHaveURL(/\/pos$/);
  });

  test("voice navigation: flag เสียงปิด = ไม่มีปุ่มเสียงบนหน้าจอ", async ({ page }) => {
    const { error } = await service
      .from("stores")
      .update({ voice_command_enabled: false, updated_at: new Date().toISOString() })
      .eq("id", SEED_STORE_ID);
    if (error) throw new Error(`ปิด stores.voice_command_enabled ชั่วคราวไม่สำเร็จ: ${error.message}`);
    try {
      await installFakeSpeechEngine(page);
      await loginOwner(page);
      await page.goto("/pos");

      await expect(page.getByRole("tablist", { name: "ส่วนของ POS รวม" })).toBeVisible();
      await expect(page.getByRole("button", { name: "สั่งงานด้วยเสียง" })).toHaveCount(0);
    } finally {
      const { error: restoreError } = await service
        .from("stores")
        .update({ voice_command_enabled: true, updated_at: new Date().toISOString() })
        .eq("id", SEED_STORE_ID);
      if (restoreError) throw new Error(`เปิด flag เสียงคืนไม่สำเร็จ: ${restoreError.message}`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// U15 — Voice Tier B: แก้ตะกร้าด้วยเสียง + Undo 6 วินาที + คำสั่งการเงินยังต้องห้าม
// ใช้ engine ปลอมชุดเดียวกับ U14 (ฉีดผ่าน addInitScript — ไม่มี backdoor ใน production)
test.describe("voice cart U15 (ตะกร้าด้วยเสียง + undo + blocked payment)", () => {
  let originalVoiceFlag: boolean | null = null;

  test.beforeAll(async () => {
    const { data, error } = await service
      .from("stores")
      .select("voice_command_enabled")
      .eq("id", SEED_STORE_ID)
      .single();
    if (error || !data) {
      throw new Error(`อ่าน stores.voice_command_enabled (local) ไม่สำเร็จ: ${error?.message ?? "ไม่พบแถว"}`);
    }
    originalVoiceFlag = data.voice_command_enabled;
    await setUnifiedPosFlag(true);
    const { error: updateError } = await service
      .from("stores")
      .update({ voice_command_enabled: true, updated_at: new Date().toISOString() })
      .eq("id", SEED_STORE_ID);
    if (updateError) {
      throw new Error(`ตั้ง stores.voice_command_enabled = true (local) ไม่สำเร็จ: ${updateError.message}`);
    }
  });

  test.afterAll(async () => {
    if (originalVoiceFlag === null) return;
    const { error } = await service
      .from("stores")
      .update({ voice_command_enabled: originalVoiceFlag, updated_at: new Date().toISOString() })
      .eq("id", SEED_STORE_ID);
    if (error) throw new Error(`คืน stores.voice_command_enabled เดิม (local) ไม่สำเร็จ: ${error.message}`);
  });

  async function installFakeSpeechEngine(page: Page): Promise<void> {
    await page.addInitScript(() => {
      class FakeSpeechRecognition {
        lang = "";
        continuous = true;
        interimResults = false;
        maxAlternatives = 0;
        onstart: ((event: unknown) => void) | null = null;
        onresult: ((event: unknown) => void) | null = null;
        onerror: ((event: unknown) => void) | null = null;
        onend: ((event: unknown) => void) | null = null;

        start(): void {
          this.onstart?.({});
          const transcript = (window as unknown as { __voiceTranscript?: string }).__voiceTranscript ?? "";
          setTimeout(() => {
            this.onresult?.({
              resultIndex: 0,
              results: { length: 1, 0: { isFinal: true, length: 1, 0: { transcript, confidence: 0.95 } } },
            });
            this.onend?.({});
          }, 10);
        }

        stop(): void {}
        abort(): void {}
      }
      (window as unknown as { SpeechRecognition: unknown }).SpeechRecognition = FakeSpeechRecognition;
    });
  }

  async function speak(page: Page, phrase: string): Promise<void> {
    await page.evaluate((text) => {
      (window as unknown as { __voiceTranscript?: string }).__voiceTranscript = text;
    }, phrase);
    await page.getByRole("button", { name: "สั่งงานด้วยเสียง" }).click();
  }

  /** หน้าขายเรนเดอร์ตะกร้าไว้ 2 ชุด (มือถือ/เดสก์ท็อป) — assert เฉพาะชุดที่มองเห็นจริง */
  function visibleInSell(page: Page, text: string) {
    return page.getByRole("tabpanel", { name: "ขาย" }).getByText(text).filter({ visible: true });
  }

  test("voice cart: พูดเพิ่มสินค้า → ตะกร้าเปลี่ยนจริง และมีปุ่มย้อนกลับ 6 วินาที", async ({ page }) => {
    await installFakeSpeechEngine(page);
    await loginOwner(page);
    await page.goto("/pos");

    const emptyCart = visibleInSell(page, "ยังไม่มีรายการ");
    await expect(emptyCart).toBeVisible();

    await speak(page, "เพิ่มผัดกะเพราหมูสับ 2");

    await expect(visibleInSell(page, "ผัดกะเพราหมูสับ").first()).toBeVisible();
    await expect(page.getByRole("button", { name: /ย้อนกลับ/ })).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: "ย้อนกลับได้ใน 6 วินาที" })).toBeVisible();
  });

  test("undo: กดย้อนกลับแล้วตะกร้ากลับเป็นใบเดิม", async ({ page }) => {
    await installFakeSpeechEngine(page);
    await loginOwner(page);
    await page.goto("/pos");

    await speak(page, "เพิ่มวาฟเฟิลราดน้ำผึ้ง");
    await expect(visibleInSell(page, "วาฟเฟิลราดน้ำผึ้ง").first()).toBeVisible();

    await page.getByRole("button", { name: /ย้อนกลับ/ }).click();

    await expect(visibleInSell(page, "ยังไม่มีรายการ")).toBeVisible();
    await expect(page.getByRole("button", { name: /ย้อนกลับ/ })).toHaveCount(0);
  });

  test("blocked payment: คำสั่งการเงินและสินค้าที่ต้องเลือกตัวเลือก ต้องไม่แตะตะกร้า", async ({ page }) => {
    await installFakeSpeechEngine(page);
    await loginOwner(page);
    await page.goto("/pos");

    for (const phrase of ["ชำระเงิน", "เช็คบิล", "ล้างตะกร้า"]) {
      await speak(page, phrase);
      await expect(page.getByRole("status").filter({ hasText: "ต้องทำบนหน้าจอ" })).toBeVisible();
      await expect(visibleInSell(page, "ยังไม่มีรายการ")).toBeVisible();
      await expect(page.getByRole("button", { name: /ย้อนกลับ/ })).toHaveCount(0);
    }

    // กาแฟดำมีตัวเลือกขนาด (เล็ก/ใหญ่) ที่ไม่ได้ตั้งค่าเริ่มต้นไว้ → ต้องเด้งให้เลือกก่อน
    // (ต่างจากตัวเลือกบังคับที่ "มีค่าเริ่มต้น" ซึ่งระบบเพิ่มให้เลยตามที่หน้าร้านกำหนด)
    await speak(page, "เพิ่มกาแฟดำ");
    await expect(page.getByRole("status").filter({ hasText: "ต้องเลือก" })).toBeVisible();
    await expect(visibleInSell(page, "ยังไม่มีรายการ")).toBeVisible();
    await expect(page).toHaveURL(/\/pos$/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// U16 — Voice privacy / unsupported browser / microphone permission
// ทั้งสามเคสต้อง "ไม่พัง และกลับไปทำงานบนหน้าจอได้เสมอ"
test.describe("voice privacy U16 (privacy / unsupported / permission)", () => {
  let originalVoiceFlag: boolean | null = null;

  test.beforeAll(async () => {
    const { data, error } = await service
      .from("stores")
      .select("voice_command_enabled")
      .eq("id", SEED_STORE_ID)
      .single();
    if (error || !data) {
      throw new Error(`อ่าน stores.voice_command_enabled (local) ไม่สำเร็จ: ${error?.message ?? "ไม่พบแถว"}`);
    }
    originalVoiceFlag = data.voice_command_enabled;
    await setUnifiedPosFlag(true);
    const { error: updateError } = await service
      .from("stores")
      .update({ voice_command_enabled: true, updated_at: new Date().toISOString() })
      .eq("id", SEED_STORE_ID);
    if (updateError) {
      throw new Error(`ตั้ง stores.voice_command_enabled = true (local) ไม่สำเร็จ: ${updateError.message}`);
    }
  });

  test.afterAll(async () => {
    if (originalVoiceFlag === null) return;
    const { error } = await service
      .from("stores")
      .update({ voice_command_enabled: originalVoiceFlag, updated_at: new Date().toISOString() })
      .eq("id", SEED_STORE_ID);
    if (error) throw new Error(`คืน stores.voice_command_enabled เดิม (local) ไม่สำเร็จ: ${error.message}`);
  });

  test("voice privacy: หน้าจอแจ้งเรื่องความเป็นส่วนตัว และไม่มีคำพูดถูกเก็บไว้ที่เครื่อง", async ({ page }) => {
    // engine ปลอมที่ส่ง final ทันที — ใช้ตรวจว่าไม่มีอะไรถูกเขียนลง storage
    await page.addInitScript(() => {
      class FakeSpeechRecognition {
        lang = "";
        continuous = true;
        interimResults = false;
        maxAlternatives = 0;
        onstart: ((event: unknown) => void) | null = null;
        onresult: ((event: unknown) => void) | null = null;
        onerror: ((event: unknown) => void) | null = null;
        onend: ((event: unknown) => void) | null = null;
        start(): void {
          this.onstart?.({});
          setTimeout(() => {
            this.onresult?.({
              resultIndex: 0,
              results: {
                length: 1,
                0: { isFinal: true, length: 1, 0: { transcript: "เปิดครัว", confidence: 0.95 } },
              },
            });
            this.onend?.({});
          }, 10);
        }
        stop(): void {}
        abort(): void {}
      }
      (window as unknown as { SpeechRecognition: unknown }).SpeechRecognition = FakeSpeechRecognition;
    });
    await loginOwner(page);
    await page.goto("/pos");

    await expect(page.getByText(/ระบบไม่บันทึกเสียงหรือข้อความที่พูด/)).toBeVisible();

    await page.getByRole("button", { name: "สั่งงานด้วยเสียง" }).click();
    await expect(page.getByRole("tab", { name: "ครัว" })).toHaveAttribute("aria-selected", "true");

    // ไม่มีคำพูดค้างใน localStorage/sessionStorage ของหน้านี้
    const stored = await page.evaluate(() => {
      const dump: string[] = [];
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i);
        if (key) dump.push(`${key}=${localStorage.getItem(key) ?? ""}`);
      }
      for (let i = 0; i < sessionStorage.length; i += 1) {
        const key = sessionStorage.key(i);
        if (key) dump.push(`${key}=${sessionStorage.getItem(key) ?? ""}`);
      }
      return dump.join("\n");
    });
    expect(stored).not.toContain("เปิดครัว");
  });

  test("unsupported: เบราว์เซอร์ไม่มี SpeechRecognition → ปุ่มถูกปิดพร้อมเหตุผล ไม่พัง", async ({ page }) => {
    await page.addInitScript(() => {
      const win = window as unknown as Record<string, unknown>;
      delete win.SpeechRecognition;
      delete win.webkitSpeechRecognition;
    });
    await loginOwner(page);
    await page.goto("/pos");

    const button = page.getByRole("button", { name: "สั่งงานด้วยเสียง" });
    await expect(button).toBeVisible();
    await expect(button).toBeDisabled();
    await expect(page.getByText(/เบราว์เซอร์นี้ยังสั่งงานด้วยเสียงไม่ได้/)).toBeVisible();

    // หน้าจอยังใช้งานได้ตามปกติ
    await page.getByRole("tab", { name: "ครัว" }).click();
    await expect(page.getByRole("tab", { name: "ครัว" })).toHaveAttribute("aria-selected", "true");
  });

  test("permission: ผู้ใช้ไม่อนุญาตไมโครโฟน → ข้อความกู้คืนได้ และกดใหม่ได้", async ({ page }) => {
    await page.addInitScript(() => {
      class DeniedRecognition {
        lang = "";
        continuous = true;
        interimResults = false;
        maxAlternatives = 0;
        onstart: ((event: unknown) => void) | null = null;
        onresult: ((event: unknown) => void) | null = null;
        onerror: ((event: { error?: string }) => void) | null = null;
        onend: ((event: unknown) => void) | null = null;
        start(): void {
          this.onstart?.({});
          setTimeout(() => {
            this.onerror?.({ error: "not-allowed" });
            this.onend?.({});
          }, 10);
        }
        stop(): void {}
        abort(): void {}
      }
      (window as unknown as { SpeechRecognition: unknown }).SpeechRecognition = DeniedRecognition;
    });
    await loginOwner(page);
    await page.goto("/pos");

    const button = page.getByRole("button", { name: "สั่งงานด้วยเสียง" });
    await button.click();

    await expect(page.getByRole("status").filter({ hasText: "ยังไม่ได้อนุญาตให้ใช้ไมโครโฟน" })).toBeVisible();
    await expect(button).toBeEnabled();

    // กดซ้ำได้ ไม่ค้างอยู่ในสถานะกำลังฟัง
    await button.click();
    await expect(page.getByRole("status").filter({ hasText: "ยังไม่ได้อนุญาตให้ใช้ไมโครโฟน" })).toBeVisible();
    await expect(button).toHaveAttribute("aria-pressed", "false");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// U17 — R2 integrated E2E: เดินครบสายในรอบเดียว + a11y/console/flag matrix
//
// สายที่ตรวจ: ลูกค้า QR ส่งออเดอร์ (RPC v2 ตัวเดียวกับที่แอปลูกค้าเรียก) → คิวครัวรับ/พร้อมเสิร์ฟ
//            → แท็บบิลเห็นบิล → ชำระผ่าน UI → งานพิมพ์ใบเสร็จ "ใบเดียว"
// fixture: ชุดเดียวกับ U11 (QR policy / session โต๊ะ 1 / station / printer / auto print) และ
//          เปิด flag เสียงด้วย เพื่อตรวจว่าเสียงอยู่ร่วมกับสายงานหลักได้โดยไม่รบกวนกัน
test.describe("integrated R2 U17 (ครบสาย + a11y + flag matrix)", () => {
  const PRODUCT_1 = "22222222-0000-0000-0000-000000000001"; // กาแฟดำ (seed.sql)
  const VARIANT_1 = "33333333-0000-0000-0000-000000000001"; // เล็ก (S)
  const TABLE_1 = "eeeeeeee-0000-0000-0000-000000000001";
  let runId: string;
  const createdOrderIds: string[] = [];
  const settledReferences: string[] = [];
  let originalStoreFlags: {
    qr_ordering_enabled: boolean;
    table_open_policy: "staff_only" | "customer_self";
    voice_command_enabled: boolean;
  } | null = null;
  let originalTableSession: {
    qr_enabled: boolean;
    session_started_at: string | null;
    session_expires_at: string | null;
  } | null = null;
  let originalProductQr: { available_for_qr: boolean; kitchen_station_id: string | null } | null = null;
  let originalReceiptSettings: {
    auto_print_receipt: boolean;
    auto_print_station_tickets: boolean;
  } | null = null;
  let stationId: string | null = null;
  let printerId: string | null = null;

  test.beforeAll(async () => {
    runId = randomUUID().slice(0, 8);
    await setUnifiedPosFlag(true);

    const storeRow = await service
      .from("stores")
      .select("qr_ordering_enabled, table_open_policy, voice_command_enabled")
      .eq("id", SEED_STORE_ID)
      .single();
    if (storeRow.error || !storeRow.data) throw new Error(`อ่าน stores (local) ไม่สำเร็จ: ${storeRow.error?.message}`);
    originalStoreFlags = storeRow.data;

    const tableRow = await service
      .from("tables")
      .select("qr_enabled, session_started_at, session_expires_at")
      .eq("id", TABLE_1)
      .single();
    if (tableRow.error || !tableRow.data) throw new Error(`อ่าน tables (local) ไม่สำเร็จ: ${tableRow.error?.message}`);
    originalTableSession = tableRow.data;

    const productRow = await service
      .from("products")
      .select("available_for_qr, kitchen_station_id")
      .eq("id", PRODUCT_1)
      .single();
    if (productRow.error || !productRow.data) throw new Error(`อ่าน products (local) ไม่สำเร็จ: ${productRow.error?.message}`);
    originalProductQr = productRow.data;

    const settingsRow = await service
      .from("receipt_settings")
      .select("auto_print_receipt, auto_print_station_tickets")
      .eq("store_id", SEED_STORE_ID)
      .maybeSingle();
    if (settingsRow.error || !settingsRow.data) {
      throw new Error(`อ่าน receipt_settings (local) ไม่สำเร็จ: ${settingsRow.error?.message ?? "ไม่พบแถว"}`);
    }
    originalReceiptSettings = settingsRow.data;

    const insertedStation = await service
      .from("kitchen_stations")
      .insert({ organization_id: orgId, store_id: SEED_STORE_ID, name: `U17 Integrated ${runId}` })
      .select("id")
      .single();
    if (insertedStation.error || !insertedStation.data) {
      throw new Error(`สร้าง kitchen station ชั่วคราว (local) ไม่สำเร็จ: ${insertedStation.error?.message}`);
    }
    stationId = insertedStation.data.id;

    const insertedPrinter = await service
      .from("printers")
      .insert({
        organization_id: orgId,
        store_id: SEED_STORE_ID,
        name: `U17 Integrated Printer ${runId}`,
        type: "ip",
        is_default: true,
        ip_address: "192.168.1.251",
        port: 9100,
        paper_width: "80mm",
      })
      .select("id")
      .single();
    if (insertedPrinter.error || !insertedPrinter.data) {
      throw new Error(`สร้าง printer ชั่วคราว (local) ไม่สำเร็จ: ${insertedPrinter.error?.message}`);
    }
    printerId = insertedPrinter.data.id;

    const { error: storeErr } = await service
      .from("stores")
      .update({
        qr_ordering_enabled: true,
        table_open_policy: "customer_self",
        voice_command_enabled: true,
        updated_at: new Date().toISOString(),
      })
      .eq("id", SEED_STORE_ID);
    if (storeErr) throw new Error(`เปิด flag ชั่วคราว (local) ไม่สำเร็จ: ${storeErr.message}`);

    const { error: tableErr } = await service
      .from("tables")
      .update({
        qr_enabled: true,
        session_started_at: new Date().toISOString(),
        session_expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      })
      .eq("id", TABLE_1);
    if (tableErr) throw new Error(`เปิด session โต๊ะ 1 ชั่วคราว (local) ไม่สำเร็จ: ${tableErr.message}`);

    const { error: productErr } = await service
      .from("products")
      .update({ available_for_qr: true, kitchen_station_id: stationId })
      .eq("id", PRODUCT_1);
    if (productErr) throw new Error(`เปิด available_for_qr ชั่วคราว (local) ไม่สำเร็จ: ${productErr.message}`);

    const { error: settingsErr } = await service
      .from("receipt_settings")
      .update({ auto_print_receipt: true, auto_print_station_tickets: false })
      .eq("store_id", SEED_STORE_ID);
    if (settingsErr) throw new Error(`ตั้ง auto_print_receipt ชั่วคราว (local) ไม่สำเร็จ: ${settingsErr.message}`);
  });

  test.afterAll(async () => {
    const failures: string[] = [];
    if (createdOrderIds.length > 0) {
      await service.from("transactions").delete().in("order_id", createdOrderIds);
      await service.from("cash_ledger_entries").delete().in("order_id", createdOrderIds);
      const { error } = await service.from("orders").delete().in("id", createdOrderIds);
      if (error) failures.push(`orders: ${error.message}`);
    }
    for (const reference of settledReferences) {
      const opKey = reference.replace("unified_pos_settlement:", "");
      const { data: jobs } = await service
        .from("print_jobs")
        .select("id")
        .eq("store_id", SEED_STORE_ID)
        .like("source_key", `${reference}%`);
      for (const job of jobs ?? []) {
        const { error } = await service.from("print_jobs").delete().eq("id", (job as { id: string }).id);
        if (error) failures.push(`print_jobs: ${error.message}`);
      }
      const { error: auditErr } = await service
        .from("audit_logs")
        .delete()
        .eq("store_id", SEED_STORE_ID)
        .eq("request_id", opKey);
      if (auditErr) failures.push(`audit: ${auditErr.message}`);
      const { error: receiptErr } = await service
        .from("unified_pos_operation_receipts")
        .delete()
        .eq("store_id", SEED_STORE_ID)
        .eq("operation_key", opKey);
      if (receiptErr) failures.push(`receipts: ${receiptErr.message}`);
    }
    if (originalStoreFlags) {
      const { error } = await service.from("stores").update(originalStoreFlags).eq("id", SEED_STORE_ID);
      if (error) failures.push(`stores: ${error.message}`);
    }
    if (originalTableSession) {
      const { error } = await service.from("tables").update(originalTableSession).eq("id", TABLE_1);
      if (error) failures.push(`tables: ${error.message}`);
    }
    if (originalProductQr) {
      const { error } = await service.from("products").update(originalProductQr).eq("id", PRODUCT_1);
      if (error) failures.push(`products: ${error.message}`);
    }
    if (originalReceiptSettings) {
      const { error } = await service
        .from("receipt_settings")
        .update(originalReceiptSettings)
        .eq("store_id", SEED_STORE_ID);
      if (error) failures.push(`receipt_settings: ${error.message}`);
    }
    if (stationId) {
      const { error } = await service.from("kitchen_stations").delete().eq("id", stationId);
      if (error) failures.push(`kitchen_stations: ${error.message}`);
    }
    if (printerId) {
      const { error } = await service.from("printers").delete().eq("id", printerId);
      if (error) failures.push(`printers: ${error.message}`);
    }
    if (failures.length > 0) {
      throw new Error(`คืนค่า fixture U17 (local) ไม่ครบ: ${failures.join(" | ")}`);
    }
  });

  /** ลูกค้าส่งออเดอร์ผ่าน RPC v2 ตัวเดียวกับที่หน้า QR ของลูกค้าเรียก (atomic) */
  async function submitCustomerOrder(): Promise<{ orderId: string; itemId: string }> {
    if (createdOrderIds.length > 0) {
      const staleIds = [...createdOrderIds];
      createdOrderIds.length = 0;
      await service.from("transactions").delete().in("order_id", staleIds);
      await service.from("cash_ledger_entries").delete().in("order_id", staleIds);
      const { error: sweepErr } = await service.from("orders").delete().in("id", staleIds);
      if (sweepErr) throw new Error(`เก็บกวาดออเดอร์เทสก่อนหน้า (local) ไม่สำเร็จ: ${sweepErr.message}`);
    }
    const line = {
      product_id: PRODUCT_1,
      product_name: "กาแฟดำ",
      variant_id: VARIANT_1,
      variant_name: "เล็ก (S)",
      modifiers: [{ option: { id: "55555555-0000-0000-0000-000000000001", name: "ไม่หวาน", priceAdjustment: 0 } }],
      quantity: 1,
      unit_price: 45,
      total_price: 45,
      note: `U17-integrated-${runId}`,
    };
    const { data, error } = await service.rpc("create_qr_order_with_items_v2", {
      p_organization_id: orgId,
      p_store_id: SEED_STORE_ID,
      p_table_id: TABLE_1,
      p_order_number: `U17-${runId}-${createdOrderIds.length + 1}`,
      p_operation_key: createOperationKey(),
      p_request_hash: computeRequestHash({ storeId: SEED_STORE_ID, tableId: TABLE_1, subtotal: 45, items: [line] }),
      p_subtotal: 45,
      p_items: [line],
    });
    if (error) throw new Error(`submit QR order (local) ไม่สำเร็จ: ${error.message}`);
    const outcome = data as { status: string; result?: { order_id: string } } | null;
    if (!outcome || outcome.status !== "executed" || !outcome.result?.order_id) {
      throw new Error(`submit QR order (local) คืนสถานะไม่คาดคิด: ${JSON.stringify(outcome)}`);
    }
    const orderId = outcome.result.order_id;
    createdOrderIds.push(orderId);

    const items = await service.from("order_items").select("id").eq("order_id", orderId).limit(1);
    if (items.error || !items.data?.[0]) {
      throw new Error(`อ่าน order_items ของออเดอร์ที่เพิ่งสร้างไม่สำเร็จ: ${items.error?.message ?? "ไม่พบแถว"}`);
    }
    return { orderId, itemId: items.data[0].id };
  }

  /** เก็บ console error/pageerror ของหน้าไว้ตรวจตอนจบเทส */
  function collectConsoleErrors(page: Page): string[] {
    const errors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    page.on("pageerror", (error) => errors.push(error.message));
    return errors;
  }

  test("integrated: ลูกค้า QR to ครัว to บิล to ชำระ to งานพิมพ์ใบเดียว (console ไม่มี error)", async ({ page }) => {
    const consoleErrors = collectConsoleErrors(page);
    const seeded = await submitCustomerOrder();
    await loginOwner(page);
    await page.goto("/pos");

    // ครัว: เห็นรายการที่ลูกค้าส่ง แล้วเดินสถานะจนพร้อมเสิร์ฟ
    await page.getByRole("tab", { name: "ครัว" }).click();
    const card = page.locator(`[data-kitchen-item="${seeded.itemId}"]`);
    await expect(card).toBeVisible();
    await expect(card).toHaveAttribute("data-kitchen-state", "new");
    await card.getByRole("button", { name: "รับรายการ" }).click();
    await expect(card).toHaveAttribute("data-kitchen-state", "preparing");
    await card.getByRole("button", { name: "พร้อมเสิร์ฟ" }).click();
    await expect(card).toHaveAttribute("data-kitchen-state", "ready");

    // บิล: เลือกโต๊ะ 1 แล้วต้องเห็นบิลของออเดอร์นี้
    await page.getByRole("tab", { name: "โต๊ะ" }).click();
    const tablesPanel = page.getByRole("tabpanel", { name: "โต๊ะ" });
    await expect(tablesPanel.getByText("โต๊ะ 1")).toBeVisible();
    await tablesPanel.getByRole("button", { name: "เลือกโต๊ะ" }).first().click();
    await page.getByRole("tab", { name: "บิล" }).click();
    const billPanel = page.getByRole("tabpanel", { name: "บิล" });
    await expect(billPanel.getByTestId("unified-bill-view")).toBeVisible();
    await expect(billPanel.getByText("กาแฟดำ (เล็ก (S))")).toBeVisible();

    // ชำระผ่าน UI ครั้งเดียว
    await billPanel.getByRole("checkbox").check();
    await billPanel.getByTestId("settle-order").first().click();
    await expect(billPanel.getByTestId("settle-result")).toBeVisible({ timeout: 20_000 });

    // ตรวจจาก server: ออเดอร์ปิด + งานพิมพ์ใบเสร็จใบเดียว
    const order = await service.from("orders").select("status").eq("id", seeded.orderId).single();
    expect(order.error, order.error?.message).toBeNull();
    expect(order.data?.status).toBe("paid");

    // reference ของ settlement มาจาก UI (data-receipt-reference) — ตรงกับที่ผู้ใช้เพิ่งทำจริง
    const settleResult = billPanel.getByTestId("settle-result");
    await expect(settleResult).toHaveAttribute("data-replayed", "false");
    const reference = await settleResult.getAttribute("data-receipt-reference");
    expect(reference, "settlement ต้องคืน reference ของใบเสร็จ").toBeTruthy();
    settledReferences.push(reference!);

    const jobs = await service
      .from("print_jobs")
      .select("id, source_key")
      .eq("store_id", SEED_STORE_ID)
      .like("source_key", `${reference!}%`);
    expect(jobs.error, jobs.error?.message).toBeNull();
    expect(jobs.data ?? []).toHaveLength(1);

    expect(consoleErrors, `console error ที่เจอ: ${consoleErrors.join(" | ")}`).toEqual([]);
  });

  test("integrated: ใช้แป้นพิมพ์อย่างเดียวเปลี่ยนแท็บได้ และ 390/768/1440 ไม่มี overflow", async ({ page }) => {
    const consoleErrors = collectConsoleErrors(page);
    await loginOwner(page);
    await page.goto("/pos");

    // keyboard-only: โฟกัสแท็บแรกแล้วเดินด้วยลูกศร/Home/End (ARIA tablist pattern)
    const sellTab = page.getByRole("tab", { name: "ขาย" });
    await sellTab.focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByRole("tab", { name: "โต๊ะ" })).toBeFocused();
    await expect(page.getByRole("tab", { name: "โต๊ะ" })).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("End");
    await expect(page.getByRole("tab", { name: "บิล" })).toBeFocused();
    await page.keyboard.press("Home");
    await expect(sellTab).toBeFocused();
    await expect(sellTab).toHaveAttribute("aria-selected", "true");

    // ปุ่มเสียงต้องเข้าถึงด้วยแป้นพิมพ์ได้ (มีชื่อ accessible และโฟกัสได้)
    // ปุ่มเริ่มที่ disabled จนกว่าจะตรวจ capability ของเบราว์เซอร์เสร็จหลัง mount (กัน hydration mismatch)
    const voiceButton = page.getByRole("button", { name: "สั่งงานด้วยเสียง" });
    await expect(voiceButton).toBeEnabled();
    await voiceButton.focus();
    await expect(voiceButton).toBeFocused();

    for (const width of [390, 768, 1440]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto("/pos");
      await expect(page.getByRole("tablist", { name: "ส่วนของ POS รวม" })).toBeVisible();
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `ความกว้าง ${width}px ต้องไม่มี horizontal overflow`).toBeLessThanOrEqual(1);
    }

    expect(consoleErrors, `console error ที่เจอ: ${consoleErrors.join(" | ")}`).toEqual([]);
  });

  test("integrated: flag matrix — เสียงปิด = shell ปกติแต่ไม่มีปุ่มเสียง, unified ปิด = legacy ล้วน", async ({ page }) => {
    // 1) unified เปิด + เสียงปิด
    const { error: voiceOffErr } = await service
      .from("stores")
      .update({ voice_command_enabled: false, updated_at: new Date().toISOString() })
      .eq("id", SEED_STORE_ID);
    if (voiceOffErr) throw new Error(`ปิด flag เสียงชั่วคราวไม่สำเร็จ: ${voiceOffErr.message}`);

    await loginOwner(page);
    await page.goto("/pos");
    await expect(page.getByRole("tablist", { name: "ส่วนของ POS รวม" })).toBeVisible();
    await expect(page.getByRole("button", { name: "สั่งงานด้วยเสียง" })).toHaveCount(0);
    await page.getByRole("tab", { name: "ครัว" }).click();
    await expect(page.getByRole("tab", { name: "ครัว" })).toHaveAttribute("aria-selected", "true");

    // 2) unified ปิด = หน้าขายเดิมล้วน (ไม่มีทั้ง shell และเสียง)
    await setUnifiedPosFlag(false);
    await page.goto("/pos");
    await expect(page.getByText("ขายหน้าร้าน · POS")).toBeVisible();
    await expect(page.getByRole("tablist", { name: "ส่วนของ POS รวม" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "สั่งงานด้วยเสียง" })).toHaveCount(0);

    // คืนสถานะให้ describe นี้ (afterAll คืนค่าเดิมของทั้งไฟล์อีกชั้น)
    await setUnifiedPosFlag(true);
    const { error: voiceOnErr } = await service
      .from("stores")
      .update({ voice_command_enabled: true, updated_at: new Date().toISOString() })
      .eq("id", SEED_STORE_ID);
    if (voiceOnErr) throw new Error(`เปิด flag เสียงคืนไม่สำเร็จ: ${voiceOnErr.message}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// U22 — คำเรียกเมนูอัตโนมัติ: ระบบวิเคราะห์ชื่อเมนู → คนตรวจ → บันทึก → เสียงใช้ได้
//
// seed สินค้าชื่ออังกฤษชั่วคราว (เมนู seed เป็นไทยล้วนจึงไม่มีอะไรให้เสนอ) แล้วลบทิ้งใน afterAll
test.describe("voice alias U22 (เสนอคำเรียกเมนูอัตโนมัติ)", () => {
  let runId: string;
  let productId: string | null = null;
  const createdAliasIds: string[] = [];

  test.beforeAll(async () => {
    runId = randomUUID().slice(0, 8);
    void runId;
    const category = await service
      .from("categories")
      .select("id")
      .eq("store_id", SEED_STORE_ID)
      .limit(1)
      .single();
    if (category.error || !category.data) {
      throw new Error(`อ่านหมวดสินค้า (local) ไม่สำเร็จ: ${category.error?.message ?? "ไม่พบแถว"}`);
    }
    const inserted = await service
      .from("products")
      .insert({
        organization_id: orgId,
        store_id: SEED_STORE_ID,
        category_id: category.data.id,
        // ชื่อเมนูต้องเป็นคำที่พจนานุกรมรู้จักล้วน ๆ — ต่อท้ายด้วยรหัสสุ่มจะทำให้ระบบไม่เดา (ตามดีไซน์)
        name: "Espresso",
        base_price: 55,
        is_active: true,
        available_for_pos: true,
        available_for_qr: false,
        sort_order: 99,
      })
      .select("id")
      .single();
    if (inserted.error || !inserted.data) {
      throw new Error(`สร้างสินค้าชั่วคราว (local) ไม่สำเร็จ: ${inserted.error?.message}`);
    }
    productId = inserted.data.id;
  });

  test.afterAll(async () => {
    const failures: string[] = [];
    if (createdAliasIds.length > 0) {
      const { error } = await service.from("voice_aliases").delete().in("id", createdAliasIds);
      if (error) failures.push(`voice_aliases: ${error.message}`);
    }
    if (productId) {
      const { error } = await service.from("products").delete().eq("id", productId);
      if (error) failures.push(`products: ${error.message}`);
    }
    if (failures.length > 0) throw new Error(`คืนค่า fixture U22 (local) ไม่ครบ: ${failures.join(" | ")}`);
  });

  test("voice alias: หน้าตั้งค่าเสนอคำเรียกจากชื่อเมนู แล้วบันทึกตามที่ติ๊กได้", async ({ page }) => {
    await loginOwner(page);
    await page.goto("/settings/voice");

    // ระบบต้องเสนอคำไทยของเมนูชื่ออังกฤษให้เอง โดยยังไม่บันทึกจนกว่าจะกด
    const suggestionRow = page.locator("tr", { hasText: "Espresso" }).first();
    await expect(suggestionRow).toBeVisible();
    await expect(suggestionRow.getByRole("textbox")).toHaveValue("เอสเพรสโซ");
    await expect(suggestionRow.getByText("แปลจากชื่ออังกฤษ")).toBeVisible();

    const before = await service
      .from("voice_aliases")
      .select("id", { count: "exact", head: true })
      .eq("store_id", SEED_STORE_ID);
    expect(before.count ?? 0).toBe(0);

    // ติ๊กไว้ให้แล้วเป็นค่าเริ่มต้น และแก้ข้อความได้ก่อนบันทึก
    await expect(suggestionRow.getByRole("checkbox")).toBeChecked();
    const aliasInput = suggestionRow.getByRole("textbox");
    await expect(aliasInput).toHaveValue("เอสเพรสโซ");
    await aliasInput.fill("เอสเพรสโซ่");
    await expect(suggestionRow.getByText(/คืนค่าที่ระบบเสนอ/)).toBeVisible();
    await suggestionRow.getByText(/คืนค่าที่ระบบเสนอ/).click();
    await expect(aliasInput).toHaveValue("เอสเพรสโซ");

    await page.getByRole("button", { name: /บันทึกที่เลือก/ }).click();
    await expect(page.getByText(/บันทึกคำเรียกเมนูแล้ว/)).toBeVisible({ timeout: 20_000 });

    const saved = await service
      .from("voice_aliases")
      .select("id, alias_text, intent_type, slots, is_active")
      .eq("store_id", SEED_STORE_ID);
    expect(saved.error, saved.error?.message).toBeNull();
    const rows = saved.data ?? [];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) createdAliasIds.push((row as { id: string }).id);

    const espresso = rows.find((row) => (row as { alias_text: string }).alias_text === "เอสเพรสโซ") as
      | { intent_type: string; slots: { product_id?: string }; is_active: boolean }
      | undefined;
    expect(espresso, "ต้องบันทึกคำเรียก 'เอสเพรสโซ' ไว้").toBeTruthy();
    expect(espresso?.intent_type).toBe("product");
    expect(espresso?.slots?.product_id).toBe(productId);
    expect(espresso?.is_active).toBe(true);

    // บันทึกแล้วต้องไม่ถูกเสนอซ้ำ และย้ายไปอยู่รายการ "บันทึกไว้แล้ว"
    await page.reload();
    await expect(page.getByText(/คำเรียกเมนูที่บันทึกไว้แล้ว/)).toBeVisible();
    await expect(page.locator("tr", { hasText: "Espresso" })).toHaveCount(0);
  });
});
