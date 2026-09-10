import { describe, expect, it } from "vitest";
import {
  baht,
  buildDailySummaryEmail,
  buildDailySummaryMessage,
  buildDailySummaryText,
  formatSummaryDate,
  NOTIFICATION_MESSAGE_MAX_LENGTH,
  totalsOfStores,
  type StoreDailySummary,
} from "@/modules/reports/daily-summary";
import { previousLocalDate } from "@/modules/reports/daily-summary-runner";
import { storeDayWindowUtc } from "@/modules/reports/daily-summary-repository";

function store(overrides: Partial<StoreDailySummary> = {}): StoreDailySummary {
  return {
    storeId: "store-1",
    storeName: "each other home&cafe",
    orderCount: 12,
    revenue: 3450,
    avgOrderValue: 287.5,
    posOrderCount: 9,
    qrOrderCount: 2,
    deliveryOrderCount: 1,
    voidedCount: 0,
    paymentMethods: [
      { method: "cash", count: 8, amount: 2100 },
      { method: "qr_promptpay", count: 4, amount: 1350 },
    ],
    topProducts: [
      { name: "กาแฟเย็น", quantity: 9, revenue: 540 },
      { name: "ชาเย็น", quantity: 5, revenue: 275 },
    ],
    ...overrides,
  };
}

describe("buildDailySummaryMessage (LINE/Telegram)", () => {
  it("บอกยอดขาย จำนวนบิล ช่องทาง การชำระ และเมนูขายดี", () => {
    const message = buildDailySummaryMessage(store(), "2026-09-08", { trigger: "สมชาย ออกงานแล้ว" });

    expect(message).toContain("฿3,450.00");
    expect(message).toContain("12 บิล");
    expect(message).toContain("POS 9");
    expect(message).toContain("QR 2");
    expect(message).toContain("เดลิเวอรี 1");
    expect(message).toContain("เงินสด");
    expect(message).toContain("กาแฟเย็น");
    expect(message).toContain("สมชาย ออกงานแล้ว");
  });

  it("ไม่โชว์ช่องทางที่ไม่มีบิลเลย", () => {
    const message = buildDailySummaryMessage(
      store({ qrOrderCount: 0, deliveryOrderCount: 0 }),
      "2026-09-08",
    );
    const channelLine = message.split("\n").find((line) => line.startsWith("ช่องทาง:"));
    expect(channelLine).toBe("ช่องทาง: POS 9");
    expect(message).not.toContain("เดลิเวอรี");
  });

  it("บอกจำนวนบิลที่ถูกยกเลิกเมื่อมี", () => {
    expect(buildDailySummaryMessage(store({ voidedCount: 2 }), "2026-09-08")).toContain("ยกเลิก/คืนเงิน 2 บิล");
    expect(buildDailySummaryMessage(store(), "2026-09-08")).not.toContain("ยกเลิก/คืนเงิน");
  });

  // dispatcher ปฏิเสธข้อความยาวเกิน 1000 ทั้งก้อน — ยาวเกินแปลว่า "ไม่ได้ส่งเลย" ไม่ใช่ "ส่งแบบสั้น"
  it("ไม่ยาวเกินเพดานที่ dispatcher ยอมรับ แม้ชื่อเมนูจะยาวผิดปกติ", () => {
    const message = buildDailySummaryMessage(
      store({
        paymentMethods: Array.from({ length: 20 }, (_, i) => ({
          method: `วิธีชำระที่ยาวมากจริง ๆ หมายเลข ${i}`,
          count: 1,
          amount: 100,
        })),
        topProducts: Array.from({ length: 20 }, (_, i) => ({
          name: `เมนูชื่อยาวมากจนน่าตกใจ ${"ก".repeat(60)} ${i}`,
          quantity: 1,
          revenue: 10,
        })),
      }),
      "2026-09-08",
    );
    expect(message.length).toBeLessThanOrEqual(NOTIFICATION_MESSAGE_MAX_LENGTH);
  });
});

