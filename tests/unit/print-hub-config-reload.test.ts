import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configFileStamp, hasCredentialChanged } from "../../scripts/print-hub.mjs";

/**
 * เครื่องร้าน 2026-09-05: Launcher เขียน config ใหม่แล้วสั่ง restart Scheduled Task
 * ถ้า restart ไม่ผ่าน agent จะยิง token เก่าจน 401 ตลอดไป ทั้งที่ token ที่ถูกต้อง
 * นอนอยู่ในไฟล์ข้าง ๆ — agent จึงต้องเห็นไฟล์เปลี่ยนแล้วโหลดเอง
 */
describe("agent อ่าน config ใหม่เมื่อไฟล์เปลี่ยน", () => {
  it("ลายเซ็นไฟล์เปลี่ยนเมื่อเนื้อหาเปลี่ยน และเป็น null เมื่อไม่มีไฟล์", () => {
    const dir = mkdtempSync(join(tmpdir(), "hubcfg-"));
    const path = join(dir, "print-hub.config.json");
    try {
      expect(configFileStamp(path)).toBeNull();

      writeFileSync(path, JSON.stringify({ hubToken: "เก่า" }));
      const first = configFileStamp(path);
      expect(first).not.toBeNull();

      // ขนาดต่างกันจึงจับได้แน่นอนแม้ mtime ของ filesystem จะหยาบ
      writeFileSync(path, JSON.stringify({ hubToken: "โทเคนใหม่ที่ยาวกว่าเดิม" }));
      expect(configFileStamp(path)).not.toBe(first);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("นับว่าเปลี่ยนเฉพาะตอน credential ต่างจริง", () => {
    const base = { serverUrl: "https://a.test", storeId: "s1", hubToken: "t1", pollIntervalMs: 2500 };
    expect(hasCredentialChanged(base, { ...base })).toBe(false);
    // แค่รอบ poll เปลี่ยน ไม่ใช่เรื่องต้องประกาศ
    expect(hasCredentialChanged(base, { ...base, pollIntervalMs: 5000 })).toBe(false);
    expect(hasCredentialChanged(base, { ...base, hubToken: "t2" })).toBe(true);
    expect(hasCredentialChanged(base, { ...base, storeId: "s2" })).toBe(true);
    expect(hasCredentialChanged(base, { ...base, serverUrl: "https://b.test" })).toBe(true);
  });
});
