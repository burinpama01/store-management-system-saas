/**
 * รายงานเชิงลึก (/reports/insights) — แปลงผลจาก RPC get_sales_insights + สร้างคำแนะนำ
 * ฟังก์ชันล้วน ไม่มี I/O เพื่อให้เทสต์ได้ตรง ๆ
 */

export interface InsightsSummary {
  orders: number;
  revenue: number;
  discount: number;
  memberOrders: number;
  items: number;
}

export interface InsightsProduct {
  productId: string;
  name: string;
  categoryId: string | null;
  categoryName: string;
  qty: number;
  revenue: number;
  orders: number;
  /** ต้นทุนรวมของบรรทัดที่มีสูตร (null = ไม่มีสูตรเลย หรือผู้ใช้ไม่มีสิทธิ์เห็นต้นทุน) */
  cost: number | null;
  /** ยอดขายของบรรทัดที่รู้ต้นทุน — ใช้คิด food cost % ให้เทียบกันได้ */
  costedRevenue: number;
}

export interface InsightsRaw {
  range: { from: string; to: string; days: number; prevFrom: string; prevTo: string };
  summary: InsightsSummary;
  prevSummary: InsightsSummary;
  daily: { date: string; orders: number; revenue: number }[];
  /** dow: 1 = จันทร์ … 7 = อาทิตย์ (ISO) */
  hourly: { dow: number; hour: number; orders: number; revenue: number }[];
  products: InsightsProduct[];
  prevProducts: { productId: string; qty: number; revenue: number }[];
  categoryDaily: { date: string; categoryId: string | null; categoryName: string; revenue: number }[];
  channels: Record<"pos" | "qr" | "delivery", { orders: number; revenue: number }>;
  payments: { method: string; count: number; amount: number }[];
  idleProducts: { productId: string; name: string; categoryName: string }[];
}

const num = (value: unknown): number => {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
};
const str = (value: unknown, fallback = ""): string => (typeof value === "string" ? value : fallback);
const arr = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.filter((v): v is Record<string, unknown> => !!v && typeof v === "object") : [];
const obj = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

function parseSummary(value: unknown): InsightsSummary {
  const s = obj(value);
  return { orders: num(s.orders), revenue: num(s.revenue), discount: num(s.discount), memberOrders: num(s.memberOrders), items: num(s.items) };
}

/** อ่าน jsonb จาก RPC แบบไม่ไว้ใจรูปร่าง — ช่องหาย/ผิดชนิดกลายเป็นค่าว่าง ไม่ทำหน้าพัง */
export function parseInsights(value: unknown): InsightsRaw {
  const root = obj(value);
  const range = obj(root.range);
  const channels = obj(root.channels);
  const channel = (key: string) => {
    const c = obj(channels[key]);
    return { orders: num(c.orders), revenue: num(c.revenue) };
  };
  return {
    range: {
      from: str(range.from),
      to: str(range.to),
      days: num(range.days),
      prevFrom: str(range.prevFrom),
      prevTo: str(range.prevTo),
    },
    summary: parseSummary(root.summary),
    prevSummary: parseSummary(root.prevSummary),
    daily: arr(root.daily).map((d) => ({ date: str(d.date), orders: num(d.orders), revenue: num(d.revenue) })),
    hourly: arr(root.hourly).map((h) => ({ dow: num(h.dow), hour: num(h.hour), orders: num(h.orders), revenue: num(h.revenue) })),
    products: arr(root.products).map((p) => ({
      productId: str(p.productId),
      name: str(p.name, "ไม่มีชื่อ"),
      categoryId: typeof p.categoryId === "string" ? p.categoryId : null,
      categoryName: str(p.categoryName, "ไม่มีหมวด"),
      qty: num(p.qty),
      revenue: num(p.revenue),
      orders: num(p.orders),
      cost: p.cost === null || p.cost === undefined ? null : num(p.cost),
      costedRevenue: num(p.costedRevenue),
    })),
    prevProducts: arr(root.prevProducts).map((p) => ({ productId: str(p.productId), qty: num(p.qty), revenue: num(p.revenue) })),
    categoryDaily: arr(root.categoryDaily).map((c) => ({
      date: str(c.date),
      categoryId: typeof c.categoryId === "string" ? c.categoryId : null,
      categoryName: str(c.categoryName, "ไม่มีหมวด"),
      revenue: num(c.revenue),
    })),
    channels: { pos: channel("pos"), qr: channel("qr"), delivery: channel("delivery") },
    payments: arr(root.payments).map((p) => ({ method: str(p.method, "other"), count: num(p.count), amount: num(p.amount) })),
    idleProducts: arr(root.idleProducts).map((p) => ({
      productId: str(p.productId),
      name: str(p.name, "ไม่มีชื่อ"),
      categoryName: str(p.categoryName, "ไม่มีหมวด"),
    })),
  };
}

