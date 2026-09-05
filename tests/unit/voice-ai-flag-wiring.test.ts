import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");

describe("AI fallback เป็นคันโยกแยกของตัวเอง", () => {
  it("มี migration เพิ่มคอลัมน์ใหม่ ค่าเริ่มต้นปิด", () => {
    const sql = read("supabase/migrations/20260905000007_voice_ai_fallback_flag.sql");
    expect(sql).toContain("add column if not exists voice_ai_fallback_enabled boolean not null default false");
    // deploy แล้วต้องไม่มีร้านไหนเปลี่ยนพฤติกรรมเอง
    expect(sql).not.toContain("default true");
    expect(sql).not.toMatch(/update\s+public\.stores/i);
  });

  it("ต้องเปิดทั้ง 2 flag ถึงจะยิง AI ได้ (ปิด AI แล้วเสียงเดิมยังใช้ได้)", () => {
    const page = read("src/app/pos/page.tsx");
    expect(page).toContain("voiceEnabled && (storeResult.data?.voiceAiFallbackEnabled ?? false)");
    expect(page).toContain("voiceAiFallbackEnabled={voiceAiFallbackEnabled}");
  });

  it("ส่งต่อถึง controller จริง", () => {
    const workspace = read("src/app/pos/unified/UnifiedPosWorkspace.tsx");
    expect(workspace).toContain("voiceAiFallbackEnabled = false");
    expect(workspace).toContain("aiFallbackEnabled={voiceAiFallbackEnabled}");
    // ปุ่มเสียงยังผูกกับ voiceEnabled ตัวเดิม ไม่ใช่ตัวใหม่
    expect(workspace).toContain("{voiceEnabled ? (");
  });

  it("controller ปิด AI เป็นค่าเริ่มต้น และไม่ยิงเมื่อปิด", () => {
    const controller = read("src/app/pos/unified/VoicePosController.tsx");
    expect(controller).toContain("aiFallbackEnabled = false");
    // เงื่อนไขยิง AI ต้องมีทั้ง flag ของ AI และของเสียง
    expect(controller).toContain("aiFallbackEnabled && voiceEnabled && result.resultCode === \"no_match\"");
  });

  it("หน้าตั้งค่าบอกสถานะให้ร้านเห็นว่าเปิด/ปิดอยู่", () => {
    const manager = read("src/app/(dashboard)/settings/voice/VoiceAliasManager.tsx");
    expect(manager).toContain("aiFallbackEnabled");
    expect(manager).toContain("ทางสำรอง AI");
    const page = read("src/app/(dashboard)/settings/voice/page.tsx");
    expect(page).toContain("aiFallbackEnabled={storeRes.data?.voiceAiFallbackEnabled ?? false}");
  });

  it("store repository อ่านคอลัมน์ใหม่ทั้งฝั่ง dashboard และ public", () => {
    for (const path of ["src/modules/stores/repository.ts", "src/modules/stores/public-repository.ts"]) {
      expect(read(path)).toContain("voiceAiFallbackEnabled: row.voice_ai_fallback_enabled ?? false");
    }
  });
});
