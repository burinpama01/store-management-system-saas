"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition, type ReactNode } from "react";
import {
  DOW_LABEL,
  INSIGHTS_PRESETS,
  buildRecommendations,
  categoryTotals,
  grossProfit,
  percentChange,
  productRows,
  stackedCategorySeries,
  type InsightsPreset,
  type BreakEvenBasis,
  type InsightsRaw,
  type ProductRow,
  type Recommendation,
} from "@/modules/reports/insights";
import { Button } from "@/shared/components/ui";
import { HorizontalBars, HourHeatmap, Legend, StackedBarChart, baht, seriesColor, SERIES_COLORS } from "./charts";

const METHOD_LABEL: Record<string, string> = {
  cash: "เงินสด",
  qr_promptpay: "QR พร้อมเพย์",
  credit_card: "บัตรเครดิต",
  bank_transfer: "โอนเงิน",
  other: "อื่นๆ",
};

interface Props {
  preset: InsightsPreset;
  from: string;
  to: string;
  today: string;
  data: InsightsRaw | null;
  error: string | null;
  breakEven?: BreakEvenBasis | null;
}

export function InsightsView({ preset, from, to, today, data, error, breakEven = null }: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [customFrom, setCustomFrom] = useState(from);
  const [customTo, setCustomTo] = useState(to);

  const go = (params: Record<string, string>) =>
    startTransition(() => router.push(`/reports/insights?${new URLSearchParams(params)}`));

  return (
    <div className="page-shell">
      <div className="page-header">
        <div>
          <h1 className="page-title">รายงานเชิงลึก</h1>
          <p className="page-kicker">ยอดขายตามหมวด เมนูขายดี ยอดรายเมนู และคำแนะนำจากระบบ · นับวันตามเวลาไทย</p>
        </div>
        <Link href="/reports" className="text-sm font-bold text-[var(--color-brand)]">
          รายงานแบบย่อ →
        </Link>
      </div>

      <div className="panel flex flex-wrap items-end gap-2 p-4">
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="ช่วงเวลา">
          {INSIGHTS_PRESETS.map((p) => (
            <button
              key={p.key}
              type="button"
              onClick={() => go({ range: p.key })}
              aria-pressed={preset === p.key}
              className={`rounded-full border px-3 py-1.5 text-sm font-bold transition ${
                preset === p.key
                  ? "border-[var(--color-brand)] bg-[var(--color-brand)] text-white"
                  : "border-[var(--color-border)] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-muted)]"
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-end gap-2 sm:ml-auto">
          <label className="text-xs text-[var(--color-text-muted)]">
            ตั้งแต่
            <input type="date" value={customFrom} max={customTo || today} onChange={(e) => setCustomFrom(e.target.value)} className="mt-1 block px-3 py-1.5" style={{ fontSize: 16 }} />
          </label>
          <label className="text-xs text-[var(--color-text-muted)]">
            ถึง
            <input type="date" value={customTo} min={customFrom} max={today} onChange={(e) => setCustomTo(e.target.value)} className="mt-1 block px-3 py-1.5" style={{ fontSize: 16 }} />
          </label>
          <Button variant="secondary" loading={isPending} loadingText="กำลังโหลด..." onClick={() => go({ range: "custom", from: customFrom, to: customTo })}>
            ดูช่วงนี้
          </Button>
        </div>
      </div>

      {error || !data ? (
        <div className="panel p-6 text-center text-sm text-[var(--color-danger)]">{error ?? "โหลดรายงานไม่สำเร็จ"}</div>
      ) : (
        <InsightsBody data={data} pending={isPending} breakEven={breakEven} />
      )}
    </div>
  );
}

function InsightsBody({ data, pending, breakEven }: { data: InsightsRaw; pending: boolean; breakEven: BreakEvenBasis | null }) {
  const categories = useMemo(() => categoryTotals(data.products), [data.products]);
  const stacked = useMemo(() => stackedCategorySeries(data, categories), [data, categories]);
  const rows = useMemo(() => productRows(data), [data]);
  const profit = useMemo(() => grossProfit(data.products), [data.products]);
  const recommendations = useMemo(() => buildRecommendations(data, breakEven), [data, breakEven]);
  const colorByCategory = useMemo(() => new Map(stacked.series.map((s, i) => [s.key, seriesColor(s.key, i)])), [stacked.series]);
  const { summary, prevSummary } = data;
  const aov = summary.orders > 0 ? summary.revenue / summary.orders : 0;
  const prevAov = prevSummary.orders > 0 ? prevSummary.revenue / prevSummary.orders : 0;
  const compareLabel = `เทียบ ${data.range.prevFrom} – ${data.range.prevTo}`;

  return (
    <div className={`space-y-6 transition-opacity ${pending ? "opacity-60" : ""}`}>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Kpi label="ยอดขาย" value={baht(summary.revenue)} change={percentChange(summary.revenue, prevSummary.revenue)} hint={compareLabel} />
        <Kpi label="จำนวนบิล" value={summary.orders.toLocaleString("th-TH")} change={percentChange(summary.orders, prevSummary.orders)} hint={compareLabel} />
        <Kpi label="เฉลี่ยต่อบิล" value={baht(Math.round(aov * 100) / 100)} change={percentChange(aov, prevAov)} hint={compareLabel} />
        <Kpi label="ชิ้นที่ขาย" value={summary.items.toLocaleString("th-TH")} change={percentChange(summary.items, prevSummary.items)} hint={compareLabel} />
        {profit ? (
          <Kpi
            label="กำไรขั้นต้น"
            value={baht(profit.profit)}
            sub={`มาร์จิ้น ${profit.marginPct}% · คิดจากยอด ${profit.coveragePct}% ที่มีสูตร`}
          />
        ) : (
          <Kpi label="กำไรขั้นต้น" value="—" sub="ตั้งสูตรต้นทุนเมนูเพื่อดูกำไร" href="/costing" />
        )}
      </div>

      <Recommendations items={recommendations} />

      {summary.orders > 0 && (
        <>
          <Section
            title={stacked.weekly ? "ยอดขายรายสัปดาห์ แยกตามหมวดหมู่" : "ยอดขายรายวัน แยกตามหมวดหมู่"}
            subtitle="ยอดรายเมนูก่อนหักส่วนลดท้ายบิล"
          >
            <div className="space-y-3 p-4">
              <Legend items={stacked.series.map((s) => ({ key: s.key, name: s.name, color: colorByCategory.get(s.key) ?? SERIES_COLORS[0] }))} />
              <StackedBarChart series={stacked.series} buckets={stacked.buckets} weekly={stacked.weekly} />
            </div>
          </Section>

          <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
            <Section title="สัดส่วนยอดตามหมวดหมู่">
              <div className="p-4">
                <HorizontalBars
                  rows={categories.map((c) => ({
                    key: c.key,
                    label: c.name,
                    value: c.revenue,
                    color: colorByCategory.get(c.key) ?? colorByCategory.get("__other__"),
                    sub: `${c.share}%`,
                  }))}
                  format={baht}
                />
              </div>
            </Section>
            <TopMenus rows={rows} />
          </div>

          <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
            <Section title="ช่วงเวลาขายดี" subtitle="ยอดขายตามวันและชั่วโมง (เวลาไทย)">
              <div className="p-4">
                <HourHeatmap cells={data.hourly} dowLabels={DOW_LABEL} />
              </div>
            </Section>
            <Section title="ช่องทางขายและการชำระเงิน">
              <div className="space-y-5 p-4">
                <HorizontalBars
                  rows={[
                    { key: "pos", label: "หน้าร้าน (POS)", value: data.channels.pos.revenue, sub: `${data.channels.pos.orders} บิล` },
                    { key: "qr", label: "QR สั่งที่โต๊ะ", value: data.channels.qr.revenue, sub: `${data.channels.qr.orders} บิล` },
                    { key: "delivery", label: "เดลิเวอรี", value: data.channels.delivery.revenue, sub: `${data.channels.delivery.orders} บิล` },
                  ]}
                  format={baht}
                />
                {data.payments.length > 0 && (
                  <div>
                    <p className="mb-2 text-xs font-bold text-[var(--color-text-secondary)]">วิธีชำระเงิน</p>
                    <HorizontalBars
                      rows={data.payments.map((p) => ({ key: p.method, label: METHOD_LABEL[p.method] ?? p.method, value: p.amount, sub: `${p.count} ครั้ง` }))}
                      format={baht}
                    />
                  </div>
                )}
              </div>
            </Section>
          </div>

          <MenuTable rows={rows} categories={categories.map((c) => ({ key: c.key, name: c.name }))} range={data.range} idle={data.idleProducts} />
        </>
      )}
    </div>
  );
}

function Kpi({ label, value, change, hint, sub, href }: { label: string; value: string; change?: number | null; hint?: string; sub?: string; href?: string }) {
  const body = (
    <div className="metric-card h-full p-4">
      <p className="label-muted mb-1">{label}</p>
      <p className="text-xl font-extrabold text-[var(--color-text-primary)]">{value}</p>
      {change !== undefined && (
        <p className="mt-1 text-xs text-[var(--color-text-muted)]" title={hint}>
          {change === null ? (
            "ไม่มีข้อมูลช่วงก่อน"
          ) : (
            <span style={{ color: change > 0 ? "#006300" : change < 0 ? "#d03b3b" : undefined }} className="font-bold">
              {change > 0 ? "▲" : change < 0 ? "▼" : "•"} {Math.abs(change)}%
            </span>
          )}
          {change !== null && <span> จากช่วงก่อน</span>}
        </p>
      )}
      {sub && <p className="mt-1 text-xs text-[var(--color-text-muted)]">{sub}</p>}
    </div>
  );
  return href ? <Link href={href}>{body}</Link> : body;
}

const TONE_STYLE: Record<Recommendation["tone"], { icon: string; label: string; border: string; bg: string }> = {
  warning: { icon: "!", label: "ควรดู", border: "#ec835a", bg: "#fff6f1" },
  positive: { icon: "▲", label: "ข่าวดี", border: "#0ca30c", bg: "#f2fbf2" },
  info: { icon: "i", label: "แนะนำ", border: "#2a78d6", bg: "#f3f8fe" },
};

function Recommendations({ items }: { items: Recommendation[] }) {
  return (
    <Section title="คำแนะนำจากระบบ" subtitle="คำนวณจากยอดขายจริงของร้านด้วยกฎตายตัว — ไม่ใช้ AI">
      {items.length === 0 ? (
        <p className="px-4 py-6 text-sm text-[var(--color-text-muted)]">ยอดขายช่วงนี้ปกติ ยังไม่มีเรื่องที่ต้องแจ้ง</p>
      ) : (
        <ul className="grid grid-cols-1 gap-3 p-4 md:grid-cols-2">
          {items.map((item) => {
            const tone = TONE_STYLE[item.tone];
            return (
              <li key={item.id} className="flex gap-3 rounded-xl border p-3" style={{ borderColor: tone.border, background: tone.bg }}>
                <span
                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-extrabold text-white"
                  style={{ background: tone.border }}
                  aria-label={tone.label}
                >
                  {tone.icon}
                </span>
                <div className="min-w-0">
                  <p className="text-sm font-bold text-[var(--color-text-primary)]">{item.title}</p>
                  <p className="mt-0.5 text-sm text-[var(--color-text-secondary)]">{item.detail}</p>
                  {item.action && (
                    <Link href={item.action.href} className="mt-1 inline-block text-sm font-bold text-[var(--color-brand)]">
                      {item.action.label} →
                    </Link>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}

function TopMenus({ rows }: { rows: ProductRow[] }) {
  const [by, setBy] = useState<"revenue" | "qty">("revenue");
  const top = [...rows].sort((a, b) => (by === "revenue" ? b.revenue - a.revenue : b.qty - a.qty)).slice(0, 10);
  return (
    <Section
      title="เมนูขายดี 10 อันดับ"
      action={
        <div className="flex gap-1" role="group" aria-label="เรียงตาม">
          {(["revenue", "qty"] as const).map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => setBy(key)}
              aria-pressed={by === key}
              className={`rounded-full px-2.5 py-1 text-xs font-bold ${by === key ? "bg-[var(--color-text-primary)] text-white" : "text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-muted)]"}`}
            >
              {key === "revenue" ? "ยอดเงิน" : "จำนวน"}
            </button>
          ))}
        </div>
      }
    >
      <div className="p-4">
        <HorizontalBars
          rows={top.map((p) => ({
            key: p.productId,
            label: p.name,
            value: by === "revenue" ? p.revenue : p.qty,
            sub: by === "revenue" ? `${p.qty.toLocaleString("th-TH")} ชิ้น` : baht(p.revenue),
          }))}
          format={(n) => (by === "revenue" ? baht(n) : `${n.toLocaleString("th-TH")} ชิ้น`)}
        />
      </div>
    </Section>
  );
}

type SortKey = "name" | "qty" | "revenue" | "share" | "avgPrice" | "revenueChange" | "costPct";
const COLUMNS: { key: SortKey; label: string; align: "left" | "right" }[] = [
  { key: "name", label: "เมนู", align: "left" },
  { key: "qty", label: "จำนวน", align: "right" },
  { key: "revenue", label: "ยอดขาย", align: "right" },
  { key: "share", label: "สัดส่วน", align: "right" },
  { key: "avgPrice", label: "ราคาเฉลี่ย", align: "right" },
  { key: "revenueChange", label: "เทียบช่วงก่อน", align: "right" },
  { key: "costPct", label: "ต้นทุน %", align: "right" },
];

function csvCell(value: string | number | null): string {
  if (value === null) return "";
  const text = String(value);
  // กันสูตร Excel (=,+,-,@) และ escape เครื่องหมายคำพูด
  const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

function MenuTable({
  rows,
  categories,
  range,
  idle,
}: {
  rows: ProductRow[];
  categories: { key: string; name: string }[];
  range: InsightsRaw["range"];
  idle: InsightsRaw["idleProducts"];
}) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "revenue", dir: -1 });
  const [showIdle, setShowIdle] = useState(false);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows
      .filter((r) => (category === "all" ? true : (r.categoryId ?? "__none__") === category))
      .filter((r) => (q ? r.name.toLowerCase().includes(q) : true))
      .sort((a, b) => {
        if (sort.key === "name") return a.name.localeCompare(b.name, "th") * sort.dir;
        const av = a[sort.key] ?? -Infinity;
        const bv = b[sort.key] ?? -Infinity;
        return ((av as number) - (bv as number)) * sort.dir;
      });
  }, [rows, query, category, sort]);

  const toggleSort = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: key === "name" ? 1 : -1 }));

  function exportCsv() {
    const lines = [
      ["เมนู", "หมวด", "จำนวน", "ยอดขาย", "สัดส่วน %", "ราคาเฉลี่ย", "ยอดช่วงก่อน", "เปลี่ยนแปลง %", "ต้นทุน %"].join(","),
      ...visible.map((r) =>
        [r.name, r.categoryName, r.qty, r.revenue, r.share, r.avgPrice, r.prevRevenue, r.revenueChange, r.costPct].map(csvCell).join(","),
      ),
    ];
    const blob = new Blob(["﻿" + lines.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `menu-sales-${range.from}-${range.to}.csv`;
    // Firefox บางรุ่นต้องอยู่ใน DOM ก่อน click จึงจะดาวน์โหลด
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <Section
      title={`ยอดขายแต่ละเมนู (${rows.length} เมนู)`}
      subtitle="ยอดรายเมนูก่อนหักส่วนลดท้ายบิล · ต้นทุน % เฉพาะเมนูที่มีสูตร"
      action={
        <Button variant="secondary" onClick={exportCsv}>
          ส่งออก CSV
        </Button>
      }
    >
      <div className="flex flex-wrap gap-2 border-b border-[var(--color-border)] p-3">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="ค้นหาเมนู"
          className="min-w-0 flex-1 px-3 py-1.5"
          style={{ fontSize: 16 }}
          aria-label="ค้นหาเมนู"
        />
        <select value={category} onChange={(e) => setCategory(e.target.value)} className="px-3 py-1.5" style={{ fontSize: 16 }} aria-label="กรองหมวดหมู่">
          <option value="all">ทุกหมวด</option>
          {categories.map((c) => (
            <option key={c.key} value={c.key}>
              {c.name}
            </option>
          ))}
        </select>
      </div>
      <div className="max-h-[560px] overflow-auto">
        <table className="w-full min-w-[760px] text-sm">
          <thead className="sticky top-0 z-[1] bg-[var(--color-surface-muted)] text-xs font-bold text-[var(--color-text-secondary)]">
            <tr>
              {COLUMNS.map((col) => (
                <th key={col.key} className={`px-3 py-2 ${col.align === "right" ? "text-right" : "text-left"}`} aria-sort={sort.key === col.key ? (sort.dir === 1 ? "ascending" : "descending") : "none"}>
                  <button type="button" onClick={() => toggleSort(col.key)} className="font-bold hover:text-[var(--color-text-primary)]">
                    {col.label}
                    {sort.key === col.key ? (sort.dir === 1 ? " ↑" : " ↓") : ""}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--color-border)]">
            {visible.length === 0 ? (
              <tr>
                <td colSpan={COLUMNS.length} className="px-3 py-8 text-center text-[var(--color-text-muted)]">
                  ไม่พบเมนู
                </td>
              </tr>
            ) : (
              visible.map((r) => (
                <tr key={r.productId} className="hover:bg-[var(--color-surface-muted)]">
                  <td className="px-3 py-2">
                    <p className="font-medium text-[var(--color-text-primary)]">{r.name}</p>
                    <p className="text-xs text-[var(--color-text-muted)]">{r.categoryName}</p>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.qty.toLocaleString("th-TH")}</td>
                  <td className="px-3 py-2 text-right font-bold tabular-nums text-[var(--color-text-primary)]">{baht(r.revenue)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-[var(--color-text-secondary)]">{r.share}%</td>
                  <td className="px-3 py-2 text-right tabular-nums text-[var(--color-text-secondary)]">{baht(r.avgPrice)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {r.revenueChange === null ? (
                      <span className="text-xs text-[var(--color-text-muted)]">{r.prevRevenue > 0 ? "—" : "ใหม่"}</span>
                    ) : (
                      <span style={{ color: r.revenueChange > 0 ? "#006300" : r.revenueChange < 0 ? "#d03b3b" : undefined }}>
                        {r.revenueChange > 0 ? "▲" : r.revenueChange < 0 ? "▼" : ""} {Math.abs(r.revenueChange)}%
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {r.costPct === null ? (
                      <span className="text-xs text-[var(--color-text-muted)]">—</span>
                    ) : (
                      <span style={{ color: r.costPct > 40 ? "#d03b3b" : undefined }}>{r.costPct}%</span>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      {idle.length > 0 && (
        <div className="border-t border-[var(--color-border)] p-3 text-sm">
          <button type="button" onClick={() => setShowIdle((v) => !v)} className="font-bold text-[var(--color-text-secondary)]">
            {showIdle ? "▾" : "▸"} เมนูที่เปิดขายแต่ไม่มียอดในช่วงนี้ ({idle.length >= 100 ? "100+" : idle.length})
          </button>
          {showIdle && (
            <ul className="mt-2 grid grid-cols-1 gap-1 text-[var(--color-text-secondary)] sm:grid-cols-2 lg:grid-cols-3">
              {idle.map((p) => (
                <li key={p.productId} className="truncate">
                  {p.name} <span className="text-xs text-[var(--color-text-muted)]">· {p.categoryName}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Section>
  );
}

function Section({ title, subtitle, action, children }: { title: string; subtitle?: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="panel overflow-hidden">
      <div className="panel-header flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="panel-title">{title}</h2>
          {subtitle && <p className="text-xs text-[var(--color-text-muted)]">{subtitle}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}
