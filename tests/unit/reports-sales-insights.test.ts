import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  bangkokToday,
  breakEvenRevenuePerDay,
  buildRecommendations,
  categoryTotals,
  grossProfit,
  parseInsights,
  percentChange,
  productRows,
  resolveInsightsRange,
  stackedCategorySeries,
  OTHER_CATEGORY_KEY,
  type InsightsProduct,
  type InsightsRaw,
} from "@/modules/reports/insights";

const product = (over: Partial<InsightsProduct>): InsightsProduct => ({
  productId: "p",
  name: "เมนู",
  categoryId: "c1",
  categoryName: "หมวด 1",
  qty: 1,
  revenue: 100,
  orders: 1,
  cost: null,
  costedRevenue: 0,
  ...over,
});

const base = (over: Partial<InsightsRaw> = {}): InsightsRaw => ({
  range: { from: "2026-11-01", to: "2026-11-07", days: 7, prevFrom: "2026-10-25", prevTo: "2026-10-31" },
  summary: { orders: 10, revenue: 1000, discount: 0, memberOrders: 5, items: 20 },
  prevSummary: { orders: 10, revenue: 1000, discount: 0, memberOrders: 5, items: 20 },
  daily: [],
  hourly: [],
  products: [],
  prevProducts: [],
  categoryDaily: [],
  channels: { pos: { orders: 0, revenue: 0 }, qr: { orders: 0, revenue: 0 }, delivery: { orders: 0, revenue: 0 } },
  payments: [],
  idleProducts: [],
  ...over,
});

describe("parseInsights — ไม่ไว้ใจรูปร่าง jsonb", () => {
  it("ค่าว่าง/ผิดชนิดกลายเป็นค่าเริ่มต้น ไม่ throw", () => {
    const r = parseInsights(null);
    expect(r.summary.orders).toBe(0);
    expect(r.products).toEqual([]);
    expect(r.channels.qr).toEqual({ orders: 0, revenue: 0 });
  });

  it("แปลง numeric ที่มาเป็น string และเก็บ cost null ไว้ (ไม่รู้ต้นทุน ≠ ต้นทุน 0)", () => {
    const r = parseInsights({
      summary: { orders: "3", revenue: "360.50" },
      products: [
        { productId: "a", name: "ชา", categoryId: null, qty: "2", revenue: "100", cost: null },
        { productId: "b", name: "กาแฟ", categoryId: "c", qty: 1, revenue: 50, cost: "12.5", costedRevenue: 50 },
        "ขยะ",
      ],
    });
    expect(r.summary.revenue).toBe(360.5);
    expect(r.products).toHaveLength(2);
    expect(r.products[0].cost).toBeNull();
    expect(r.products[0].categoryName).toBe("ไม่มีหมวด");
    expect(r.products[1].cost).toBe(12.5);
  });
});

