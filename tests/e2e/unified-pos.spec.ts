import { expect, test, type Page } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { readLocalSupabaseStatusEnv } from "./helpers/local-supabase-env";

// U9 — unified POS shell e2e (chromium): feature flag / legacy fallback / responsive
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

    // แท็บครัว/บิล: placeholder ตรงไปตรงมา (ปุ่ม disabled)
    await page.getByRole("tab", { name: "ครัว" }).click();
    await expect(page.getByRole("tabpanel", { name: "ครัว" }).getByRole("heading", { name: "คิวครัว" })).toBeVisible();
    await expect(page.getByRole("button", { name: "รับรายการ" })).toBeDisabled();
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
