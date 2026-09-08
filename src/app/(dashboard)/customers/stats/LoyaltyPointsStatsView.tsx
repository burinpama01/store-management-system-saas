"use client";

/**
 * แดชบอร์ดแต้มลูกค้า — ตอบสามคำถามที่ร้านถามบ่อยที่สุด
 *   1. ช่วงนี้แจกแต้มไปเท่าไร ลูกค้าเอาไปใช้จริงกี่แต้ม
 *   2. ตอนนี้มีแต้มค้างในระบบเท่าไร (ภาระที่ร้านต้องจ่ายคืนวันหน้า)
 *   3. รายการล่าสุดของทั้งร้าน ใครได้/ใช้แต้มเมื่อไร จากบิลไหน
 * เดิมมีแค่ประวัติรายคน ต้องเปิดทีละคนถึงจะเห็น
 */

import type { ReactNode } from "react";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/shared/components/ui";
import { formatPoints } from "@/shared/utils/points";
import type {
  LoyaltyLedgerType,
  LoyaltyPointsDaily,
  LoyaltyPointsOutstanding,
  LoyaltyPointsSummary,
  LoyaltyTopCustomer,
  StoreLoyaltyLedgerEntry,
} from "@/modules/loyalty/stats-repository";
import { logLoyaltyStatsExportAction } from "./actions";

const TYPE_LABELS: Record<LoyaltyLedgerType, string> = {
  earn: "ได้แต้ม",
  redeem: "ใช้แต้ม",
  reversal: "คืนแต้ม (ยกเลิกบิล)",
  adjustment: "ปรับมือ",
};

const TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "ทุกประเภท" },
  { value: "earn", label: TYPE_LABELS.earn },
  { value: "redeem", label: TYPE_LABELS.redeem },
  { value: "reversal", label: TYPE_LABELS.reversal },
  { value: "adjustment", label: TYPE_LABELS.adjustment },
];

interface Props {
  summary: LoyaltyPointsSummary | null;
  daily: LoyaltyPointsDaily[];
  topCustomers: LoyaltyTopCustomer[];
  outstanding: LoyaltyPointsOutstanding | null;
  entries: StoreLoyaltyLedgerEntry[];
  entryTotal: number;
  pageSize: number;
  offset: number;
  dateFrom: string;
  dateTo: string;
  typeFilter: LoyaltyLedgerType | null;
  storeTimezone: string;
  errors: string[];
}

