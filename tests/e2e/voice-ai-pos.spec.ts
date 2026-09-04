import { expect, test, type Page } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { readLocalSupabaseStatusEnv } from "./helpers/local-supabase-env";

// P10 — AI Voice Intent Phase 1 e2e (chromium) กับ server จริง + local Supabase stack
//
// ขอบเขตที่ชุดนี้พิสูจน์ได้จริง:
//   - เส้นทาง server ของ /api/ai/voice-intent ทำงานครบตั้งแต่ auth → permission →
//     package gate → validate body → quota โดยยิงผ่าน session จริงของผู้ใช้
//   - คำตอบไม่ echo คำพูด และตั้ง Cache-Control: no-store เสมอ
//   - ปุ่มเสียงยังขึ้นบนหน้า POS เมื่อร้านเปิด flag (ไม่ regress จาก P7)
//
// สิ่งที่ชุดนี้ "ไม่" พิสูจน์ (ต้องทำตอน pilot กับเครื่องจริง):
//   - คุณภาพการถอดเสียงและความแม่นของโมเดล — Chromium headless ไม่มี Web Speech API
//     จึงกดปุ่มแล้วพูดจริงไม่ได้ ส่วนนั้นทดสอบด้วยมือบนเครื่องที่มีไมค์
//   - local stack ไม่มี OPENAI_API_KEY จึงคาดหวังผลลัพธ์ที่ปลายทางเป็น ai_disabled
//     (ซึ่งก็คือการพิสูจน์ว่า "ปิด AI แล้วระบบตอบอย่างปลอดภัย ไม่ล่ม")

const SEED_STORE_ID = "cccccccc-0000-0000-0000-000000000001";
const OWNER_EMAIL = "owner@demo.local";
const OWNER_PASSWORD = "demo1234";

let service: SupabaseClient;
let orgId: string | null = null;
let originalVoiceFlag: boolean | null = null;
let originalUnifiedFlag: boolean | null = null;
let originalSubscription: { plan: string; status: string; current_period_end: string } | null = null;
let createdCashSessionId: string | null = null;

async function loginOwner(page: Page): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(OWNER_EMAIL);
  await page.locator("#password").fill(OWNER_PASSWORD);
  await page.getByRole("button", { name: "เข้าสู่ระบบ" }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
}

test.beforeAll(async () => {
  const env = readLocalSupabaseStatusEnv();
  service = createClient(env.apiUrl, env.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });

  const store = await service
    .from("stores")
    .select("organization_id, voice_command_enabled, unified_pos_enabled")
    .eq("id", SEED_STORE_ID)
    .single();
  if (store.error || !store.data) {
    throw new Error(`อ่าน seed store (local) ไม่สำเร็จ: ${store.error?.message ?? "ไม่พบแถว"}`);
  }
  orgId = String(store.data.organization_id);
  originalVoiceFlag = Boolean(store.data.voice_command_enabled);
  originalUnifiedFlag = Boolean(store.data.unified_pos_enabled);

  const sub = await service
    .from("subscriptions")
    .select("plan, status, current_period_end")
    .eq("organization_id", orgId)
    .maybeSingle();
  if (sub.error || !sub.data) {
    throw new Error(`อ่าน subscriptions เดิม (local) ไม่สำเร็จ: ${sub.error?.message ?? "ไม่พบแถว"}`);
  }
  originalSubscription = {
    plan: String(sub.data.plan),
    status: String(sub.data.status),
    current_period_end: String(sub.data.current_period_end),
  };

  // AI ผู้ช่วยเป็นสิทธิ์ของ enterprise — ตั้งชั่วคราวแล้วคืนค่าเดิมใน afterAll เสมอ
  const updates = await Promise.all([
    service
      .from("stores")
      .update({ voice_command_enabled: true, unified_pos_enabled: true })
      .eq("id", SEED_STORE_ID),
    service
      .from("subscriptions")
      .update({
        plan: "enterprise",
        status: "active",
        current_period_end: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      })
      .eq("organization_id", orgId),
  ]);
  for (const result of updates) {
    if (result.error) throw new Error(`ตั้ง fixture (local) ไม่สำเร็จ: ${result.error.message}`);
  }

  // POS บังคับเปิดรอบเงินสดก่อนใช้งาน — overlay นั้นบังทุกปุ่มรวมถึงปุ่มเสียง
  // ใช้รอบที่เปิดอยู่ถ้ามี (unique index 1 open session/store) และลบเฉพาะที่สร้างเอง
  const openSession = await service
    .from("cash_sessions")
    .select("id")
    .eq("store_id", SEED_STORE_ID)
    .eq("status", "open")
    .maybeSingle();
  if (openSession.error) throw new Error(`อ่าน cash_sessions (local) ไม่สำเร็จ: ${openSession.error.message}`);
  if (!openSession.data) {
    const inserted = await service
      .from("cash_sessions")
      .insert({
        organization_id: orgId,
        store_id: SEED_STORE_ID,
        status: "open",
        opening_float: 0,
        opened_by_user_id: "00000000-0000-0000-0000-000000000001",
        open_note: "P10 voice e2e fixture",
      })
      .select("id")
      .single();
    if (inserted.error || !inserted.data) {
      throw new Error(`เปิด cash session ชั่วคราว (local) ไม่สำเร็จ: ${inserted.error?.message ?? "ไม่ได้แถว"}`);
    }
    createdCashSessionId = inserted.data.id;
  }
});

