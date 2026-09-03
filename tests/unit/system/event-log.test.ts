import { describe, expect, it } from "vitest";
import { buildLogFingerprint, buildSystemLogRow, describeError } from "@/modules/system/event-log";
import { buildAiLogReport, shiftDay, todayInBangkok } from "@/modules/system/event-log-repository";
import type { SystemLogDay } from "@/modules/system/event-log-repository";

describe("buildSystemLogRow", () => {
  it("ตัดคีย์อ่อนไหวออกจาก context ทุกชั้น", () => {
    const row = buildSystemLogRow({
      level: "error",
      source: "pos.payment",
      action: "collectPaymentAction",
      message: "จ่ายเงินไม่สำเร็จ",
      context: {
        orderId: "abc",
        accessToken: "super-secret",
        headers: { Authorization: "Bearer x", "x-request": "ok" },
      },
    });

    const context = row.context as Record<string, unknown>;
    expect(context.orderId).toBe("abc");
    expect(context.accessToken).toBe("[ปกปิด]");
    expect((context.headers as Record<string, unknown>).Authorization).toBe("[ปกปิด]");
    expect((context.headers as Record<string, unknown>)["x-request"]).toBe("ok");
  });

  it("ตัดข้อความยาวเพื่อไม่ให้ log กลายเป็นที่เก็บ payload", () => {
    const row = buildSystemLogRow({
      level: "info",
      source: "s",
      action: "a",
      message: "x".repeat(900),
      context: { blob: "y".repeat(900) },
    });
    expect(row.message.length).toBe(500);
    expect(String((row.context as Record<string, unknown>).blob)).toHaveLength(301);
  });

  it("ปัดเศษ duration และกันค่าติดลบ", () => {
    expect(buildSystemLogRow({ level: "info", source: "s", action: "a", message: "m", durationMs: 12.6 }).duration_ms).toBe(13);
    expect(buildSystemLogRow({ level: "info", source: "s", action: "a", message: "m", durationMs: -5 }).duration_ms).toBe(0);
    expect(buildSystemLogRow({ level: "info", source: "s", action: "a", message: "m" }).duration_ms).toBeNull();
  });
});

describe("buildLogFingerprint", () => {
  const base = { level: "error" as const, source: "pos", action: "pay", errorCode: "23505" };

  it("ปัญหาเดียวกันที่ต่างกันแค่ id/ตัวเลข ต้องได้ fingerprint เดียวกัน", () => {
    const a = buildLogFingerprint({ ...base, message: "order 3f1a2b4c-1111-2222-3333-444455556666 ล้มเหลว 3 ครั้ง" });
    const b = buildLogFingerprint({ ...base, message: "order 9c8d7e6f-9999-8888-7777-666655554444 ล้มเหลว 91 ครั้ง" });
    expect(a).toBe(b);
  });

  it("คนละอาการต้องได้คนละ fingerprint", () => {
    const a = buildLogFingerprint({ ...base, message: "ตัดสต็อกไม่สำเร็จ" });
    const b = buildLogFingerprint({ ...base, message: "ปิดรอบเงินสดไม่สำเร็จ" });
    expect(a).not.toBe(b);
  });
});

describe("describeError", () => {
  it("ดึงรหัสจาก error ของฐานข้อมูล", () => {
    expect(describeError({ code: "23505", message: "duplicate key" })).toEqual({
      message: "duplicate key",
      errorCode: "23505",
    });
  });

  it("รับค่าที่ไม่ใช่ Error ได้โดยไม่พัง", () => {
    expect(describeError("พังเฉย ๆ").message).toBe("พังเฉย ๆ");
    expect(describeError(null).errorCode).toBeNull();
  });
});

describe("shiftDay", () => {
  it("ข้ามเดือน/ปีได้ถูกต้อง", () => {
    expect(shiftDay("2026-03-01", -1)).toBe("2026-02-28");
    expect(shiftDay("2026-12-31", 1)).toBe("2027-01-01");
  });
});

describe("todayInBangkok", () => {
  it("ใช้วันตามเวลาไทย ไม่ใช่ UTC", () => {
    // 2026-09-03T18:30Z = 2026-09-04 01:30 เวลาไทย → ต้องได้วันที่ 4
    expect(todayInBangkok(new Date("2026-09-03T18:30:00Z"))).toBe("2026-09-04");
  });
});

describe("buildAiLogReport", () => {
  const day: SystemLogDay = {
    day: "2026-09-03",
    counts: { error: 5, warn: 1, info: 0 },
    groups: [
      {
        fingerprint: "pos.payment:pay:abc",
        level: "error",
        source: "pos.payment",
        action: "collectPaymentAction",
        errorCode: "23505",
        message: "ตัดสต็อกซ้ำ",
        occurrences: 5,
        firstAt: "2026-09-03T01:00:00Z",
        lastAt: "2026-09-03T02:00:00Z",
        storeCount: 2,
        sampleContext: { orderId: "x" },
      },
    ],
    recent: [],
  };

  it("บอกจำนวน ระดับ จุดที่เกิด และ context ให้ AI ครบในข้อความเดียว", () => {
    const report = buildAiLogReport(day);
    expect(report).toContain("2026-09-03");
    expect(report).toContain("errors=5");
    expect(report).toContain("[ERROR] pos.payment → collectPaymentAction");
    expect(report).toContain("ครั้ง: 5");
    expect(report).toContain('{"orderId":"x"}');
  });

  it("บอกชัดเมื่อไม่มีเหตุการณ์", () => {
    const report = buildAiLogReport({ day: "2026-09-02", counts: { error: 0, warn: 0, info: 0 }, groups: [], recent: [] });
    expect(report).toContain("ไม่มีเหตุการณ์ในวันนี้");
  });
});