export function LoyaltyPointsStatsView({
  summary,
  daily,
  topCustomers,
  outstanding,
  entries,
  entryTotal,
  pageSize,
  offset,
  dateFrom,
  dateTo,
  typeFilter,
  storeTimezone,
  errors,
}: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [localFrom, setLocalFrom] = useState(dateFrom);
  const [localTo, setLocalTo] = useState(dateTo);
  const [localType, setLocalType] = useState<string>(typeFilter ?? "");

  function pushParams(next: { dateFrom: string; dateTo: string; type: string; offset: number }) {
    const params = new URLSearchParams({ dateFrom: next.dateFrom, dateTo: next.dateTo });
    if (next.type) params.set("type", next.type);
    if (next.offset > 0) params.set("offset", String(next.offset));
    startTransition(() => router.push(`/customers/stats?${params}`));
  }

  function applyFilters() {
    // เปลี่ยนตัวกรองแล้วต้องกลับหน้าแรกเสมอ ไม่งั้นค้างอยู่หน้า 4 ของช่วงเดิมแล้วเห็นว่าง
    pushParams({ dateFrom: localFrom, dateTo: localTo, type: localType, offset: 0 });
  }

  function goToOffset(nextOffset: number) {
    pushParams({ dateFrom, dateTo, type: typeFilter ?? "", offset: Math.max(nextOffset, 0) });
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

  function exportCsv() {
    const rows: string[] = [];
    const csv = (value: string | number | null) => `"${String(value ?? "").replace(/"/g, '""')}"`;
    rows.push(["ส่วน", "รายการ", "แต้มได้", "แต้มใช้", "สุทธิ", "จำนวนรายการ"].map(csv).join(","));
    if (summary) {
      rows.push(
        ["สรุปช่วง", `${dateFrom} ถึง ${dateTo}`, summary.earnedPoints, summary.redeemedPoints, summary.netPoints, summary.entryCount]
          .map(csv)
          .join(","),
      );
    }
    if (outstanding) {
      rows.push(["แต้มคงค้าง", "ทั้งร้าน ณ ปัจจุบัน", "", "", outstanding.outstandingPoints, outstanding.membersWithPoints].map(csv).join(","));
    }
    for (const day of daily) {
      rows.push(["รายวัน", day.date, day.earnedPoints, day.redeemedPoints, day.netPoints, day.entryCount].map(csv).join(","));
    }
    for (const customer of topCustomers) {
      rows.push(
        ["ลูกค้า", customer.customerName, customer.earnedPoints, customer.redeemedPoints, customer.netPoints, customer.entryCount]
          .map(csv)
          .join(","),
      );
    }
    for (const entry of entries) {
      rows.push(
        [
          "รายการ",
          `${formatWhen(entry.createdAt)} ${entry.customerName} ${TYPE_LABELS[entry.type]}${entry.orderNumber ? ` บิล ${entry.orderNumber}` : ""}${entry.reason ? ` (${entry.reason})` : ""}`,
          entry.pointsDelta > 0 ? entry.pointsDelta : "",
          entry.pointsDelta < 0 ? -entry.pointsDelta : "",
          entry.pointsDelta,
          1,
        ]
          .map(csv)
          .join(","),
      );
    }

    const blob = new Blob(["﻿" + rows.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `loyalty-points-${dateFrom}-${dateTo}.csv`;
    link.click();
    URL.revokeObjectURL(url);
    void logLoyaltyStatsExportAction({ dateFrom, dateTo, type: typeFilter, rowCount: rows.length - 1 });
  }

  const pageFrom = entryTotal === 0 ? 0 : offset + 1;
  const pageTo = Math.min(offset + entries.length, entryTotal);

  return (
    <div className="page-shell">
      <div className="page-header">
        <div>
          <h1 className="page-title">สถิติแต้มลูกค้า</h1>
          <p className="page-kicker">แต้มที่แจก แต้มที่ลูกค้าใช้ แต้มคงค้าง และรายการแต้มล่าสุดของทั้งร้าน</p>
        </div>
        <Link href="/customers" className="btn-secondary">
          กลับไปหน้าลูกค้า
        </Link>
      </div>

      {errors.length > 0 ? (
        <div className="panel border-[var(--color-danger,#b91c1c)] p-4 text-sm text-[var(--color-danger,#b91c1c)]">
          {errors.map((message) => (
            <p key={message}>{message}</p>
          ))}
        </div>
      ) : null}

      <div className="panel flex flex-wrap items-end gap-3 p-4">
        <div>
          <label className="field-label" htmlFor="loyalty-stats-from">
            ตั้งแต่
          </label>
          <input
            id="loyalty-stats-from"
            type="date"
            value={localFrom}
            onChange={(e) => setLocalFrom(e.target.value)}
            className="px-3 py-1.5 text-sm"
          />
        </div>
        <div>
          <label className="field-label" htmlFor="loyalty-stats-to">
            ถึง
          </label>
          <input
            id="loyalty-stats-to"
            type="date"
            value={localTo}
            onChange={(e) => setLocalTo(e.target.value)}
            className="px-3 py-1.5 text-sm"
          />
        </div>
        <div>
          <label className="field-label" htmlFor="loyalty-stats-type">
            ประเภทรายการ
          </label>
          <select
            id="loyalty-stats-type"
            value={localType}
            onChange={(e) => setLocalType(e.target.value)}
            className="px-3 py-1.5 text-sm"
          >
            {TYPE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <Button variant="primary" onClick={applyFilters} loading={isPending} loadingText="กำลังโหลด...">
          ดูสถิติ
        </Button>
        <Button variant="secondary" onClick={exportCsv} className="ml-auto">
          ส่งออก CSV
        </Button>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <SummaryCard
          label="แต้มที่แจก"
          value={formatPoints(summary?.earnedPoints)}
          sub={`${summary?.earnCount ?? 0} รายการ`}
          color="text-emerald-700"
        />
        <SummaryCard
          label="แต้มที่ลูกค้าใช้"
          value={formatPoints(summary?.redeemedPoints)}
          sub={`${summary?.redeemCount ?? 0} รายการ`}
          color="text-[var(--color-danger,#b91c1c)]"
        />
        <SummaryCard
          label="เปลี่ยนแปลงสุทธิ"
          value={formatPoints(summary?.netPoints)}
          sub={`คืนแต้ม ${formatPoints(summary?.reversalPoints)} · ปรับมือ ${formatPoints(summary?.adjustmentPoints)}`}
          color="text-blue-700"
        />
        <SummaryCard
          label="แต้มคงค้างทั้งร้าน"
          value={formatPoints(outstanding?.outstandingPoints)}
          sub={`${outstanding?.membersWithPoints ?? 0} คนมีแต้มเหลือ`}
          color="text-purple-700"
        />
        <SummaryCard
          label="ลูกค้าที่เคลื่อนไหว"
          value={String(summary?.activeCustomerCount ?? 0)}
          sub={`จากสมาชิก ${outstanding?.memberCount ?? 0} คน`}
          color="text-gray-700"
        />
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <Section title="รายวัน">
          {daily.length === 0 ? (
            <EmptyRow />
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-[var(--color-text-muted)]">
                  <th className="px-3 py-2">วันที่</th>
                  <th className="px-3 py-2 text-right">แจก</th>
                  <th className="px-3 py-2 text-right">ใช้</th>
                  <th className="px-3 py-2 text-right">สุทธิ</th>
                  <th className="px-3 py-2 text-right">รายการ</th>
                </tr>
              </thead>
              <tbody>
                {daily.map((day) => (
                  <tr key={day.date} className="hover:bg-[var(--color-surface-muted)]">
                    <td className="px-3 py-2 whitespace-nowrap text-[var(--color-text-secondary)]">{day.date}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-emerald-700">{formatPoints(day.earnedPoints)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-[var(--color-danger,#b91c1c)]">
                      {formatPoints(day.redeemedPoints)}
                    </td>
                    <td className="px-3 py-2 text-right font-bold tabular-nums">{formatPoints(day.netPoints)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-[var(--color-text-secondary)]">{day.entryCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Section>

        <Section title="ลูกค้าที่ได้แต้มมากที่สุด">
          {topCustomers.length === 0 ? (
            <EmptyRow />
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-[var(--color-text-muted)]">
                  <th className="px-3 py-2">ลูกค้า</th>
                  <th className="px-3 py-2 text-right">ได้</th>
                  <th className="px-3 py-2 text-right">ใช้</th>
                  <th className="px-3 py-2 text-right">คงเหลือ</th>
                </tr>
              </thead>
              <tbody>
                {topCustomers.map((customer) => (
                  <tr key={customer.customerId} className="hover:bg-[var(--color-surface-muted)]">
                    <td className="px-3 py-2">
                      <span className="font-medium text-[var(--color-text-primary)]">{customer.customerName}</span>
                      {customer.phone ? (
                        <span className="block text-xs text-[var(--color-text-muted)]">{customer.phone}</span>
                      ) : null}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-emerald-700">{formatPoints(customer.earnedPoints)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-[var(--color-danger,#b91c1c)]">
                      {formatPoints(customer.redeemedPoints)}
                    </td>
                    <td className="px-3 py-2 text-right font-bold tabular-nums">{formatPoints(customer.pointsBalance)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Section>
      </div>

      <Section title={`รายการแต้มล่าสุด (${entryTotal.toLocaleString("th-TH")} รายการ)`}>
        {entries.length === 0 ? (
          <EmptyRow />
        ) : (
          <>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-[var(--color-text-muted)]">
                  <th className="px-3 py-2">เวลา</th>
                  <th className="px-3 py-2">ลูกค้า</th>
                  <th className="px-3 py-2">ประเภท</th>
                  <th className="px-3 py-2">บิล / เหตุผล</th>
                  <th className="px-3 py-2 text-right">แต้ม</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <tr key={entry.id} className="hover:bg-[var(--color-surface-muted)]">
                    <td className="px-3 py-2 whitespace-nowrap text-[var(--color-text-secondary)]">
                      {formatWhen(entry.createdAt)}
                    </td>
                    <td className="px-3 py-2 font-medium text-[var(--color-text-primary)]">{entry.customerName}</td>
                    <td className="px-3 py-2 text-[var(--color-text-secondary)]">{TYPE_LABELS[entry.type]}</td>
                    <td className="px-3 py-2 text-[var(--color-text-secondary)]">
                      {entry.orderNumber ? <span className="font-medium">บิล {entry.orderNumber}</span> : null}
                      {entry.reason ? <span className="block text-xs">{entry.reason}</span> : null}
                    </td>
                    <td
                      className={`px-3 py-2 text-right font-bold tabular-nums ${
                        entry.pointsDelta < 0 ? "text-[var(--color-danger,#b91c1c)]" : "text-emerald-700"
                      }`}
                    >
                      {entry.pointsDelta > 0 ? "+" : ""}
                      {formatPoints(entry.pointsDelta)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="flex items-center justify-between gap-3 px-3 py-3 text-sm text-[var(--color-text-secondary)]">
              <span>
                แสดง {pageFrom.toLocaleString("th-TH")}–{pageTo.toLocaleString("th-TH")} จาก{" "}
                {entryTotal.toLocaleString("th-TH")}
              </span>
              <span className="flex gap-2">
                <button
                  type="button"
                  className="btn-secondary text-xs"
                  disabled={offset === 0 || isPending}
                  onClick={() => goToOffset(offset - pageSize)}
                >
                  ก่อนหน้า
                </button>
                <button
                  type="button"
                  className="btn-secondary text-xs"
                  disabled={offset + entries.length >= entryTotal || isPending}
                  onClick={() => goToOffset(offset + pageSize)}
                >
                  ถัดไป
                </button>
              </span>
            </div>
          </>
        )}
      </Section>
    </div>
  );
}

function SummaryCard({
  label,
  value,
  sub,
  color,
}: {
  label: string;
  value: string;
  sub?: string;
  color: string;
}) {
  return (
    <div className="panel p-4">
      <p className="text-xs text-[var(--color-text-muted)]">{label}</p>
      <p className={`text-xl font-bold tabular-nums ${color}`}>{value}</p>
      {sub ? <p className="text-xs text-[var(--color-text-muted)]">{sub}</p> : null}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="panel overflow-x-auto">
      <h2 className="panel-title px-3 pt-3">{title}</h2>
      {children}
    </div>
  );
}

function EmptyRow() {
  return <p className="px-3 py-6 text-sm text-[var(--muted)]">ยังไม่มีรายการแต้มในช่วงเวลานี้</p>;
}
