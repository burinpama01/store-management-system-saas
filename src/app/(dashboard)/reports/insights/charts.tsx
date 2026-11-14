"use client";

/**
 * กราฟ SVG เขียนเอง (ไม่เพิ่ม dependency) — ตามแนวทาง dataviz:
 * สีหมวดตามลำดับคงที่ (ไม่วน) ผูกกับหมวด ไม่ใช่อันดับ · แท่งปลายมน 4px · ช่องว่าง 2px ระหว่างชั้น
 * มี tooltip ทุกกราฟ · ตัวหนังสือใช้สีหมึก ไม่ใช้สีซีรีส์
 */
import { useMemo, useState, type ReactNode } from "react";
import type { StackedBucket, StackedSeries } from "@/modules/reports/insights";
import { OTHER_CATEGORY_KEY } from "@/modules/reports/insights";

export const SERIES_COLORS = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6"];
export const OTHER_COLOR = "#a8a69f";
const INK = "#0b0b0b";
const INK_2 = "#52514e";
const MUTED = "#898781";
const GRID = "#e1e0d9";
const BASELINE = "#c3c2b7";

export function seriesColor(key: string, index: number): string {
  return key === OTHER_CATEGORY_KEY ? OTHER_COLOR : SERIES_COLORS[index % SERIES_COLORS.length];
}

