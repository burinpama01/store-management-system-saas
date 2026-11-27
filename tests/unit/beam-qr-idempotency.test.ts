import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// พบจากทดสอบจริง 2026-11-27 (W-E34AF4): หน้าสั่ง + หน้าติดตามสร้าง QR พร้อมกัน → รอบสองโดน Beam 412
// "same idempotency key ... different payload" แล้วรายการถูกตั้ง FAILED ทั้งที่ QR รอบแรกใช้ได้
const src = readFileSync("src/modules/payments/beam-service.ts", "utf8");
const create = src.slice(src.indexOf("export async function createBeamQrPayment"), src.indexOf("export async function refreshBeamPayment"));

describe("createBeamQrPayment — กดซ้ำ/เรียกพร้อมกันไม่ทำให้ QR ที่ใช้ได้กลายเป็น FAILED", () => {
  it("มี charge + payload แล้ว → คืน QR เดิม ไม่ยิง Beam ซ้ำ", () => {
    const reuse = create.indexOf("if (row.provider_payment_id && row.injected_emv_payload) {");
    expect(reuse).toBeGreaterThan(0);
    expect(reuse).toBeLessThan(create.indexOf("const charge = await createBeamQrCharge({"));
  });

  it("retry ส่ง expiresAt เดิมที่ส่งให้ Beam (requestedExpiresAt) ไม่ใช่ค่าที่ Beam ตอบกลับ", () => {
    expect(create).toContain("requestedExpiresAt: expiresAt,");
    expect(create).toContain('typeof row.metadata?.requestedExpiresAt === "string"');
  });

  it("Beam ล้มแต่อีกคำขอสร้างสำเร็จไปแล้ว → ใช้ QR นั้น ไม่ตั้ง FAILED", () => {
    const fail = create.indexOf("if (!charge.ok) {");
    const winner = create.indexOf("if (winner?.provider_payment_id && winner.injected_emv_payload", fail);
    const markFailed = create.indexOf('status: "FAILED"', fail);
    expect(winner).toBeGreaterThan(fail);
    expect(winner).toBeLessThan(markFailed);
  });
});
