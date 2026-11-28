import { describe, expect, it } from "vitest";
import {
  DEFAULT_ORDERING_HOURS,
  PAUSE_INDEFINITE_ISO,
  describeAvailability,
  evaluateOrderingAvailability,
  formatReopenAt,
  orderingHoursSchema,
  parseOrderingHours,
  pauseUntilFor,
  type OrderingHours,
} from "@/modules/online-orders/hours";

const TZ = "Asia/Bangkok";
// เวลาไทย → instant (UTC+7)
const bkk = (wall: string) => new Date(`${wall}:00+07:00`);

function hours(partial: Partial<OrderingHours> = {}): OrderingHours {
  return {
    enabled: true,
    weekly: Array.from({ length: 7 }, () => ({ closed: false, open: "09:00", close: "21:00" })),
    exceptions: [],
    ...partial,
  };
}
const sched = (h: OrderingHours, pausedUntil: string | null = null, pausedReason: string | null = null) => ({ hours: h, pausedUntil, pausedReason });

// 2026-12-01 = อังคาร
describe("evaluateOrderingAvailability", () => {
  it("ไม่ใช้เวลาทำการ = เปิดตลอด (พฤติกรรมเดิม)", () => {
    expect(evaluateOrderingAvailability(sched(DEFAULT_ORDERING_HOURS), bkk("2026-12-01T03:00"), TZ)).toEqual({ open: true, closesAt: null });
  });

  it("ในเวลา = เปิด พร้อมเวลาปิด", () => {
    const a = evaluateOrderingAvailability(sched(hours()), bkk("2026-12-01T12:00"), TZ);
    expect(a).toEqual({ open: true, closesAt: bkk("2026-12-01T21:00").toISOString() });
  });

  it("ก่อนเปิด = ปิด และบอกเวลาเปิดวันนี้", () => {
    const a = evaluateOrderingAvailability(sched(hours()), bkk("2026-12-01T07:30"), TZ);
    expect(a.open).toBe(false);
    if (!a.open) {
      expect(a.reason).toBe("outside_hours");
      expect(a.reopensAt).toBe(bkk("2026-12-01T09:00").toISOString());
    }
  });

  it("หลังปิด = เปิดอีกครั้งพรุ่งนี้ ข้ามวันหยุดประจำสัปดาห์", () => {
    const h = hours();
    h.weekly[3] = { closed: true, open: "09:00", close: "21:00" }; // พุธหยุด
    const a = evaluateOrderingAvailability(sched(h), bkk("2026-12-01T22:00"), TZ);
    expect(!a.open && a.reopensAt).toBe(bkk("2026-12-03T09:00").toISOString());
  });

  it("เวลาข้ามเที่ยงคืน 18:00–02:00 ยังเปิดตอนตีหนึ่งของวันถัดไป", () => {
    const h = hours({ weekly: Array.from({ length: 7 }, () => ({ closed: false, open: "18:00", close: "02:00" })) });
    const a = evaluateOrderingAvailability(sched(h), bkk("2026-12-02T01:00"), TZ);
    expect(a).toEqual({ open: true, closesAt: bkk("2026-12-02T02:00").toISOString() });
  });

  it("09:00–00:00 = ถึงเที่ยงคืน", () => {
    const h = hours({ exceptions: [{ date: "2026-12-01", closed: false, open: "09:00", close: "00:00", note: "OT" }] });
    const a = evaluateOrderingAvailability(sched(h), bkk("2026-12-01T23:30"), TZ);
    expect(a).toEqual({ open: true, closesAt: bkk("2026-12-02T00:00").toISOString() });
  });

  it("เปิด = ปิด = 24 ชม. และรวมหลายวันต่อเนื่อง", () => {
    const h = hours({ weekly: Array.from({ length: 7 }, () => ({ closed: false, open: "00:00", close: "00:00" })) });
    const a = evaluateOrderingAvailability(sched(h), bkk("2026-12-01T12:00"), TZ);
    // เปิดยาวเกิน 24 ชม. ไม่บอกเวลาปิด
    expect(a).toEqual({ open: true, closesAt: null });
  });

  it("วันหยุดเฉพาะวันชนะเวลาประจำสัปดาห์ และแสดงหมายเหตุ", () => {
    const h = hours({ exceptions: [{ date: "2026-12-01", closed: true, open: "09:00", close: "21:00", note: "หยุดประจำปี" }] });
    const a = evaluateOrderingAvailability(sched(h), bkk("2026-12-01T12:00"), TZ);
    expect(a).toEqual({ open: false, reason: "outside_hours", message: "หยุดประจำปี", reopensAt: bkk("2026-12-02T09:00").toISOString() });
  });

  it("ปิดด่วนชนะเวลาทำการ และบอกเหตุผล + เวลาเปิดกลับ", () => {
    const now = bkk("2026-12-01T12:00");
    const a = evaluateOrderingAvailability(sched(hours(), bkk("2026-12-01T13:00").toISOString(), "ไฟดับ"), now, TZ);
    expect(a).toEqual({ open: false, reason: "paused", message: "ไฟดับ", reopensAt: bkk("2026-12-01T13:00").toISOString() });
  });

  it("ปิดด่วนเลยเวลาปิดร้าน = เปิดกลับตามเวลาเปิดรอบถัดไป", () => {
    const a = evaluateOrderingAvailability(sched(hours(), bkk("2026-12-01T22:00").toISOString()), bkk("2026-12-01T20:30"), TZ);
    expect(!a.open && a.reopensAt).toBe(bkk("2026-12-02T09:00").toISOString());
  });

  it("ปิดด่วนจนกว่าจะกดเปิด = ไม่มีเวลาเปิดกลับ", () => {
    const a = evaluateOrderingAvailability(sched(DEFAULT_ORDERING_HOURS, PAUSE_INDEFINITE_ISO), bkk("2026-12-01T12:00"), TZ);
    expect(a).toEqual({ open: false, reason: "paused", message: null, reopensAt: null });
  });

  it("ปิดด่วนหมดเวลาแล้ว = กลับไปใช้เวลาปกติ", () => {
    const a = evaluateOrderingAvailability(sched(hours(), bkk("2026-12-01T11:00").toISOString()), bkk("2026-12-01T12:00"), TZ);
    expect(a.open).toBe(true);
  });

  it("ทุกวันหยุด = ปิดและไม่มีเวลาเปิดกลับ", () => {
    const h = hours({ weekly: Array.from({ length: 7 }, () => ({ closed: true, open: "09:00", close: "21:00" })) });
    const a = evaluateOrderingAvailability(sched(h), bkk("2026-12-01T12:00"), TZ);
    expect(a).toEqual({ open: false, reason: "outside_hours", message: null, reopensAt: null });
  });
});

