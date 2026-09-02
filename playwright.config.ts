import { defineConfig } from "@playwright/test";
import { readLocalSupabaseStatusEnv } from "./tests/e2e/helpers/local-supabase-env";

// U0.5 — Playwright config สำหรับ e2e (U9 เพิ่ม unified-pos.spec.ts)
// หมายเหตุ: tests/e2e/** ถูก exclude จาก vitest discovery แล้ว (ดู vitest.config.ts)
// U9 — ใช้ production server (`next start`) แทน `next dev` เสมอ เพราะ Next 16 ล็อค
// 1 dev server ต่อ 1 project dir — ถ้ามี next dev ของโปรเจคนี้รันอยู่แล้ว (เช่น
// นักพัฒนาเปิดไว้เอง) ตัวใหม่จะถูก Next ปฏิเสธทั้งที่ config ถูก ส่วน `next start`
// ไม่มี lock นี้ PLAYWRIGHT_DEV_URL ยังใช้ override URL ปลายทางได้ (default port 3100)
const devServerUrl = process.env.PLAYWRIGHT_DEV_URL ?? "http://127.0.0.1:3100";

// ── U9 · E2E SAFETY (fail-closed, non-negotiable) ─────────────────────────────
// .env/.env.local ของแอปชี้ REMOTE Supabase — e2e ห้ามชน remote จึง build env ของ
// dev server จาก "supabase status -o env" ตอน config-load เสมอ (map ด้านล่าง)
// ถ้า supabase CLI/stack ไม่พร้อม → throw ที่นี่ ทดสอบทั้งชุดไม่เริ่ม — ไม่มี fallback ไป remote
const localSupabase = readLocalSupabaseStatusEnv();

// ให้ test process (workers) ใช้ env ชุด local เดียวกันเมื่อสร้าง fixture client (beforeAll)
process.env.NEXT_PUBLIC_SUPABASE_URL = localSupabase.apiUrl;
process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = localSupabase.publishableKey;
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = localSupabase.publishableKey;
process.env.SUPABASE_SERVICE_ROLE_KEY = localSupabase.serviceRoleKey;

// คัดเฉพาะค่าที่เป็น string (webServer.env ต้องเป็น Record<string, string>)
const webServerEnv: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) {
  if (typeof value === "string") webServerEnv[key] = value;
}
// local เสมอ — วางทับท้ายเพื่อชนะ shell env ที่อาจชี้ remote (ไม่ fallback)
webServerEnv.NEXT_PUBLIC_SUPABASE_URL = localSupabase.apiUrl;
// แอปอ่าน NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY — ตั้งเป็นชื่อหลัก + ANON_KEY ตาม brief เป็น alias
webServerEnv.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = localSupabase.publishableKey;
webServerEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY = localSupabase.publishableKey;
webServerEnv.SUPABASE_SERVICE_ROLE_KEY = localSupabase.serviceRoleKey;

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  reporter: [["list"]],
  use: {
    baseURL: devServerUrl,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" },
    },
  ],
  webServer: {
    // U9 — production server แบบ deterministic: build ใหม่ทุก run (~40s) แล้ว start
    // เลือกทางนี้แทน guard ".next/BUILD_ID หายค่อย build" เพราะ deterministic กว่า
    // (ไม่ต้องเชื่อ BUILD_ID เก่าจาก build ที่ env คนละชุด) และ build ที่รันผ่าน
    // webServer.env ด้านล่างจะ bake NEXT_PUBLIC_* ของ local stack ลง client bundle เสมอ
    // (ถ้า build เองนอก config ต้อง export env local ด้วย ไม่งั้น .env.local ชี้ remote)
    command: "npm run build && npx next start --port 3100",
    // Playwright ห้ามระบุ port พร้อม url — ใช้ url (รวม port 3100 แล้ว) สำหรับ health probe
    url: devServerUrl,
    reuseExistingServer: !process.env.CI,
    // เผื่อ build + cold start บนเครื่อง Windows นานๆ
    timeout: 300_000,
    // ให้ log ของ dev server โชว์ตอน boot fail (debug ง่ายแทน timeout เงียบๆ)
    stdout: "pipe",
    stderr: "pipe",
    env: webServerEnv,
  },
});