/** % เปลี่ยนแปลง — null เมื่อช่วงก่อนเป็น 0 (หารไม่ได้ ไม่ใช่ "โต ∞%") */
export function percentChange(current: number, previous: number): number | null {
  if (previous <= 0) return null;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export interface CategoryTotal {
  key: string;
  name: string;
  revenue: number;
  qty: number;
  menuCount: number;
  share: number;
}

const NO_CATEGORY_KEY = "__none__";
export const OTHER_CATEGORY_KEY = "__other__";

export function categoryTotals(products: InsightsProduct[]): CategoryTotal[] {
  const total = products.reduce((s, p) => s + p.revenue, 0);
  const map = new Map<string, CategoryTotal>();
  for (const p of products) {
    const key = p.categoryId ?? NO_CATEGORY_KEY;
    const c = map.get(key) ?? { key, name: p.categoryName, revenue: 0, qty: 0, menuCount: 0, share: 0 };
    c.revenue = round2(c.revenue + p.revenue);
    c.qty += p.qty;
    c.menuCount += 1;
    map.set(key, c);
  }
  return [...map.values()]
    .map((c) => ({ ...c, share: total > 0 ? Math.round((c.revenue / total) * 1000) / 10 : 0 }))
    .sort((a, b) => b.revenue - a.revenue || a.name.localeCompare(b.name, "th"));
}

export interface StackedSeries {
  key: string;
  name: string;
}
export interface StackedBucket {
  label: string;
  /** วันแรกของช่อง (YYYY-MM-DD) */
  start: string;
  end: string;
  values: Record<string, number>;
  total: number;
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * กราฟแท่งซ้อนตามหมวด: หมวดใหญ่สุด maxSeries-1 หมวด + "อื่นๆ" (ไม่สร้างสีที่ 9)
 * ช่วงยาวกว่า 62 วันรวมเป็นรายสัปดาห์ เพื่อไม่ให้แท่งบางจนอ่านไม่ออก
 * ใส่ทุกวันในช่วงแม้ไม่มียอด — แกนเวลาต้องต่อเนื่อง
 */
export function stackedCategorySeries(
  raw: Pick<InsightsRaw, "range" | "categoryDaily">,
  categories: CategoryTotal[],
  maxSeries = 7,
): { series: StackedSeries[]; buckets: StackedBucket[]; weekly: boolean } {
  const keep = categories.length <= maxSeries ? categories : categories.slice(0, maxSeries - 1);
  const keepKeys = new Set(keep.map((c) => c.key));
  const series: StackedSeries[] = keep.map((c) => ({ key: c.key, name: c.name }));
  if (categories.length > keep.length) series.push({ key: OTHER_CATEGORY_KEY, name: "อื่นๆ" });

  const { from, to, days } = raw.range;
  if (!from || !to || days <= 0) return { series, buckets: [], weekly: false };
  const weekly = days > 62;
  const step = weekly ? 7 : 1;
  const buckets: StackedBucket[] = [];
  for (let start = from; start <= to; start = addDays(start, step)) {
    const end = weekly ? (addDays(start, 6) < to ? addDays(start, 6) : to) : start;
    buckets.push({ label: start.slice(5).replace("-", "/"), start, end, values: {}, total: 0 });
  }
  const index = (date: string) => Math.floor((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 / step);
  for (const row of raw.categoryDaily) {
    const bucket = buckets[index(row.date)];
    if (!bucket) continue;
    const rowKey = row.categoryId ?? NO_CATEGORY_KEY;
    const key = keepKeys.has(rowKey) ? rowKey : OTHER_CATEGORY_KEY;
    bucket.values[key] = round2((bucket.values[key] ?? 0) + row.revenue);
    bucket.total = round2(bucket.total + row.revenue);
  }
  return { series, buckets, weekly };
}

export interface ProductRow extends InsightsProduct {
  share: number;
  avgPrice: number;
  prevRevenue: number;
  revenueChange: number | null;
  /** ต้นทุน % ของยอดขายที่รู้ต้นทุน (null = ไม่รู้ต้นทุน) */
  costPct: number | null;
}

export function productRows(raw: Pick<InsightsRaw, "products" | "prevProducts">): ProductRow[] {
  const total = raw.products.reduce((s, p) => s + p.revenue, 0);
  const prev = new Map(raw.prevProducts.map((p) => [p.productId, p]));
  return raw.products.map((p) => {
    const prevRevenue = prev.get(p.productId)?.revenue ?? 0;
    return {
      ...p,
      share: total > 0 ? Math.round((p.revenue / total) * 1000) / 10 : 0,
      avgPrice: p.qty > 0 ? round2(p.revenue / p.qty) : 0,
      prevRevenue,
      revenueChange: percentChange(p.revenue, prevRevenue),
      costPct: p.cost !== null && p.costedRevenue > 0 ? Math.round((p.cost / p.costedRevenue) * 1000) / 10 : null,
    };
  });
}

export interface GrossProfit {
  costedRevenue: number;
  cost: number;
  profit: number;
  marginPct: number;
  /** % ของยอดขายที่รู้ต้นทุน — บอกผู้ใช้ว่ากำไรนี้ครอบคลุมแค่ไหน */
  coveragePct: number;
}

export function grossProfit(products: InsightsProduct[]): GrossProfit | null {
  const costed = products.filter((p) => p.cost !== null && p.costedRevenue > 0);
  if (costed.length === 0) return null;
  const costedRevenue = round2(costed.reduce((s, p) => s + p.costedRevenue, 0));
  const cost = round2(costed.reduce((s, p) => s + (p.cost ?? 0), 0));
  const total = products.reduce((s, p) => s + p.revenue, 0);
  return {
    costedRevenue,
    cost,
    profit: round2(costedRevenue - cost),
    marginPct: costedRevenue > 0 ? Math.round(((costedRevenue - cost) / costedRevenue) * 1000) / 10 : 0,
    coveragePct: total > 0 ? Math.round((costedRevenue / total) * 1000) / 10 : 0,
  };
}

export const DOW_LABEL = ["", "จันทร์", "อังคาร", "พุธ", "พฤหัสบดี", "ศุกร์", "เสาร์", "อาทิตย์"] as const;

export type RecommendationTone = "positive" | "warning" | "info";
export interface Recommendation {
  id: string;
  tone: RecommendationTone;
  title: string;
  detail: string;
  action?: { label: string; href: string };
}

const baht = (n: number) => `฿${n.toLocaleString("th-TH", { maximumFractionDigits: 0 })}`;
const names = (rows: { name: string }[]) => rows.map((r) => r.name).join(", ");

/**
 * คำแนะนำแบบกฎตายตัว (อธิบายได้ ไม่ใช้ AI) — เรียงเตือนก่อน แล้วข่าวดี แล้วข้อมูล
 * ทุกกฎมีเกณฑ์ขั้นต่ำกันสัญญาณหลอกจากข้อมูลน้อย
 */
export function buildRecommendations(raw: InsightsRaw): Recommendation[] {
  const out: Recommendation[] = [];
  const { summary, prevSummary } = raw;
  if (summary.orders === 0) {
    return [
      {
        id: "no-sales",
        tone: "info",
        title: "ยังไม่มียอดขายในช่วงนี้",
        detail: "ลองเลือกช่วงเวลาอื่น หรือเปิดขายผ่าน POS / QR เพื่อเริ่มเก็บข้อมูล",
      },
    ];
  }

  // 1) ยอดรวมเทียบช่วงก่อน
  const revenueChange = percentChange(summary.revenue, prevSummary.revenue);
  if (revenueChange !== null && prevSummary.orders >= 5) {
    if (revenueChange >= 10) {
      out.push({
        id: "revenue-up",
        tone: "positive",
        title: `ยอดขายโต ${revenueChange}% จากช่วงก่อน`,
        detail: `${baht(summary.revenue)} เทียบกับ ${baht(prevSummary.revenue)} — ดูเมนูมาแรงด้านล่างว่าอะไรดันยอด แล้วเตรียมวัตถุดิบให้พอ`,
      });
    } else if (revenueChange <= -10) {
      out.push({
        id: "revenue-down",
        tone: "warning",
        title: `ยอดขายลดลง ${Math.abs(revenueChange)}% จากช่วงก่อน`,
        detail: `${baht(summary.revenue)} เทียบกับ ${baht(prevSummary.revenue)} — ดูเมนูที่ยอดตกและช่วงเวลาที่เงียบลง เพื่อจัดโปรให้ตรงจุด`,
        action: { label: "ตั้งคูปอง/โปร", href: "/customers" },
      });
    }
  }

  const rows = productRows(raw);
  const totalRevenue = rows.reduce((s, p) => s + p.revenue, 0);

  // 2) พึ่งเมนูไม่กี่ตัว
  if (rows.length >= 6 && totalRevenue > 0) {
    const top3 = rows.slice(0, 3);
    const share = Math.round((top3.reduce((s, p) => s + p.revenue, 0) / totalRevenue) * 100);
    if (share > 50) {
      out.push({
        id: "concentration",
        tone: "info",
        title: `3 เมนูแรกทำยอด ${share}% ของร้าน`,
        detail: `${names(top3)} — วัตถุดิบของเมนูเหล่านี้ห้ามขาด และควรตั้งแจ้งเตือนสต็อกต่ำไว้`,
        action: { label: "ดูสต็อก", href: "/stock" },
      });
    }
  }

  // 3) เมนูมาแรง / ยอดตก (ต้องมีฐานพอ)
  const minBase = Math.max(300, totalRevenue * 0.02);
  const rising = rows
    .filter((p) => p.revenueChange !== null && p.revenueChange >= 50 && p.revenue >= minBase)
    .sort((a, b) => (b.revenueChange ?? 0) - (a.revenueChange ?? 0))
    .slice(0, 3);
  if (rising.length > 0) {
    out.push({
      id: "rising",
      tone: "positive",
      title: `เมนูมาแรง: ${names(rising)}`,
      detail: rising.map((p) => `${p.name} +${p.revenueChange}%`).join(" · ") + " — ลองดันเป็นเมนูแนะนำหรือจับคู่ขายเป็นชุด",
    });
  }
  const prevById = new Map(raw.prevProducts.map((p) => [p.productId, p]));
  const declining = rows
    .filter((p) => p.revenueChange !== null && p.revenueChange <= -40 && (prevById.get(p.productId)?.revenue ?? 0) >= minBase)
    .sort((a, b) => (a.revenueChange ?? 0) - (b.revenueChange ?? 0))
    .slice(0, 3);
  if (declining.length > 0) {
    out.push({
      id: "declining",
      tone: "warning",
      title: `เมนูยอดตก: ${names(declining)}`,
      detail: declining.map((p) => `${p.name} ${p.revenueChange}%`).join(" · ") + " — ตรวจคุณภาพ ราคา หรือของหมดบ่อยหรือไม่",
    });
  }

  // 4) เมนูที่เปิดขายแต่ไม่มีใครสั่ง
  if (raw.idleProducts.length > 0 && raw.range.days >= 7) {
    const sample = raw.idleProducts.slice(0, 5);
    out.push({
      id: "idle-menus",
      tone: "warning",
      title: `${raw.idleProducts.length >= 100 ? "100+" : raw.idleProducts.length} เมนูไม่มียอดเลยในช่วงนี้`,
      detail: `เช่น ${names(sample)} — พิจารณาจัดโปร ย้ายตำแหน่งบนเมนู หรือปิดขายเพื่อให้เมนูกระชับ`,
      action: { label: "จัดการเมนู", href: "/catalog" },
    });
  }

  // 5) ชั่วโมงทอง / วันเงียบ
  if (raw.hourly.length > 0 && summary.orders >= 20) {
    const byHour = new Map<number, number>();
    const byDow = new Map<number, number>();
    for (const h of raw.hourly) {
      byHour.set(h.hour, (byHour.get(h.hour) ?? 0) + h.revenue);
      byDow.set(h.dow, (byDow.get(h.dow) ?? 0) + h.revenue);
    }
    const [peakHour, peakRevenue] = [...byHour.entries()].sort((a, b) => b[1] - a[1])[0];
    out.push({
      id: "peak-hour",
      tone: "info",
      title: `ช่วงขายดีที่สุด ${String(peakHour).padStart(2, "0")}:00–${String(peakHour + 1).padStart(2, "0")}:00`,
      detail: `ทำยอด ${Math.round((peakRevenue / summary.revenue) * 100)}% ของทั้งช่วง — จัดพนักงานและเตรียมของล่วงหน้าก่อนเวลานี้`,
      action: { label: "จัดตารางงาน", href: "/attendance" },
    });
    if (raw.range.days >= 14 && byDow.size >= 5) {
      const sorted = [...byDow.entries()].sort((a, b) => a[1] - b[1]);
      const [slowDow, slowRevenue] = sorted[0];
      const avg = [...byDow.values()].reduce((s, v) => s + v, 0) / byDow.size;
      if (slowRevenue < avg * 0.7) {
        out.push({
          id: "slow-day",
          tone: "info",
          title: `วัน${DOW_LABEL[slowDow]}ขายได้น้อยที่สุด`,
          detail: `ต่ำกว่าค่าเฉลี่ยรายวันในสัปดาห์ ${Math.round((1 - slowRevenue / avg) * 100)}% — เหมาะจัดโปรเฉพาะวันหรือแต้มสะสมพิเศษ`,
          action: { label: "ตั้งคูปอง", href: "/customers" },
        });
      }
    }
  }

  // 6) ต้นทุน
  const highCost = rows
    .filter((p) => p.costPct !== null && p.costPct > 40 && p.revenue >= minBase)
    .sort((a, b) => (b.costPct ?? 0) - (a.costPct ?? 0))
    .slice(0, 3);
  if (highCost.length > 0) {
    out.push({
      id: "high-cost",
      tone: "warning",
      title: `ต้นทุนวัตถุดิบสูง: ${names(highCost)}`,
      detail: highCost.map((p) => `${p.name} ${p.costPct}%`).join(" · ") + " (เกิน 40% ของราคาขาย) — ทบทวนราคา สูตร หรือปริมาณต่อจาน",
      action: { label: "ดูต้นทุน", href: "/costing" },
    });
  }
  const topNoCost = rows.slice(0, 10).filter((p) => p.cost === null);
  if (topNoCost.length >= 3) {
    out.push({
      id: "missing-cost",
      tone: "info",
      title: `${topNoCost.length} ใน 10 เมนูขายดียังไม่มีสูตรต้นทุน`,
      detail: `เช่น ${names(topNoCost.slice(0, 3))} — ตั้งสูตรวัตถุดิบเพื่อให้รายงานนี้คำนวณกำไรขั้นต้นได้`,
      action: { label: "ตั้งสูตรต้นทุน", href: "/costing" },
    });
  }

  // 7) ชิ้นต่อบิล
  const itemsPerOrder = summary.items / summary.orders;
  if (summary.orders >= 20 && itemsPerOrder < 1.5) {
    out.push({
      id: "basket-size",
      tone: "info",
      title: `เฉลี่ย ${itemsPerOrder.toFixed(1)} ชิ้นต่อบิล`,
      detail: "ลูกค้าส่วนใหญ่สั่งชิ้นเดียว — ลองทำชุดคอมโบหรือให้พนักงานแนะนำของทานเล่น/เครื่องดื่มเพิ่ม",
    });
  }

  // 8) ส่วนลด
  const gross = summary.revenue + summary.discount;
  if (gross > 0 && summary.discount / gross > 0.1) {
    out.push({
      id: "discount-heavy",
      tone: "warning",
      title: `ส่วนลดท้ายบิล ${Math.round((summary.discount / gross) * 100)}% ของยอดก่อนลด`,
      detail: `รวม ${baht(summary.discount)} — ตรวจว่าโปร/คูปองคุ้มค่าและไม่มีการให้ส่วนลดเกินสิทธิ์`,
    });
  }

  // 9) สมาชิก
  if (summary.orders >= 30 && summary.memberOrders / summary.orders < 0.1) {
    out.push({
      id: "members-low",
      tone: "info",
      title: `บิลที่เป็นสมาชิกมีแค่ ${Math.round((summary.memberOrders / summary.orders) * 100)}%`,
      detail: "ชวนลูกค้าสะสมแต้มตอนจ่ายเงิน เพื่อให้ลูกค้ากลับมาซื้อซ้ำและส่งโปรหาได้",
      action: { label: "ระบบสมาชิก", href: "/customers" },
    });
  }

  const order: Record<RecommendationTone, number> = { warning: 0, positive: 1, info: 2 };
  return out.sort((a, b) => order[a.tone] - order[b.tone]);
}

/** วันที่ปัจจุบันตามเวลาไทย (YYYY-MM-DD) */
export function bangkokToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export type InsightsPreset = "7d" | "30d" | "mtd" | "lastMonth" | "custom";
export const INSIGHTS_PRESETS: { key: Exclude<InsightsPreset, "custom">; label: string }[] = [
  { key: "7d", label: "7 วัน" },
  { key: "30d", label: "30 วัน" },
  { key: "mtd", label: "เดือนนี้" },
  { key: "lastMonth", label: "เดือนก่อน" },
];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isRealDate = (s: string | undefined): s is string =>
  !!s && DATE_RE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);

/**
 * แปลง query string เป็นช่วงวันที่ — ค่าผิด/ไม่มี = 30 วันล่าสุด
 * กำหนดเอง: สลับถ้ากลับด้าน, ไม่เกินวันนี้, ยาวไม่เกิน 366 วัน (ตรงกับที่ RPC ยอมรับ)
 */
export function resolveInsightsRange(
  params: { range?: string; from?: string; to?: string },
  today: string,
): { preset: InsightsPreset; from: string; to: string } {
  const monthStart = `${today.slice(0, 7)}-01`;
  switch (params.range) {
    case "7d":
      return { preset: "7d", from: addDays(today, -6), to: today };
    case "mtd":
      return { preset: "mtd", from: monthStart, to: today };
    case "lastMonth": {
      const lastDay = addDays(monthStart, -1);
      return { preset: "lastMonth", from: `${lastDay.slice(0, 7)}-01`, to: lastDay };
    }
    case "custom": {
      if (!isRealDate(params.from) || !isRealDate(params.to)) break;
      let [from, to] = params.from <= params.to ? [params.from, params.to] : [params.to, params.from];
      if (to > today) to = today;
      if (from > to) from = to;
      if (addDays(from, 365) < to) from = addDays(to, -365);
      return { preset: "custom", from, to };
    }
  }
  return { preset: "30d", from: addDays(today, -29), to: today };
}
