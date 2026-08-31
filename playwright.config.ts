import { defineConfig } from "@playwright/test";

// U0.5 — Playwright config สำหรับ e2e (task นี้มี smoke เดียว)
// หมายเหตุ: tests/e2e/** ถูก exclude จาก vitest discovery แล้ว (ดู vitest.config.ts)
// Next 16 ล็อค 1 dev server ต่อ 1 project dir — ถ้ามี next dev ของโปรเจคนี้รันอยู่แล้ว
// (เช่น นักพัฒนาเปิดไว้เอง) ตัวใหม่จะถูก Next ปฏิเสธ ให้ชี้ PLAYWRIGHT_DEV_URL ไปที่
// server ที่รันอยู่แทน (playwright จะ reuse ไม่ spawn ใหม่) — default ยังเป็น port 3100
const devServerUrl = process.env.PLAYWRIGHT_DEV_URL ?? "http://127.0.0.1:3100";

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
    command: "npm run dev -- --port 3100",
    // Playwright ห้ามระบุ port พร้อม url — ใช้ url (รวม port 3100 แล้ว) สำหรับ health probe
    url: devServerUrl,
    reuseExistingServer: !process.env.CI,
    // เผื่อ Next dev cold start บนเครื่อง Windows นานๆ
    timeout: 300_000,
    // ให้ log ของ dev server โชว์ตอน boot fail (debug ง่ายแทน timeout เงียบๆ)
    stdout: "pipe",
    stderr: "pipe",
  },
});
