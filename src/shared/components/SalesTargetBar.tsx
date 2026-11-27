"use client";

/**
 * แถบเป้ายอดขายวันนี้ (แผนสลิป v4 · R7, R32, R33)
 * - ไม่ซื้อแพ็ก / ไม่เปิดสวิตช์ = ไม่แสดงอะไรเลย (endpoint ตอบ enabled:false)
 * - ทุกตำแหน่งในสาขาเห็น · เฉพาะวันนี้ (ไม่มีทางดูย้อนหลัง)
 * - โหลดตอนเปิดหน้า + ทุก 5 นาทีเฉพาะตอนหน้าจอเปิดอยู่ (ห้าม poll ถี่ — โควตา Vercel/Supabase)
 */
import { useEffect, useState } from "react";

interface SalesTargetData {
  enabled: boolean;
  sales?: number;
  currentBonus?: number;
  nextTier?: { minSales: number; amount: number } | null;
  remaining?: number;
  topTier?: { minSales: number; amount: number } | null;
  isRecord?: boolean;
  recordBonus?: number;
  /** split = ตัวเลขเป็นก้อนรวม หารตามคนที่ทำเต็มวัน */
  bonusMode?: "per_person" | "split";
}

const REFRESH_MS = 5 * 60_000;

function baht(n: number): string {
  return n.toLocaleString("th-TH", { maximumFractionDigits: 0 });
}

export function SalesTargetBar({ className = "" }: { className?: string }) {
  const [data, setData] = useState<SalesTargetData | null>(null);
  const unit = data?.bonusMode === "split" ? " (รวม หารตามคนเข้างาน)" : "/คน";

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    async function load() {
      if (document.visibilityState !== "visible") return;
      try {
        const res = await fetch("/api/hr/sales-target", { cache: "no-store" });
        const json = (await res.json()) as SalesTargetData;
        if (!stopped) setData(json);
        // ปิดอยู่ = ไม่ต้องถามซ้ำจนกว่าจะเปิดหน้าใหม่
        if (!json.enabled) return;
      } catch {
        // เน็ตหลุด: เงียบไว้ รอบหน้าลองใหม่
      }
      if (!stopped) timer = setTimeout(load, REFRESH_MS);
    }
    void load();
    const onVisible = () => {
      if (document.visibilityState === "visible" && timer === null) void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  if (!data?.enabled || data.sales === undefined) return null;
  const sales = data.sales;
  const next = data.nextTier ?? null;
  const top = data.topTier ?? null;
  const goal = next?.minSales ?? top?.minSales ?? sales;
  const pct = goal > 0 ? Math.min(100, Math.round((sales / goal) * 100)) : 100;

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="sales-target-bar"
      className={`shrink-0 border-b border-indigo-100 bg-indigo-50 px-4 py-2 text-xs text-indigo-900 ${className}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <span className="font-semibold">ยอดขายวันนี้ ฿{baht(sales)}</span>
        <span>
          {data.isRecord ? (
            <b>👑 ทำสถิติสูงสุดของร้าน! โบนัสสถิติ +{data.recordBonus}{unit}</b>
          ) : next ? (
            <>
              อีก <b>฿{baht(data.remaining ?? 0)}</b> ถึงโบนัส <b>+{next.amount}{unit}</b>
              {data.currentBonus ? ` · ตอนนี้ได้ +${data.currentBonus}${unit}` : ""}
            </>
          ) : (
            <b>ถึงขั้นสูงสุดแล้ว 🎉 โบนัส +{data.currentBonus}{unit}</b>
          )}
        </span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-indigo-100">
        <div className="h-full rounded-full bg-indigo-500 transition-[width] duration-700" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