describe("pauseUntilFor", () => {
  const now = bkk("2026-12-01T12:00");
  it("นาที/ชั่วโมง", () => {
    expect(pauseUntilFor("30m", sched(hours()), now, TZ)).toBe(bkk("2026-12-01T12:30").toISOString());
    expect(pauseUntilFor("2h", sched(hours()), now, TZ)).toBe(bkk("2026-12-01T14:00").toISOString());
  });
  it("ถึงสิ้นวันนี้ = เวลาปิดของรอบนี้", () => {
    expect(pauseUntilFor("today", sched(hours()), now, TZ)).toBe(bkk("2026-12-01T21:00").toISOString());
  });
  it("ถึงสิ้นวันนี้ แบบไม่ใช้เวลาทำการ = เที่ยงคืน", () => {
    expect(pauseUntilFor("today", sched(DEFAULT_ORDERING_HOURS), now, TZ)).toBe(bkk("2026-12-02T00:00").toISOString());
  });
  it("จนกว่าจะกดเปิด", () => {
    expect(pauseUntilFor("indefinite", sched(hours()), now, TZ)).toBe(PAUSE_INDEFINITE_ISO);
  });
});

describe("schema + ข้อความ", () => {
  it("ข้อมูลเสีย = ไม่ใช้เวลาทำการ (ไม่ปิดร้านเพราะอ่านไม่ออก)", () => {
    expect(parseOrderingHours({ enabled: true, weekly: [] })).toEqual(DEFAULT_ORDERING_HOURS);
    expect(parseOrderingHours(null)).toEqual(DEFAULT_ORDERING_HOURS);
  });
  it("วันที่ซ้ำไม่ผ่าน", () => {
    const ex = { date: "2026-12-01", closed: true, open: "09:00", close: "21:00", note: "" };
    expect(orderingHoursSchema.safeParse(hours({ exceptions: [ex, ex] })).success).toBe(false);
  });
  it("วันที่ไม่มีในปฏิทินไม่ผ่าน", () => {
    const ex = { date: "2026-02-30", closed: true, open: "09:00", close: "21:00", note: "" };
    expect(orderingHoursSchema.safeParse(hours({ exceptions: [ex] })).success).toBe(false);
  });
  it("ปิดยาว 20 วันยังบอกวันเปิดกลับได้", () => {
    const h = hours({
      weekly: Array.from({ length: 7 }, () => ({ closed: true, open: "09:00", close: "21:00" })),
      exceptions: [{ date: "2026-12-21", closed: false, open: "10:00", close: "20:00", note: "" }],
    });
    const a = evaluateOrderingAvailability(sched(h), bkk("2026-12-01T12:00"), TZ);
    expect(!a.open && a.reopensAt).toBe(bkk("2026-12-21T10:00").toISOString());
  });
  it("เวลาเกิน 23:59 ไม่ผ่าน", () => {
    const h = hours();
    h.weekly[0] = { closed: false, open: "24:00", close: "21:00" };
    expect(orderingHoursSchema.safeParse(h).success).toBe(false);
  });
  it("formatReopenAt วันนี้/พรุ่งนี้", () => {
    const now = bkk("2026-12-01T12:00");
    expect(formatReopenAt(bkk("2026-12-01T18:00").toISOString(), now, TZ)).toBe("วันนี้ 18:00");
    expect(formatReopenAt(bkk("2026-12-02T09:00").toISOString(), now, TZ)).toBe("พรุ่งนี้ 09:00");
  });
  it("describeAvailability รวมเหตุผลกับเวลาเปิด", () => {
    const now = bkk("2026-12-01T12:00");
    const d = describeAvailability({ open: false, reason: "paused", message: "ไฟดับ", reopensAt: bkk("2026-12-01T13:00").toISOString() }, now, TZ);
    expect(d).toEqual({ title: "ร้านปิดรับออเดอร์ชั่วคราว", detail: "ไฟดับ · เปิดรับอีกครั้ง วันนี้ 13:00" });
  });
});