describe("ตัวเลขที่คำนวณต่อ", () => {
  it("percentChange: ช่วงก่อนเป็น 0 = null ไม่ใช่ ∞", () => {
    expect(percentChange(150, 100)).toBe(50);
    expect(percentChange(50, 100)).toBe(-50);
    expect(percentChange(10, 0)).toBeNull();
  });

  it("รวมยอดตามหมวด + สัดส่วน · ไม่มีหมวดรวมเป็นกลุ่มเดียว", () => {
    const cats = categoryTotals([
      product({ productId: "a", revenue: 300 }),
      product({ productId: "b", revenue: 100 }),
      product({ productId: "c", categoryId: null, categoryName: "ไม่มีหมวด", revenue: 100 }),
    ]);
    expect(cats.map((c) => [c.name, c.revenue, c.menuCount, c.share])).toEqual([
      ["หมวด 1", 400, 2, 80],
      ["ไม่มีหมวด", 100, 1, 20],
    ]);
  });

  it("กราฟซ้อน: หมวดเกินพับเป็น 'อื่นๆ' ไม่สร้างสีใหม่ และเติมวันที่ไม่มียอด", () => {
    const products = Array.from({ length: 9 }, (_, i) =>
      product({ productId: `p${i}`, categoryId: `c${i}`, categoryName: `หมวด ${i}`, revenue: 100 - i }),
    );
    const cats = categoryTotals(products);
    const { series, buckets, weekly } = stackedCategorySeries(
      {
        range: base().range,
        categoryDaily: [
          { date: "2026-11-01", categoryId: "c0", categoryName: "หมวด 0", revenue: 50 },
          { date: "2026-11-03", categoryId: "c8", categoryName: "หมวด 8", revenue: 20 },
          { date: "2026-11-03", categoryId: "c7", categoryName: "หมวด 7", revenue: 5 },
        ],
      },
      cats,
    );
    expect(weekly).toBe(false);
    expect(series).toHaveLength(7);
    expect(series.at(-1)?.key).toBe(OTHER_CATEGORY_KEY);
    expect(buckets).toHaveLength(7);
    expect(buckets[1].total).toBe(0);
    expect(buckets[2].values[OTHER_CATEGORY_KEY]).toBe(25);
  });

  it("ช่วงยาวเกิน 62 วันรวมเป็นรายสัปดาห์ ช่องสุดท้ายไม่เกินวันสิ้นสุด", () => {
    const { buckets, weekly } = stackedCategorySeries(
      {
        range: { from: "2026-01-01", to: "2026-03-31", days: 90, prevFrom: "", prevTo: "" },
        categoryDaily: [{ date: "2026-03-31", categoryId: "c1", categoryName: "x", revenue: 10 }],
      },
      [{ key: "c1", name: "x", revenue: 10, qty: 1, menuCount: 1, share: 100 }],
    );
    expect(weekly).toBe(true);
    expect(buckets).toHaveLength(13);
    expect(buckets.at(-1)?.end).toBe("2026-03-31");
    expect(buckets.at(-1)?.total).toBe(10);
  });

  it("ตารางเมนู: ต้นทุน % คิดจากยอดที่รู้ต้นทุนเท่านั้น · กำไรขั้นต้นบอกความครอบคลุม", () => {
    const products = [
      product({ productId: "a", revenue: 200, qty: 4, cost: 60, costedRevenue: 150 }),
      product({ productId: "b", revenue: 100, cost: null }),
    ];
    const rows = productRows({ products, prevProducts: [{ productId: "a", qty: 2, revenue: 100 }] });
    expect(rows[0]).toMatchObject({ avgPrice: 50, costPct: 40, revenueChange: 100, share: 66.7 });
    expect(rows[1]).toMatchObject({ costPct: null, revenueChange: null });
    expect(grossProfit(products)).toEqual({ costedRevenue: 150, cost: 60, profit: 90, marginPct: 60, coveragePct: 50 });
    expect(grossProfit([product({})])).toBeNull();
  });
});

describe("ช่วงวันที่", () => {
  it("วันนี้ตามเวลาไทย — 17:30 UTC = วันถัดไปในไทย", () => {
    expect(bangkokToday(new Date("2026-11-09T17:30:00Z"))).toBe("2026-11-10");
    expect(bangkokToday(new Date("2026-11-09T16:59:00Z"))).toBe("2026-11-09");
  });

  it("preset และค่าผิดตกไป 30 วัน · กำหนดเองสลับ/ตัดอนาคต/จำกัด 366 วัน", () => {
    const today = "2026-11-10";
    expect(resolveInsightsRange({}, today)).toEqual({ preset: "30d", from: "2026-10-12", to: today });
    expect(resolveInsightsRange({ range: "7d" }, today)).toMatchObject({ from: "2026-11-04", to: today });
    expect(resolveInsightsRange({ range: "mtd" }, today)).toMatchObject({ from: "2026-11-01" });
    expect(resolveInsightsRange({ range: "lastMonth" }, "2026-03-15")).toMatchObject({ from: "2026-02-01", to: "2026-02-28" });
    expect(resolveInsightsRange({ range: "custom", from: "2026-11-05", to: "2026-11-01" }, today)).toMatchObject({ from: "2026-11-01", to: "2026-11-05" });
    expect(resolveInsightsRange({ range: "custom", from: "2026-11-01", to: "2027-01-01" }, today)).toMatchObject({ to: today });
    expect(resolveInsightsRange({ range: "custom", from: "2020-01-01", to: "2026-11-10" }, today)).toMatchObject({ from: "2025-11-10" });
    expect(resolveInsightsRange({ range: "custom", from: "2026-02-30", to: "2026-11-10" }, today).preset).toBe("30d");
  });
});

