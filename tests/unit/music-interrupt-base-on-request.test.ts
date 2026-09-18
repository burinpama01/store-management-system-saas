import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// 2026-09-18 — ขอเพลงแล้วแทรกเพลงของร้านได้ทันที
// เครื่องเล่นเปลี่ยนเพลงตอน YouTube ยิง ENDED ร้านที่เปิดเพลงแบบ live จึงไม่มีวันเปลี่ยนเพลง
// คำขอของลูกค้าเลยค้างคิวถาวร — เพิ่มปุ่มให้ร้านเลือกได้ว่าจะตัดเพลงของร้านแล้วเล่นเพลงที่ขอเลย

describe("ปุ่มตั้งค่า: แทรกเพลงที่ลูกค้าขอทับเพลงของร้าน", () => {
  it("migration เพิ่มคอลัมน์ตั้งค่า (เปิดเป็นค่าเริ่มต้น) และคอลัมน์จำเพลงร้านที่ถูกแทรก", () => {
    const sql = readFileSync(
      "supabase/migrations/20260918010000_music_interrupt_base_on_request.sql",
      "utf8",
    );
    expect(sql).toContain("add column if not exists interrupt_base_on_request boolean not null default true");
    expect(sql).toContain("add column if not exists resume_base_video_id text");
    expect(sql).toContain("add column if not exists resume_base_title text");
  });

  it("ฟอร์มตั้งค่ามี checkbox และ action อ่านค่าไปบันทึก", () => {
    const form = readFileSync(
      "src/app/(dashboard)/settings/music-player/MusicPlayerSettingsForm.tsx",
      "utf8",
    );
    expect(form).toContain('name="interruptBaseOnRequest"');
    expect(form).toContain("defaultChecked={settings.interruptBaseOnRequest}");
    expect(form).toContain("disabled={!canEdit}");

    const action = readFileSync("src/app/(dashboard)/settings/music-player/actions.ts", "utf8");
    expect(action).toContain('formData.get("interruptBaseOnRequest") === "1"');
    expect(action).toContain("interruptBaseOnRequest,");
  });

  it("server action ส่งสถานะ interrupt/waitingOnBase ให้เครื่องเล่น", () => {
    const actions = readFileSync("src/app/player/[storeSlug]/actions.ts", "utf8");
    expect(actions).toContain("resolvePlayerInterrupt");
    expect(actions).toContain("waitingOnBase: decision.waitingOnBase");
    expect(actions).toContain("interruptedCurrent: opts.interrupted === true");
  });

  it("เครื่องเล่นแทรกทันทีเมื่อร้านเปิดไว้ และแทรกเองเมื่อเพลงของร้านเป็น live ที่ไม่มีวันจบ", () => {
    const app = readFileSync("src/app/player/[storeSlug]/PlayerApp.tsx", "utf8");
    expect(app).toContain("if (res.interrupt) void advanceRef.current({ interrupted: true });");
    expect(app).toContain("res.waitingOnBase && currentTrackNeverEnds()");
    // ตรวจจาก playhead จริง: เพลง live จะมี duration = 0 หรือเวลาเล่นวิ่งชนท้ายคลิปตลอด
    expect(app).toContain("p.getDuration()");
    expect(app).toContain("p.getCurrentTime()");
    // ข้ามเพลงเอง/เพลงจบเอง ไม่ใช่การแทรก — เพลงของร้านต้องไม่ถูกเอากลับมาเล่นซ้ำ
    expect(app).toContain("void advanceRef.current().finally(");
  });
});