test.afterAll(async () => {
  const failures: string[] = [];
  if (service && originalVoiceFlag !== null && originalUnifiedFlag !== null) {
    const { error } = await service
      .from("stores")
      .update({ voice_command_enabled: originalVoiceFlag, unified_pos_enabled: originalUnifiedFlag })
      .eq("id", SEED_STORE_ID);
    if (error) failures.push(`คืน store flags ไม่สำเร็จ: ${error.message}`);
  }
  if (service && createdCashSessionId) {
    const { error } = await service.from("cash_sessions").delete().eq("id", createdCashSessionId);
    if (error) failures.push(`ลบ cash session ที่สร้างเองไม่สำเร็จ: ${error.message}`);
  }
  if (service && orgId && originalSubscription) {
    const { error } = await service.from("subscriptions").update(originalSubscription).eq("organization_id", orgId);
    if (error) failures.push(`คืน subscription ไม่สำเร็จ: ${error.message}`);
  }
  if (failures.length > 0) throw new Error(failures.join(" · "));
});

test.describe("AI voice intent — เส้นทาง server", () => {
  test("ผู้ใช้ที่ล็อกอินยิงได้ ผ่านทุกด่านจนถึงปลายทาง และไม่ echo คำพูดกลับมา", async ({ page }) => {
    await loginOwner(page);

    const utterance = "ลาเต้สองแก้วกับอเมริกาโน่ร้อนหนึ่งแก้ว";
    const response = await page.request.post("/api/ai/voice-intent", {
      data: {
        requestId: `voice-e2e-${Date.now()}`,
        utterance,
        locale: "th-TH",
        origin: "push_to_talk",
      },
    });

    // ผ่าน auth/permission/package gate แล้ว (ไม่ใช่ 401/403)
    expect([401, 403]).not.toContain(response.status());
    expect(response.headers()["cache-control"]).toBe("no-store");

    const body = await response.text();
    // ห้าม echo คำพูดของผู้ใช้กลับมาไม่ว่าผลจะเป็นอะไร
    expect(body).not.toContain(utterance);

    // ผลลัพธ์ที่ยอมรับได้มี 3 แบบ และทุกแบบต้อง "ปลอดภัย" คือมีทางออกด้วยมือเสมอ
    //   200 = เครื่องที่รันมี OPENAI_API_KEY และ provider ตอบทัน
    //   503 = ไม่มี key (ai_disabled)  ·  504 = provider ช้ากว่า timeout ที่ตั้งไว้
    const json = JSON.parse(body) as {
      ok: boolean;
      reason?: string;
      manualPath?: string;
      intent?: { version: number };
    };
    expect([200, 503, 504]).toContain(response.status());
    if (response.status() === 200) {
      expect(json.ok).toBe(true);
      expect(json.intent?.version).toBe(1);
    } else {
      expect(json.ok).toBe(false);
      expect(json.reason).toBeTruthy();
      // ผู้ใช้ต้องรู้เสมอว่าทำอะไรต่อได้ ไม่ใช่เจอ error เปล่า ๆ
      expect(json.manualPath).toBeTruthy();
    }
  });

  test("body ที่ผิดรูปถูกปฏิเสธก่อนถึงผู้ให้บริการ", async ({ page }) => {
    await loginOwner(page);

    for (const bad of [
      { requestId: "short", utterance: "ลาเต้", locale: "th-TH", origin: "push_to_talk" },
      { requestId: "voice-e2e-00000001", utterance: "", locale: "th-TH", origin: "push_to_talk" },
      { requestId: "voice-e2e-00000001", utterance: "ลาเต้", locale: "ja-JP", origin: "push_to_talk" },
      { requestId: "voice-e2e-00000001", utterance: "ลาเต้", locale: "th-TH", origin: "standby" },
      { requestId: "voice-e2e-00000001", utterance: "ลาเต้", locale: "th-TH", origin: "push_to_talk", extra: 1 },
    ]) {
      const response = await page.request.post("/api/ai/voice-intent", { data: bad });
      expect(response.status(), JSON.stringify(bad)).toBe(400);
      expect(response.headers()["cache-control"]).toBe("no-store");
    }
  });
});

test.describe("AI voice intent — หน้า POS", () => {
  test("ร้านที่เปิด flag ยังเห็นปุ่มสั่งงานด้วยเสียง", async ({ page }) => {
    await loginOwner(page);
    await page.goto("/pos");
    await expect(page.getByTestId("voice-mic")).toBeVisible({ timeout: 20_000 });
    // แผงคิวต้องยังไม่โผล่จนกว่าจะมีคำสั่งหลายรายการจริง
    await expect(page.getByTestId("voice-command-queue")).toHaveCount(0);
    // หลักฐานภาพของรอบนี้ (ไม่ใช่ screenshot ตอน fail)
    await page.screenshot({ path: "artifacts/voice-ai-phase1/e2e/pos-voice-button.png" });
  });
});
