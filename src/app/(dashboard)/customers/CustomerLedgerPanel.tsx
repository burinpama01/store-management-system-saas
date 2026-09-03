"use client";

/**
 * ประวัติแต้มของลูกค้าหนึ่งราย (audit ข้อ 7)
 *
 * เดิมระบบเขียน loyalty_ledger ทุกครั้งที่ได้/ใช้/ปรับแต้ม แต่ไม่มีที่ให้อ่านเลย
 * พอลูกค้าทักว่า "แต้มหาย" พนักงานตอบไม่ได้ว่าหายตอนไหนเพราะอะไร
 *
 * โหลดตอนกดเท่านั้น — ร้านที่ลูกค้าเยอะจะได้ไม่ต้องดึงประวัติทุกคนมาพร้อมหน้า
 */

import { useState, useTransition } from "react";
import { loadCustomerLedgerAction } from "./actions";
import type { LoyaltyLedgerEntry } from "@/modules/loyalty/repository";
import { formatPoints } from "@/shared/utils/points";

const TYPE_LABELS: Record<LoyaltyLedgerEntry["type"], string> = {
  earn: "ได้แต้ม",
  redeem: "ใช้แต้ม",
  reversal: "คืนแต้ม (ยกเลิกบิล)",
  adjustment: "ปรับมือ",
};

export function CustomerLedgerPanel({
  customerId,
  storeTimezone,
}: {
  customerId: string;
  storeTimezone: string;
}) {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<LoyaltyLedgerEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function toggle() {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    // โหลดครั้งเดียวแล้วจำไว้ กดปิด-เปิดซ้ำไม่ยิงใหม่
    if (entries !== null) return;
    startTransition(async () => {
      const result = await loadCustomerLedgerAction(customerId);
      setError(result.error);
      setEntries(result.entries);
    });
  }

  function formatWhen(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return new Intl.DateTimeFormat("th-TH", {
      timeZone: storeTimezone,
      day: "numeric",
      month: "short",
      year: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(d);
  }

  return (
    <div className="space-y-2">
      <button type="button" className="btn-secondary text-xs" onClick={toggle} aria-expanded={open}>
        {open ? "ซ่อนประวัติแต้ม" : "ประวัติแต้ม"}
      </button>

      {open ? (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-2,#f8fafc)] p-3 text-sm">
          {pending ? (
            <p className="text-[var(--muted)]">กำลังโหลด…</p>
          ) : error ? (
            <p className="text-[var(--color-danger,#b91c1c)]">{error}</p>
          ) : !entries || entries.length === 0 ? (
            <p className="text-[var(--muted)]">ยังไม่มีรายการแต้มของลูกค้ารายนี้</p>
          ) : (
            <ul className="space-y-1">
              {entries.map((entry) => (
                <li key={entry.id} className="flex flex-wrap items-baseline justify-between gap-2 border-b border-[var(--border)] pb-1 last:border-0">
                  <span className="text-[var(--muted)]">{formatWhen(entry.createdAt)}</span>
                  <span className="font-semibold text-[var(--ink)]">{TYPE_LABELS[entry.type]}</span>
                  <span
                    className={`tabular-nums font-bold ${
                      entry.pointsDelta < 0 ? "text-[var(--color-danger,#b91c1c)]" : "text-emerald-700"
                    }`}
                  >
                    {entry.pointsDelta > 0 ? "+" : ""}
                    {formatPoints(entry.pointsDelta)}
                  </span>
                  {entry.reason ? <span className="w-full text-xs text-[var(--muted)]">{entry.reason}</span> : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
