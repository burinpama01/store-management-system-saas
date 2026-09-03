import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const css = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");

/**
 * Tailwind v4 วาง utility ของตัวเองไว้ใน `@layer utilities` — คลาสของโปรเจกต์ที่
 * "หน้าตาเป็นคอมโพเนนต์" ถ้าไปอยู่ layer เดียวกัน จะชนะ utility ที่เขียนกำกับไว้ใน
 * JSX เพราะอยู่หลังกว่าในซอร์ส ผลคือคลาสอย่าง `hidden` / `sm:inline-flex` ไม่ทำงาน
 * โดยไม่มีอะไรฟ้อง (อาการจริงที่เจอ: ป้าย badge ไม่ยอมซ่อนบนมือถือ)
 */
describe("ลำดับ layer ของ CSS — utility ที่เขียนใน JSX ต้องชนะเสมอ", () => {
  function layerOf(selector: string): string | null {
    const index = css.indexOf(`  ${selector} {`);
    if (index === -1) return null;
    const before = css.slice(0, index);
    const lastLayer = before.lastIndexOf("@layer ");
    if (lastLayer === -1) return null;
    const declared = css.slice(lastLayer).match(/^@layer\s+([a-z]+)/);
    return declared ? declared[1] : null;
  }

  it("คลาส badge อยู่ใน @layer components ไม่ใช่ utilities", () => {
    for (const selector of [".badge", ".badge-success", ".badge-warning", ".badge-danger", ".badge-brand"]) {
      expect(layerOf(selector)).toBe("components");
    }
  });

  it("badge ยังตั้ง display ไว้ (ถ้าไม่ตั้ง การย้าย layer ก็ไม่มีความหมาย)", () => {
    const badgeBlock = css.slice(css.indexOf("  .badge {"), css.indexOf("  .badge-success {"));
    expect(badgeBlock).toContain("display: inline-flex");
  });
});
