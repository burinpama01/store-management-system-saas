import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const logged: Array<Record<string, unknown>> = [];
vi.mock("@/modules/system/event-log", () => ({
  logSystemEvent: async (input: Record<string, unknown>) => {
    logged.push(input);
  },
}));

const { sendTransactionalEmail, isEmailConfigured } = await import("@/modules/notifications/email");

/**
 * โมดูลนี้เคยคืน ok:true ตอนที่ยังไม่ได้ตั้งค่า Resend แล้วเงียบสนิท ผู้เรียกเดินต่อ
 * เหมือนส่งอีเมลแล้วทั้งที่ไม่มีอะไรออกไป — เป็นเส้นทาง "สำเร็จแบบเงียบ" ที่ร้าน
 * และผู้ดูแลหาสาเหตุเองไม่ได้เลย
 */
describe("ส่งอีเมล — ต้องมีร่องรอยทุกเส้นทาง", () => {
  const original = { key: process.env.RESEND_API_KEY, from: process.env.ENTERPRISE_FROM_EMAIL, from2: process.env.EMAIL_FROM };

  beforeEach(() => {
    logged.length = 0;
    delete process.env.RESEND_API_KEY;
    delete process.env.ENTERPRISE_FROM_EMAIL;
    delete process.env.EMAIL_FROM;
  });

  afterEach(() => {
    if (original.key) process.env.RESEND_API_KEY = original.key; else delete process.env.RESEND_API_KEY;
    if (original.from) process.env.ENTERPRISE_FROM_EMAIL = original.from; else delete process.env.ENTERPRISE_FROM_EMAIL;
    if (original.from2) process.env.EMAIL_FROM = original.from2; else delete process.env.EMAIL_FROM;
    vi.unstubAllGlobals();
  });

  it("ยังไม่ตั้งค่า = ข้าม แต่ต้องบันทึก warn ไว้เสมอ", async () => {
    expect(isEmailConfigured()).toBe(false);

    const result = await sendTransactionalEmail({ to: "a@b.com", subject: "ทดสอบ", html: "<p>hi</p>" });

    expect(result.skipped).toBe(true);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ level: "warn", source: "notifications.email" });
    expect(logged[0].message).toContain("ยังไม่ได้ตั้งค่า Resend");
  });

  it("ผู้ให้บริการปฏิเสธ → เก็บสาเหตุจริงลง log และคืน detail ให้ผู้ดูแลเห็น", async () => {
    process.env.RESEND_API_KEY = "test-key";
    process.env.ENTERPRISE_FROM_EMAIL = "no-reply@burindev.com";
    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify({ message: "The burindev.com domain is not verified" }), { status: 403 }),
    );

    const result = await sendTransactionalEmail({ to: "a@b.com", subject: "ทดสอบ", html: "<p>hi</p>" });

    expect(result.ok).toBe(false);
    expect(result.detail).toContain("not verified");
    expect(logged[0]).toMatchObject({ level: "error", errorCode: "403" });
    // เก็บแค่โดเมนผู้ส่ง ไม่เก็บอีเมลเต็ม
    expect(JSON.stringify(logged[0].context)).toContain("burindev.com");
    expect(JSON.stringify(logged[0].context)).not.toContain("no-reply@");
  });

  it("ส่งสำเร็จก็ต้องบันทึก ไม่ใช่เงียบเฉพาะตอนพลาด", async () => {
    process.env.RESEND_API_KEY = "test-key";
    process.env.ENTERPRISE_FROM_EMAIL = "no-reply@burindev.com";
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ id: "abc" }), { status: 200 }));

    const result = await sendTransactionalEmail({ to: "a@b.com", subject: "ทดสอบ", html: "<p>hi</p>" });

    expect(result.ok).toBe(true);
    expect(result.skipped).toBe(false);
    expect(logged[0]).toMatchObject({ level: "info", message: "ส่งอีเมลสำเร็จ" });
  });
});
