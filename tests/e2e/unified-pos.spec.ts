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
    await expect(page.getByRole("button", { name: "พิมพ์ใบเสร็จ" })).toBeDisabled();

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