describe("คำแนะนำจากระบบ", () => {
  const ids = (raw: InsightsRaw) => buildRecommendations(raw).map((r) => r.id);

  it("ไม่มียอด → ข้อความเดียว", () => {
    expect(ids(base({ summary: { orders: 0, revenue: 0, discount: 0, memberOrders: 0, items: 0 } }))).toEqual(["no-sales"]);
  });

  it("ยอดขึ้น/ลง ≥10% เทียบช่วงก่อน แต่ต้องมีฐานบิลพอ", () => {
    expect(ids(base({ summary: { ...base().summary, revenue: 1200 } }))).toContain("revenue-up");
    expect(ids(base({ summary: { ...base().summary, revenue: 800 } }))).toContain("revenue-down");
    expect(ids(base({ summary: { ...base().summary, revenue: 2000 }, prevSummary: { ...base().prevSummary, orders: 2 } }))).not.toContain("revenue-up");
  });

  it("พึ่ง 3 เมนู · มาแรง · ยอดตก · ไม่มีสูตรต้นทุน · ต้นทุนสูง", () => {
    const products = [
      product({ productId: "a", name: "A", revenue: 3000, cost: 1500, costedRevenue: 3000 }),
      product({ productId: "b", name: "B", revenue: 2000 }),
      product({ productId: "c", name: "C", revenue: 1500 }),
      product({ productId: "d", name: "D", revenue: 500 }),
      product({ productId: "e", name: "E", revenue: 400 }),
      product({ productId: "f", name: "F", revenue: 350 }),
    ];
    const raw = base({
      summary: { ...base().summary, revenue: 7750 },
      prevSummary: { ...base().prevSummary, revenue: 7000 },
      products,
      prevProducts: [
        { productId: "a", qty: 1, revenue: 1000 },
        { productId: "d", qty: 1, revenue: 2000 },
      ],
    });
    const out = buildRecommendations(raw);
    const got = out.map((r) => r.id);
    expect(got).toEqual(expect.arrayContaining(["concentration", "rising", "declining", "missing-cost", "high-cost"]));
    // เตือนมาก่อนข่าวดี มาก่อนข้อมูล
    const tones = out.map((r) => r.tone);
    expect(tones.indexOf("warning")).toBeLessThan(tones.indexOf("positive"));
    expect(tones.lastIndexOf("positive")).toBeLessThan(tones.indexOf("info"));
  });

  it("ชั่วโมงทอง / วันเงียบ / ชิ้นต่อบิลต่ำ / ส่วนลดสูง / สมาชิกน้อย / เมนูไม่มียอด", () => {
    const hourly = [1, 2, 3, 4, 5, 6, 7].map((dow) => ({ dow, hour: dow === 2 ? 15 : 12, orders: 10, revenue: dow === 2 ? 100 : 1000 }));
    const raw = base({
      range: { ...base().range, days: 28 },
      summary: { orders: 40, revenue: 6100, discount: 1000, memberOrders: 1, items: 44 },
      hourly,
      idleProducts: [{ productId: "x", name: "เมนูเงียบ", categoryName: "หมวด" }],
    });
    const got = ids(raw);
    expect(got).toEqual(expect.arrayContaining(["peak-hour", "slow-day", "basket-size", "discount-heavy", "members-low", "idle-menus"]));
    expect(buildRecommendations(raw).find((r) => r.id === "slow-day")?.title).toContain("อังคาร");
    expect(buildRecommendations(raw).find((r) => r.id === "peak-hour")?.title).toContain("12:00");
  });
});

