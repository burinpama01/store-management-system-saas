import { expect, test, type Locator, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { readLocalSupabaseStatusEnv } from "./helpers/local-supabase-env";

// PR3 — AI Assistant โหมดข้อความ e2e (chromium) — ปิดเกต e2e ของ text path ที่ค้างจาก PR2
//
// ขอบเขตที่ชุดนี้พิสูจน์ได้จริง:
//   - ปุ่มผู้ช่วยข้อความแสดงบน shell ของ Unified POS เมื่อ env เปิด (kill switch เป็นเพียงทางเข้า
//     สิทธิ์/แพ็กเกจตรวจซ้ำที่ route ทุกครั้ง)
//   - เส้นทางอ่าน (read-tool: pos.search_product) จับคู่สินค้าจาก seed ผ่าน resolver เดิมของ
//     Voice POS ได้ทั้ง exact match และ ambiguous (candidates) + ตอบ follow-up ด้วยชื่อเต็ม
//   - คำสั่งเขียนผ่านหน้าจอถูกปฏิเสธแบบ fail-closed: build จริง (`next start` = production) ผ่าน
//     เกต durable store มาแล้ว (PR3 wiring) แต่ไม่ตั้ง AI_ASSISTANT_MUTATIONS_ENABLED → ผลคือ
//     MUTATIONS_DISABLED — ชุดนี้ pin พฤติกรรม "wiring อย่างเดียวยังไม่ปลด mutation" ปลายทางจริง
//   - ข้อความที่ parser ไม่เข้าใจ ตอบกลับอย่างปลอดภัยเมื่อ AI ปิด (ai_disabled) — convention
//     เดียวกับ voice-ai-pos.spec.ts ("local stack ไม่มี OPENAI_API_KEY")
//   - ยังไม่ login → /pos ไม่มีปุ่มผู้ช่วย และ route ตอบ 401
//
// เหตุผลที่ flow "ค้นหา → ได้ผลจาก resolver" ทดสอบระดับ route (read-tool) ไม่ใช่การพิมพ์ใน UI:
//   โหมดข้อความของ UI ส่งเฉพาะคำสั่งตะกร้า — เกต mutation ปฏิเสธ safe_write "ก่อน" tool execute
//   (foundation.ts: MUTATIONS_DISABLED มาก่อน binding/claim) จึงไม่มีทางถึง resolver จากการพิมพ์
//   ในขณะที่ mutation ยังปิด — ตรวจ resolver ได้จริงผ่าน read-tool mode ของ route เดียวกัน
//
// สิ่งที่ชุดนี้ "ไม่" พิสูจน์ (ครอบที่ชั้น unit แล้ว):
//   - 403 ai_not_in_plan (route test: text-command-route.test.ts pin ไว้) — e2e ต้องแก้
//     subscriptions ร่วมกับ unified-pos.spec.ts เสี่ยง flake เมื่อรันชุดเต็มแบบขนาน จึงเลือกไม่ทำ
//   - คุณภาพคำตอบของ AI จริง — ชุดนี้รันกับ AI ปิดเสมอ
//
// วิธีรัน (ห้ามแก้ .env จริง — env ทั้งหมดให้ shell ของ command):
//   AI_ASSISTANT_ENABLED=true OPENAI_API_KEY="" \
//     npx playwright test tests/e2e/ai-assistant-text.spec.ts
//   (OPENAI_API_KEY="" บังคับปิดทางสำรอง AI ให้ deterministic — process env ชนะ .env.local)

const SEED_STORE_ID = "cccccccc-0000-0000-0000-000000000001"; // Main Branch (seed.sql)
const OWNER_AUTH_USER_ID = "00000000-0000-0000-0000-000000000001"; // owner (seed.sql)
const OWNER_EMAIL = "owner@demo.local";
const OWNER_PASSWORD = "demo1234";

let service: SupabaseClient;
let orgId: string | null = null;
/** ต่อท้าย requestId ทุกดอก — durable ledger (ai_assistant_actions) อาจมีแถวค้างจากรอบรันก่อน
 * ถ้า cleanup ไม่สมบูรณ์ คีย์เดิม + payload ใหม่จะกลายเป็น IDEMPOTENCY_CONFLICT */
let runId: string;
let originalUnifiedFlag: boolean | null = null;
let originalSubscription: { plan: string; status: string; current_period_end: string } | null = null;
let createdCashSessionId: string | null = null;
/** สินค้าชั่วคราวเพื่อสร้าง "ชื่อคลุมเครือ" (ชา → ชาเย็น + ชาดำ) — seed มีชื่อไม่ซ้อนกันเลย */
const AMBIGUOUS_PRODUCT_ID = "22222222-0000-0000-0000-000000000099"; // ชาดำ (fixture ของชุดนี้)

async function loginOwner(page: Page): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(OWNER_EMAIL);
  await page.locator("#password").fill(OWNER_PASSWORD);
  await page.getByRole("button", { name: "เข้าสู่ระบบ" }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
}

/** service client (bypass RLS) — ตั้ง flag shell ของ seed store (UI tests ต้องใช้ shell) */
async function setUnifiedPosFlag(value: boolean): Promise<void> {
  const { error } = await service
    .from("stores")
    .update({ unified_pos_enabled: value, updated_at: new Date().toISOString() })
    .eq("id", SEED_STORE_ID);
  if (error) {
    throw new Error(`ตั้ง stores.unified_pos_enabled = ${value} (local) ไม่สำเร็จ: ${error.message}`);
  }
}

/** เปิดแผงผู้ช่วยบนหน้าขาย — คืน locator ของ dialog เพื่อ assert ต่อ */
async function openAssistantPanel(page: Page) {
  await loginOwner(page);
  await page.goto("/pos");
  // ปุ่มผู้ช่วย mount เฉพาะใน UnifiedPosWorkspace (เชลล์ใหม่หลัง U13-U21: ปุ่มอยู่แถวหัว
  // ไม่ใช่ tablist 4 แท็บแบบ U9) — ปุ่มขึ้น = shell เรนเดอร์และ env เปิด
  const assistantButton = page.getByRole("button", { name: /ผู้ช่วย/ });
  await expect(assistantButton).toBeVisible();
  await assistantButton.click();
  const dialog = page.getByRole("dialog", { name: "ผู้ช่วย AI โหมดข้อความ" });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function sendAssistantText(page: Page, dialog: Locator, text: string): Promise<void> {
  await dialog.getByLabel("พิมพ์คำสั่งสำหรับผู้ช่วย AI").fill(text);
  await dialog.getByRole("button", { name: "ส่ง" }).click();
}

test.beforeAll(async () => {
  const env = readLocalSupabaseStatusEnv(); // throw ถ้า local stack ไม่พร้อม (fail-loud)
  service = createClient(env.apiUrl, env.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  runId = randomUUID().replace(/-/g, "").slice(0, 12);
  const { data, error } = await service
    .from("stores")
    .select("organization_id, unified_pos_enabled")
    .eq("id", SEED_STORE_ID)
    .single();
  if (error || !data) {
    throw new Error(`อ่าน seed store (local) ไม่สำเร็จ: ${error?.message ?? "ไม่พบแถว"}`);
  }
  originalUnifiedFlag = data.unified_pos_enabled;
  orgId = data.organization_id;
  await setUnifiedPosFlag(true);

  // เพิ่มสินค้า "ชาดำ" ชั่วคราว (หมวดเครื่องดื่มเดียวกับ seed) — seed ตั้งให้ชื่อสินค้า
  // ไม่ซ้อนกันเลย จึงไม่มีวลีไหนเจอ ambiguous ผ่าน resolver ได้; ลบทิ้งใน afterAll
  const insertedProduct = await service
    .from("products")
    .insert({
      id: AMBIGUOUS_PRODUCT_ID,
      organization_id: orgId,
      store_id: SEED_STORE_ID,
      category_id: "11111111-0000-0000-0000-000000000001",
      name: "ชาดำ",
      base_price: 35,
      is_active: true,
      available_for_pos: true,
      sort_order: 9,
    })
    .select("id")
    .single();
  if (insertedProduct.error || !insertedProduct.data) {
    throw new Error(`สร้างสินค้าชั่วคราวสำหรับทดสอบชื่อคลุมเครือ (local) ไม่สำเร็จ: ${insertedProduct.error?.message ?? "ไม่ได้แถวที่ insert"}`);
  }

  // Billing precondition: app gate อนุญาตเฉพาะ paid plan และ route ต้องการ entitlement
  // aiAssistant (มีเฉพาะแพ็ก enterprise ดู PLAN_FEATURES) — ตั้ง enterprise ชั่วคราวแล้วคืนค่าเดิมใน afterAll
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
      plan: "enterprise",
      status: "active",
      current_period_end: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    })
    .eq("organization_id", orgId);
  if (subUpdateError) {
    throw new Error(`ตั้ง subscription เป็น enterprise ชั่วคราว (local) ไม่สำเร็จ: ${subUpdateError.message}`);
  }

  // Cash-session precondition: legacy terminal force-open dialog "เปิดรอบเงินสด" บังคลิก
  // ทุกแท็บของ shell เมื่อไม่มี session เปิด — เปิดไว้ก่อนและลบเฉพาะแถวที่สร้างเองใน afterAll
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
        open_note: "AI assistant text e2e fixture",
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
  const failures: string[] = [];
  if (service && originalUnifiedFlag !== null) {
    const { error } = await service
      .from("stores")
      .update({ unified_pos_enabled: originalUnifiedFlag, updated_at: new Date().toISOString() })
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
  if (service) {
    const { error } = await service
      .from("products")
      .delete()
      .eq("id", AMBIGUOUS_PRODUCT_ID);
    if (error) failures.push(`products (ชาดำ): ${error.message}`);
  }
  // PR3 — wiring durable idempotency แล้ว: read-tool ของชุดนี้เขียนแถวลง ai_assistant_actions
  // จริง (local) — เก็บกวาดเฉพาะแถวของ org seed ทิ้งเพื่อไม่ให้ local DB สะสมแถวทดสอบ
  if (service && orgId) {
    const { error } = await service
      .from("ai_assistant_actions")
      .delete()
      .eq("organization_id", orgId);
    if (error) failures.push(`ai_assistant_actions: ${error.message}`);
  }
  if (failures.length > 0) {
    throw new Error(`คืนค่า fixture e2e ผู้ช่วยข้อความ (local) ไม่ครบ: ${failures.join(" | ")}`);
  }
});

test.describe("UI overlay บน Unified POS (mutation ปิด — pin fail-closed)", () => {
  test("ปุ่มผู้ช่วยข้อความอยู่บนแถบหัวของ shell เมื่อ env เปิด และเปิดแผงพิมพ์คำสั่งได้", async ({ page }) => {
    const dialog = await openAssistantPanel(page);
    await expect(dialog.getByLabel("พิมพ์คำสั่งสำหรับผู้ช่วย AI")).toBeVisible();
    await expect(dialog.getByRole("log", { name: "ผลการทำงานของผู้ช่วย" })).toBeVisible();
  });

  test("คำสั่งเขียน (เพิ่ม…) ถูกปฏิเสธแบบ fail-closed ด้วยข้อความ MUTATIONS_DISABLED", async ({ page }) => {
    const dialog = await openAssistantPanel(page);
    await sendAssistantText(page, dialog, "เพิ่มข้าวผัดกุ้ง 1 จาน");
    // wiring durable (PR3) ทำให้ production ผ่านเกต DURABLE_STORAGE_REQUIRED แล้ว
    // แต่ไม่ตั้ง AI_ASSISTANT_MUTATIONS_ENABLED → ยังปฏิเสธด้วยข้อความเดิมของ UI
    await expect(dialog.getByRole("log")).toContainText("การแก้ตะกร้าผ่านผู้ช่วยยังปิดในรอบนี้");
    // ไม่มีอะไรถูก apply — ไม่มีปุ่ม undo
    await expect(dialog.getByRole("button", { name: /ย้อนกลับ/ })).toHaveCount(0);
  });

  test("ข้อความที่ parser ไม่เข้าใจ ตอบกลับอย่างปลอดภัยเมื่อ AI ปิด (ai_disabled)", async ({ page }) => {
    const dialog = await openAssistantPanel(page);
    await sendAssistantText(page, dialog, "ข้าวผัดกุ้งราคาเท่าไหร่ครับ");
    await expect(dialog.getByRole("log")).toContainText("ระบบ AI ยังไม่เปิด");
  });
});

test.describe("เส้นทางอ่านของ route (read-tool → resolver)", () => {
  test("ค้นหาสินค้าที่ seed มีแบบตรงตัว → resolver จับคู่ได้ พร้อมราคา", async ({ page }) => {
    await loginOwner(page);
    const response = await page.request.post("/api/ai-assistant/text-command", {
      data: { requestId: `req${runId}search1`, tool: "pos.search_product", args: { query: "ข้าวผัดกุ้ง" } },
    });
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.outcomes[0]).toMatchObject({ kind: "tool", ok: true, tool: "pos.search_product" });
    expect(body.outcomes[0].result).toMatchObject({ status: "matched", product: { name: "ข้าวผัดกุ้ง" } });
    expect(body.outcomes[0].result.price).toBe(120);
  });

  test("ชื่อคลุมเครือ → clarification candidates จาก resolver และตอบ follow-up ด้วยชื่อเต็มได้", async ({ page }) => {
    await loginOwner(page);
    // "ชา" ขึ้นต้นตรงกับ ชาเย็น (seed) และ ชาดำ (fixture ชั่วคราว) = 2 ตัวในชั้นเดียวกัน
    // → resolver ตัดสิน ambiguous พร้อม candidates (จำลอง clarification ของช่องทางข้อความ)
    const ambiguous = await page.request.post("/api/ai-assistant/text-command", {
      data: { requestId: `req${runId}ambig1`, tool: "pos.search_product", args: { query: "ชา" } },
    });
    expect(ambiguous.status()).toBe(200);
    const ambiguousBody = await ambiguous.json();
    expect(ambiguousBody.outcomes[0].result).toMatchObject({ status: "ambiguous" });
    const names = (ambiguousBody.outcomes[0].result.candidates as { name: string }[]).map((candidate) => candidate.name);
    expect(names).toEqual(expect.arrayContaining(["ชาเย็น", "ชาดำ"]));

    // follow-up: เลือกชื่อเต็มจาก candidates → resolver จับคู่ได้ตัวเดียว
    const followUp = await page.request.post("/api/ai-assistant/text-command", {
      data: { requestId: `req${runId}ambig2`, tool: "pos.search_product", args: { query: "ชาดำ" } },
    });
    expect(followUp.status()).toBe(200);
    const followUpBody = await followUp.json();
    expect(followUpBody.outcomes[0].result).toMatchObject({ status: "matched", product: { name: "ชาดำ" } });
    expect(followUpBody.outcomes[0].result.price).toBe(35);
  });
});

test.describe("เกตผู้เรียก (ยังไม่ login)", () => {
  test("/pos ไม่แสดงปุ่มผู้ช่วยเมื่อยังไม่ login และ API ถูกเกตไม่ให้ผ่าน", async ({ page, browser }) => {
    await page.goto("/pos");
    // app gate พาไปหน้า login — ไม่มี shell/ปุ่มผู้ช่วยให้เห็น
    await page.waitForURL((url) => url.pathname.startsWith("/login"));
    await expect(page.getByRole("button", { name: /ผู้ช่วย/ })).toHaveCount(0);

    // เรียก route ตรงด้วย context ที่ไม่มี session cookie — middleware ของแอปเป็นเกตจริง:
    // redirect ไป /login (307) ก่อนถึง handler เสมอ (fail-closed ปลายทางเบราว์เซอร์)
    const anon = await browser.newContext();
    try {
      const response = await anon.request.post("/api/ai-assistant/text-command", {
        data: { requestId: "req-e2e-anon01", text: "เพิ่มลาเต้ 1 แก้ว" },
        maxRedirects: 0,
      });
      expect(response.status()).toBe(307);
      expect(response.headers()["location"]).toContain("/login");
    } finally {
      await anon.close();
    }
  });
});
