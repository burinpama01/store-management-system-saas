import { expect, test } from "@playwright/test";

// U0.5 — infrastructure smoke: dev server ต้อง boot และหน้าแรกต้องตอบกลับมีเนื้อหา
// app อาจ redirect ไป /login ตาม auth — Playwright follow redirect ให้แล้ว
// จึงยอมรับ redirect chain และตรวจว่า "หน้าสุดท้าย" ต้องตอบ OK

test("app boots: / ตอบกลับ 2xx/3xx ที่ลงท้าย OK และมีเนื้อหา", async ({ page }) => {
  const response = await page.goto("/");
  expect(response, "navigation ต้องได้ response จากหน้าสุดท้าย").not.toBeNull();

  // Playwright follow redirect chain ให้แล้ว — "หน้าสุดท้าย" ต้องจบด้วย 2xx (ok() = 200–299)
  const status = response!.status();
  expect(
    response!.ok(),
    `หน้าสุดท้าย (หลังตาม redirect) ควรตอบ 2xx OK (ได้ ${status})`
  ).toBeTruthy();

  const html = await page.content();
  expect(html.trim().length, "body ต้องมีเนื้อหา").toBeGreaterThan(0);
});