describe("อีเมลสรุปรายวัน", () => {
  it("หัวข้ออีเมลบอกวันที่ ยอดรวม และจำนวนบิล", () => {
    const email = buildDailySummaryEmail({
      organizationId: "org-1",
      organizationName: "Each Other",
      date: "2026-09-08",
      stores: [store()],
      orderCount: 12,
      revenue: 3450,
    });

    expect(email.subject).toContain("฿3,450.00");
    expect(email.subject).toContain("12 บิล");
    expect(email.html).toContain("each other home&amp;cafe");
    expect(email.html).toContain("Each Other");
    expect(email.text).toContain("each other home&cafe");
  });

  it("แยกการ์ดต่อร้านเมื่อองค์กรมีหลายสาขาที่ขายได้", () => {
    const text = buildDailySummaryText({
      organizationId: "org-1",
      organizationName: "Each Other",
      date: "2026-09-08",
      stores: [store(), store({ storeId: "store-2", storeName: "each other II", revenue: 1200, orderCount: 5 })],
      orderCount: 17,
      revenue: 4650,
    });

    expect(text).toContain("each other home&cafe");
    expect(text).toContain("each other II");
    expect(text).toContain("2 ร้านที่มีการขาย");
  });

  it("แสดงวันที่ของแต่ละสาขาเมื่อองค์กรมีร้านคนละ timezone", () => {
    const text = buildDailySummaryText({
      organizationId: "org-1",
      organizationName: "Global Shop",
      date: "2026-09-08",
      stores: [
        store({ storeName: "Bangkok", date: "2026-09-08" }),
        store({ storeId: "store-2", storeName: "Los Angeles", date: "2026-09-07" }),
      ],
      orderCount: 24,
      revenue: 6900,
    });

    expect(text).toMatch(/Bangkok.*8/);
    expect(text).toMatch(/Los Angeles.*7/);
  });

  it("หนีอักขระ HTML ในชื่อร้านไม่ให้แตกโครงอีเมล", () => {
    const email = buildDailySummaryEmail({
      organizationId: "org-1",
      organizationName: "<script>x</script>",
      date: "2026-09-08",
      stores: [store({ storeName: "<b>ร้าน</b>" })],
      orderCount: 12,
      revenue: 3450,
    });
    expect(email.html).not.toContain("<script>");
    expect(email.html).toContain("&lt;b&gt;ร้าน&lt;/b&gt;");
  });
});

describe("ตัวช่วยตัวเลข/วันที่", () => {
  it("รวมยอดหลายร้านแล้วปัดทศนิยม 2 ตำแหน่ง", () => {
    const totals = totalsOfStores([
      store({ revenue: 10.005, orderCount: 1 }),
      store({ revenue: 0.01, orderCount: 2 }),
    ]);
    expect(totals.orderCount).toBe(3);
    expect(totals.revenue).toBe(10.02);
  });

  it("แสดงเงินเป็นบาทสองตำแหน่งเสมอ", () => {
    expect(baht(0)).toBe("฿0.00");
    expect(baht(1234.5)).toBe("฿1,234.50");
  });

  it("อ่านวันที่เป็นวันไทยตามค่าที่คิด timezone มาแล้ว ไม่เลื่อนวันซ้ำ", () => {
    expect(formatSummaryDate("2026-09-08")).toContain("8");
  });
});

describe("ขอบเขตวันตามเวลาร้าน", () => {
  it("หนึ่งวันของร้านไทยเริ่ม 17:00Z ของวันก่อนหน้า", () => {
    const window = storeDayWindowUtc("2026-09-08", "Asia/Bangkok");
    expect(window?.startUtc).toBe("2026-09-07T17:00:00.000Z");
    expect(window?.endUtc).toBe("2026-09-08T17:00:00.000Z");
  });

  // cron รัน 09:00 ไทย ต้องสรุป "เมื่อวาน" ที่ปิดวันแล้ว ไม่ใช่วันที่ยังขายอยู่
  it("previousLocalDate คืนวันก่อนหน้าตามเวลาไทย", () => {
    expect(previousLocalDate(new Date("2026-09-09T02:00:00.000Z"), "Asia/Bangkok")).toBe("2026-09-08");
  });

  it("previousLocalDate ข้ามวันถูกต้องเมื่อ UTC ยังไม่ขึ้นวันใหม่แต่ไทยขึ้นแล้ว", () => {
    // 2026-09-08T17:30Z = 09-09 00:30 ตามเวลาไทย → เมื่อวานของร้านคือ 09-08
    expect(previousLocalDate(new Date("2026-09-08T17:30:00.000Z"), "Asia/Bangkok")).toBe("2026-09-08");
  });
});