describe("migration + wiring", () => {
  const sql = readFileSync("supabase/migrations/20261110000000_sales_insights.sql", "utf8");
  const page = readFileSync("src/app/(dashboard)/reports/insights/page.tsx", "utf8");
  const repo = readFileSync("src/modules/reports/insights-repository.ts", "utf8");

  it("RPC เป็น invoker (ใช้ RLS ผู้เรียก) อ่านอย่างเดียว และปิดสิทธิ์ anon", () => {
    expect(sql).toContain("security invoker");
    expect(sql).not.toContain("security definer");
    expect(sql).not.toMatch(/\b(insert into|update \w+ set|delete from)\b/i);
    expect(sql).toContain("revoke all on function public.get_sales_insights(uuid, date, date) from public, anon;");
  });

  it("นับเวลาไทย ตัดรายการที่ void จำกัด 366 วัน และคิดต้นทุนตามหน่วยฐาน", () => {
    expect(sql).toContain("'Asia/Bangkok'");
    expect(sql).toContain("oi.voided is not true");
    expect(sql).toContain("o.status = 'paid'");
    expect(sql).toContain("if v_days > 366 then");
    expect(sql).toContain("oi.quantity * coalesce(oi.unit_quantity, 1) as base_qty");
  });

  it("หน้าเช็ก reports.view + advancedReports และ log ไม่เก็บชื่อเมนู", () => {
    expect(page).toContain('resolved.can("reports.view")');
    expect(page).toContain('canUseFeature(billingState, "advancedReports")');
    expect(repo).toContain('source: "reports.insights"');
    expect(repo).not.toMatch(/context:[^}]*products:\s*parsed\.products[,\s}]/);
  });
});

describe("คำแนะนำจุดคุ้มทุน (ฐานยอดเงิน)", () => {
  const days = (n: number) => Array.from({ length: n }, (_, i) => ({ date: `2026-11-0${i + 1}`, orders: 2, revenue: 200 }));
  const costed = base({
    summary: { orders: 14, revenue: 1400, discount: 0, memberOrders: 7, items: 28 },
    daily: days(7),
    products: [product({ revenue: 1400, cost: 560, costedRevenue: 1400 })], // margin 60%
  });

  it("ต่ำกว่าจุดคุ้มทุน → warning พร้อมลิงก์", () => {
    // ฐาน 31,200 ÷ (60% − 0%) ÷ 26 = 2,000/วัน · จริง 1,400 ÷ 7 วัน × 30 ÷ 26 = 230.77/วัน
    const be = breakEvenRevenuePerDay(costed, { fixedMonthly: 31200, openDaysPerMonth: 26, otherVariablePct: 0 });
    expect(be).toEqual({ breakEven: 2000, actual: 230.77 });
    const rec = buildRecommendations(costed, { fixedMonthly: 31200, openDaysPerMonth: 26, otherVariablePct: 0 }).find((r) => r.id === "below-break-even");
    expect(rec?.tone).toBe("warning");
    expect(rec?.action?.href).toBe("/costing/break-even");
  });

  it("เกินจุดคุ้มทุน → positive", () => {
    const ids = buildRecommendations(costed, { fixedMonthly: 1000, openDaysPerMonth: 26, otherVariablePct: 0 }).map((r) => r.id);
    expect(ids).toContain("above-break-even");
  });

  it("ไม่มีฐาน / ต้นทุนครอบคลุมน้อย / วันน้อย → ไม่แสดง", () => {
    expect(buildRecommendations(costed).map((r) => r.id)).not.toContain("below-break-even");
    const lowCoverage = base({ ...costed, products: [product({ revenue: 1400, cost: 100, costedRevenue: 200 })] });
    expect(breakEvenRevenuePerDay(lowCoverage, { fixedMonthly: 31200, openDaysPerMonth: 26, otherVariablePct: 0 })).toBeNull();
    expect(breakEvenRevenuePerDay({ ...costed, daily: days(3) }, { fixedMonthly: 31200, openDaysPerMonth: 26, otherVariablePct: 0 })).toBeNull();
    // ยอดกระจุกไม่กี่วันในช่วงยาว ไม่ทำให้ค่าเฉลี่ยพอง: 5 วันมียอดในช่วง 30 วัน
    const sparse = base({ ...costed, range: { ...costed.range, days: 30 }, daily: days(5) });
    expect(breakEvenRevenuePerDay(sparse, { fixedMonthly: 31200, openDaysPerMonth: 26, otherVariablePct: 0 })?.actual).toBe(53.85);
    // ผันแปรอื่นกินกำไรหมด
    expect(breakEvenRevenuePerDay(costed, { fixedMonthly: 31200, openDaysPerMonth: 26, otherVariablePct: 60 })).toBeNull();
  });
});