export const bahtShort = (n: number) => {
  if (Math.abs(n) >= 1_000_000) return `฿${(n / 1_000_000).toLocaleString("th-TH", { maximumFractionDigits: 1 })}M`;
  if (Math.abs(n) >= 10_000) return `฿${(n / 1_000).toLocaleString("th-TH", { maximumFractionDigits: 0 })}k`;
  return `฿${n.toLocaleString("th-TH", { maximumFractionDigits: 0 })}`;
};
export const baht = (n: number) => `฿${n.toLocaleString("th-TH", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

/** ค่าบนแกนที่ปัดสวย (1/2/2.5/5 × 10^n) */
function niceMax(value: number): number {
  if (value <= 0) return 1;
  const exp = Math.pow(10, Math.floor(Math.log10(value)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * exp >= value) return m * exp;
  return 10 * exp;
}

/** เส้นทางแท่งที่มนเฉพาะด้านบน (ปลายข้อมูล) ฐานเรียบติดแกน */
function topRoundedRect(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.max(0, Math.min(r, w / 2, h));
  return `M${x},${y + h} V${y + rr} Q${x},${y} ${x + rr},${y} H${x + w - rr} Q${x + w},${y} ${x + w},${y + rr} V${y + h} Z`;
}

function Tooltip({ xPct, children }: { xPct: number; children: ReactNode }) {
  // อยู่ในกรอบกราฟเสมอ — ครึ่งขวาให้กล่องขึ้นทางซ้ายของเมาส์
  const style = xPct > 50 ? { right: `${100 - xPct + 2}%` } : { left: `${xPct + 2}%` };
  return (
    <div
      role="tooltip"
      className="pointer-events-none absolute top-2 z-10 min-w-[160px] rounded-lg border border-[var(--color-border)] bg-white px-3 py-2 text-xs shadow-lg"
      style={style}
    >
      {children}
    </div>
  );
}

export function Legend({ items }: { items: { key: string; name: string; color: string }[] }) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs" style={{ color: INK_2 }}>
      {items.map((item) => (
        <li key={item.key} className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: item.color }} aria-hidden />
          {item.name}
        </li>
      ))}
    </ul>
  );
}

/** แท่งซ้อนตามหมวดต่อวัน/สัปดาห์ */
export function StackedBarChart({ series, buckets, weekly }: { series: StackedSeries[]; buckets: StackedBucket[]; weekly: boolean }) {
  const [hover, setHover] = useState<number | null>(null);
  const width = 760;
  const height = 280;
  const pad = { top: 12, right: 8, bottom: 28, left: 52 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const max = niceMax(Math.max(0, ...buckets.map((b) => b.total)));
  const slot = buckets.length > 0 ? plotW / buckets.length : plotW;
  const barW = Math.max(2, Math.min(36, slot * 0.7));
  const colors = useMemo(() => new Map(series.map((s, i) => [s.key, seriesColor(s.key, i)])), [series]);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => t * max);
  const labelEvery = Math.max(1, Math.ceil(buckets.length / 10));
  const hovered = hover !== null ? buckets[hover] : null;

  return (
    // จอแคบ: คงความกว้างขั้นต่ำให้ตัวหนังสือแกนอ่านได้ แล้วเลื่อนแนวนอนแทนการย่อ
    <div className="overflow-x-auto">
    <div className="relative min-w-[620px]">
      <svg viewBox={`0 0 ${width} ${height}`} className="h-auto w-full" role="img" aria-label="กราฟยอดขายซ้อนตามหมวดหมู่">
        {ticks.map((t) => {
          const y = pad.top + plotH - (t / max) * plotH;
          return (
            <g key={t}>
              <line x1={pad.left} x2={width - pad.right} y1={y} y2={y} stroke={t === 0 ? BASELINE : GRID} strokeWidth={1} />
              <text x={pad.left - 6} y={y + 4} textAnchor="end" fontSize={11} fill={MUTED}>
                {bahtShort(t)}
              </text>
            </g>
          );
        })}
        {buckets.map((bucket, i) => {
          const x = pad.left + i * slot + (slot - barW) / 2;
          let y = pad.top + plotH;
          const segments = series.filter((s) => (bucket.values[s.key] ?? 0) > 0);
          return (
            <g key={bucket.start} opacity={hover === null || hover === i ? 1 : 0.45}>
              {segments.map((s, si) => {
                const h = ((bucket.values[s.key] ?? 0) / max) * plotH;
                // ช่องว่าง 2px ระหว่างชั้น (ยกเว้นชั้นล่างสุด)
                const gap = si === 0 ? 0 : Math.min(2, h / 2);
                y -= h;
                const isTop = si === segments.length - 1;
                return isTop ? (
                  <path key={s.key} d={topRoundedRect(x, y, barW, h - gap, 4)} fill={colors.get(s.key)} />
                ) : (
                  <rect key={s.key} x={x} y={y} width={barW} height={Math.max(0, h - gap)} fill={colors.get(s.key)} />
                );
              })}
              {i % labelEvery === 0 && (
                <text x={x + barW / 2} y={height - 8} textAnchor="middle" fontSize={11} fill={MUTED}>
                  {bucket.label}
                </text>
              )}
              {/* พื้นที่ hover ใหญ่กว่าแท่ง */}
              <rect
                x={pad.left + i * slot}
                y={pad.top}
                width={slot}
                height={plotH}
                fill="transparent"
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
                onClick={() => setHover(hover === i ? null : i)}
              />
            </g>
          );
        })}
      </svg>
      {hovered && hover !== null && (
        <Tooltip xPct={((pad.left + hover * slot + slot / 2) / width) * 100}>
          <p className="mb-1 font-bold" style={{ color: INK }}>
            {weekly ? `${hovered.start} – ${hovered.end}` : hovered.start} · {baht(hovered.total)}
          </p>
          {[...series]
            .reverse()
            .filter((s) => (hovered.values[s.key] ?? 0) > 0)
            .map((s) => (
              <p key={s.key} className="flex items-center justify-between gap-3" style={{ color: INK_2 }}>
                <span className="flex items-center gap-1.5">
                  <span className="inline-block h-2 w-2 rounded-sm" style={{ background: colors.get(s.key) }} />
                  {s.name}
                </span>
                <span className="tabular-nums" style={{ color: INK }}>
                  {baht(hovered.values[s.key] ?? 0)}
                </span>
              </p>
            ))}
        </Tooltip>
      )}
      {/* ตารางซ่อนสำหรับโปรแกรมอ่านหน้าจอ — ตัวเลขเดียวกับกราฟ */}
      <table className="sr-only">
        <caption>ยอดขายแยกตามหมวดหมู่ต่อช่วงเวลา</caption>
        <thead>
          <tr>
            <th scope="col">ช่วง</th>
            {series.map((s) => (
              <th key={s.key} scope="col">{s.name}</th>
            ))}
            <th scope="col">รวม</th>
          </tr>
        </thead>
        <tbody>
          {buckets.map((b) => (
            <tr key={b.start}>
              <th scope="row">{weekly ? `${b.start} – ${b.end}` : b.start}</th>
              {series.map((s) => (
                <td key={s.key}>{baht(b.values[s.key] ?? 0)}</td>
              ))}
              <td>{baht(b.total)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
    </div>
  );
}

/** แท่งแนวนอน (เมนูขายดี / สัดส่วนหมวด) — ป้ายชื่อซ้าย ค่าขวา สีเดียว เว้นแต่ส่งสีมาเอง */
export function HorizontalBars({
  rows,
  format,
}: {
  rows: { key: string; label: string; value: number; color?: string; sub?: string }[];
  format: (n: number) => string;
}) {
  const max = Math.max(0, ...rows.map((r) => r.value));
  return (
    <ul className="space-y-2">
      {rows.map((row) => (
        <li key={row.key} className="grid grid-cols-[minmax(0,9rem)_1fr_auto] items-center gap-3 text-sm sm:grid-cols-[minmax(0,12rem)_1fr_auto]" title={`${row.label}: ${format(row.value)}${row.sub ? ` · ${row.sub}` : ""}`}>
          <span className="truncate" style={{ color: INK }}>
            {row.label}
          </span>
          <span className="h-3 rounded-r" style={{ background: "#f0efec" }}>
            <span
              className="block h-3 rounded-r-[4px]"
              style={{ width: `${max > 0 ? Math.max(1, (row.value / max) * 100) : 0}%`, background: row.color ?? SERIES_COLORS[0] }}
            />
          </span>
          <span className="whitespace-nowrap text-right tabular-nums" style={{ color: INK_2 }}>
            {format(row.value)}
            {row.sub && <span className="ml-1 text-xs" style={{ color: MUTED }}>{row.sub}</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** heatmap วัน × ชั่วโมง — ไล่สีฟ้าเดียว (sequential) */
const HEAT_STEPS = ["#f0efec", "#cde2fb", "#9ec5f4", "#6da7ec", "#3987e5", "#256abf", "#184f95"];
export function HourHeatmap({
  cells,
  dowLabels,
}: {
  cells: { dow: number; hour: number; orders: number; revenue: number }[];
  dowLabels: readonly string[];
}) {
  const [hover, setHover] = useState<{ dow: number; hour: number } | null>(null);
  const map = new Map(cells.map((c) => [`${c.dow}-${c.hour}`, c]));
  const activeHours = cells.length > 0 ? [Math.min(...cells.map((c) => c.hour)), Math.max(...cells.map((c) => c.hour))] : [8, 20];
  const hours: number[] = [];
  for (let h = activeHours[0]; h <= activeHours[1]; h += 1) hours.push(h);
  const max = Math.max(0, ...cells.map((c) => c.revenue));
  const step = (v: number) => (v <= 0 || max <= 0 ? 0 : Math.min(HEAT_STEPS.length - 1, 1 + Math.floor((v / max) * (HEAT_STEPS.length - 1.0001))));
  const hovered = hover ? map.get(`${hover.dow}-${hover.hour}`) : undefined;

  return (
    <div>
      <div className="overflow-x-auto">
        <table className="border-separate text-[11px]" style={{ borderSpacing: 2 }}>
          <thead>
            <tr>
              <th />
              {hours.map((h) => (
                <th key={h} scope="col" className="w-7 text-center font-normal" style={{ color: MUTED }}>
                  {String(h).padStart(2, "0")}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {[1, 2, 3, 4, 5, 6, 7].map((dow) => (
              <tr key={dow}>
                <th scope="row" className="pr-2 text-right font-normal whitespace-nowrap" style={{ color: INK_2 }}>
                  {dowLabels[dow]}
                </th>
                {hours.map((h) => {
                  const cell = map.get(`${dow}-${h}`);
                  const isHover = hover?.dow === dow && hover.hour === h;
                  return (
                    <td
                      key={h}
                      className="h-6 w-7 cursor-default rounded"
                      style={{ background: HEAT_STEPS[step(cell?.revenue ?? 0)], outline: isHover ? `2px solid ${INK}` : undefined }}
                      onMouseEnter={() => setHover({ dow, hour: h })}
                      onMouseLeave={() => setHover(null)}
                      onClick={() => setHover({ dow, hour: h })}
                      aria-label={`${dowLabels[dow]} ${h}:00 ${cell ? baht(cell.revenue) : "ไม่มียอด"}`}
                    />
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs" style={{ color: INK_2 }}>
        <span className="min-h-[1rem]">
          {hover
            ? `${dowLabels[hover.dow]} ${String(hover.hour).padStart(2, "0")}:00–${String(hover.hour + 1).padStart(2, "0")}:00 · ${
                hovered ? `${baht(hovered.revenue)} · ${hovered.orders} บิล` : "ไม่มียอด"
              }`
            : "แตะ/ชี้ช่องเพื่อดูยอด"}
        </span>
        <span className="flex items-center gap-1">
          น้อย
          {HEAT_STEPS.slice(1).map((c) => (
            <span key={c} className="inline-block h-2.5 w-4 rounded-sm" style={{ background: c }} />
          ))}
          มาก
        </span>
      </div>
    </div>
  );
}
