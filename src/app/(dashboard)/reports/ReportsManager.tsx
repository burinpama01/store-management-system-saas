"use client";

import type { ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useTransition, useState } from "react";
import type {
  BranchSalesSummary,
  DailySales,
  PaymentMethodSummary,
  ReportData,
  TopProduct,
} from "@/modules/reports/types";
import { Button } from "@/shared/components/ui";

const METHOD_LABEL: Record<string, string> = {
  cash: "เงินสด",
  qr_promptpay: "QR PromptPay",
  credit_card: "บัตรเครดิต",
  bank_transfer: "โอนเงิน",
  other: "อื่นๆ",
};

function fmt(n: number) {
  return n.toLocaleString("th-TH", { minimumFractionDigits: 2 });
}

interface Props {
  reportData: ReportData;
  branchSummaries: BranchSalesSummary[];
  branchReportingEnabled: boolean;
  branchReportingUnavailableMessage: string | null;
  advancedReportsEnabled: boolean;
  advancedReportsUnavailableMessage: string | null;
  dateFrom: string;
  dateTo: string;
}

export function ReportsManager({
  reportData,
  branchSummaries,
  branchReportingEnabled,
  branchReportingUnavailableMessage,
  advancedReportsEnabled,
  advancedReportsUnavailableMessage,
  dateFrom,
  dateTo,
}: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [localFrom, setLocalFrom] = useState(dateFrom);
  const [localTo, setLocalTo] = useState(dateTo);

  const { salesSummary, paymentMethods, topProducts, dailySales } = reportData;

  function applyFilters() {
    const params = new URLSearchParams({ dateFrom: localFrom, dateTo: localTo });
    startTransition(() => router.push(`/reports?${params}`));
  }

  function exportCsv() {
    const rows: string[] = [];
    rows.push("ประเภท,รายการ,จำนวน,ยอดขาย");
    rows.push(`สรุป,ยอดขายรวม,${salesSummary.orderCount},${salesSummary.revenue}`);
    for (const m of paymentMethods) rows.push(`ช่องทางชำระเงิน,${m.method},${m.count},${m.totalAmount}`);
    for (const d of dailySales) rows.push(`รายวัน,${d.date},${d.orderCount},${d.revenue}`);
    for (const p of topProducts) rows.push(`สินค้าขายดี,${p.productName.replace(/,/g, " ")},${p.quantitySold},${p.revenue}`);
    const blob = new Blob(["﻿" + rows.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `report-${dateFrom}-${dateTo}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="page-shell">
      <div className="page-header">
        <div>
          <h1 className="page-title">รายงาน</h1>
          <p className="page-kicker">เปรียบเทียบยอดขาย ช่องทางชำระเงิน และสินค้าหลักตามช่วงเวลา</p>
        </div>
      </div>

      <div className="panel flex flex-wrap items-end gap-3 p-4">
        <div>
          <label className="field-label">ตั้งแต่</label>
          <input
            type="date"
            value={localFrom}
            onChange={(e) => setLocalFrom(e.target.value)}
            className="px-3 py-1.5 text-sm"
          />
        </div>
        <div>
          <label className="field-label">ถึง</label>
          <input
            type="date"
            value={localTo}
            onChange={(e) => setLocalTo(e.target.value)}
            className="px-3 py-1.5 text-sm"
          />
        </div>
        <Button
          variant="primary"
          onClick={applyFilters}
          loading={isPending}
          loadingText="กำลังโหลด..."
          className="disabled:opacity-50"
        >
          ดูรายงาน
        </Button>
        {advancedReportsEnabled && (
          <Button variant="secondary" onClick={exportCsv} className="ml-auto">
            ส่งออก CSV
          </Button>
        )}
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <SummaryCard label="ยอดขายรวม" value={`฿${fmt(salesSummary.revenue)}`} sub={`${salesSummary.orderCount} ออร์เดอร์`} color="text-green-600" />
        {advancedReportsEnabled && (
          <>
            <SummaryCard label="ค่าเฉลี่ย/ออร์เดอร์" value={`฿${fmt(salesSummary.avgOrderValue)}`} color="text-gray-700" />
            <SummaryCard label="QR Orders" value={String(salesSummary.qrOrderCount)} sub="จากระบบ QR" color="text-purple-600" />
            <SummaryCard label="POS Orders" value={String(salesSummary.posOrderCount)} sub="จาก POS" color="text-blue-600" />
          </>
        )}
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        {/* Payment methods (advanced) */}
        {advancedReportsEnabled && (
        <Section title="ช่องทางชำระเงิน">
          {paymentMethods.length === 0 ? (
            <EmptyRow />
          ) : (
            <div className="overflow-x-auto">
            <table className="min-w-[520px] w-full text-sm">
              <thead className="bg-[var(--color-surface-muted)] text-xs font-bold text-[var(--color-text-secondary)]">
                <tr>
                  <th className="px-3 py-2 text-left">ช่องทาง</th>
                  <th className="px-3 py-2 text-right">ครั้ง</th>
                  <th className="px-3 py-2 text-right">ยอดรวม</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-border)]">
                {paymentMethods.map((m) => (
                  <PaymentMethodRow key={m.method} item={m} />
                ))}
              </tbody>
            </table>
            </div>
          )}
        </Section>
        )}

        {/* Daily sales */}
        <Section title="ยอดขายรายวัน">
          {dailySales.length === 0 ? (
            <EmptyRow />
          ) : (
            <div className="overflow-x-auto">
            <table className="min-w-[520px] w-full text-sm">
              <thead className="bg-[var(--color-surface-muted)] text-xs font-bold text-[var(--color-text-secondary)]">
                <tr>
                  <th className="px-3 py-2 text-left">วันที่</th>
                  <th className="px-3 py-2 text-right">ออร์เดอร์</th>
                  <th className="px-3 py-2 text-right">ยอดขาย</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-border)]">
                {dailySales.map((d) => (
                  <DailySalesRow key={d.date} item={d} />
                ))}
              </tbody>
            </table>
            </div>
          )}
        </Section>
      </div>

      {branchReportingEnabled ? (
        <Section title="รายงานแยกสาขา">
          <BranchReportTable items={branchSummaries} />
        </Section>
      ) : (
        <div className="panel p-4">
          <p className="text-sm font-bold text-[var(--color-text-primary)]">รายงานแยกสาขา</p>
          <p className="mt-1 text-sm text-[var(--color-text-muted)]">
            {branchReportingUnavailableMessage ?? "แพ็กเกจนี้ยังไม่รองรับรายงานหลายสาขา"}
          </p>
        </div>
      )}

      {/* Top products (advanced) */}
      {advancedReportsEnabled ? (
        <Section title="สินค้าขายดี (Top 20)">
          {topProducts.length === 0 ? (
            <EmptyRow />
          ) : (
            <div className="overflow-x-auto">
            <table className="min-w-[520px] w-full text-sm">
              <thead className="bg-[var(--color-surface-muted)] text-xs font-bold text-[var(--color-text-secondary)]">
                <tr>
                  <th className="px-3 py-2 text-left">#</th>
                  <th className="px-3 py-2 text-left">สินค้า</th>
                  <th className="px-3 py-2 text-right">จำนวนที่ขาย</th>
                  <th className="px-3 py-2 text-right">ยอดขาย</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-border)]">
                {topProducts.map((p, i) => (
                  <TopProductRow key={p.productId} item={p} rank={i + 1} />
                ))}
              </tbody>
            </table>
            </div>
          )}
        </Section>
      ) : (
        <div className="panel p-4">
          <p className="text-sm font-bold text-[var(--color-text-primary)]">รายงานขั้นสูง</p>
          <p className="mt-1 text-sm text-[var(--color-text-muted)]">
            {advancedReportsUnavailableMessage ?? "แพ็กเกจนี้ยังไม่รองรับรายงานขั้นสูง"} —
            อัปเกรดเพื่อดูช่องทางชำระเงิน สินค้าขายดี ค่าเฉลี่ย/ออร์เดอร์ และส่งออก CSV
          </p>
        </div>
      )}
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
    <div className="metric-card p-4">
      <p className="label-muted mb-1">{label}</p>
      <p className={`text-xl font-extrabold tabular-nums ${color}`}>{value}</p>
      {sub && <p className="mt-1 text-xs text-[var(--color-text-muted)]">{sub}</p>}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="panel overflow-hidden">
      <div className="panel-header">
        <h2 className="panel-title">{title}</h2>
      </div>
      {children}
    </div>
  );
}

function EmptyRow() {
  return <p className="px-4 py-8 text-sm text-[var(--color-text-muted)] text-center">ไม่มีข้อมูลในช่วงเวลานี้</p>;
}

function BranchReportTable({ items }: { items: BranchSalesSummary[] }) {
  if (items.length === 0) return <EmptyRow />;

  return (
    <div className="overflow-x-auto">
      <table className="min-w-[760px] w-full text-sm">
        <thead className="bg-[var(--color-surface-muted)] text-xs font-bold text-[var(--color-text-secondary)]">
          <tr>
            <th className="px-3 py-2 text-left">สาขา</th>
            <th className="px-3 py-2 text-right">ยอดขาย</th>
            <th className="px-3 py-2 text-right">ออเดอร์</th>
            <th className="px-3 py-2 text-right">เฉลี่ย/บิล</th>
            <th className="px-3 py-2 text-right">POS</th>
            <th className="px-3 py-2 text-right">QR</th>
            <th className="px-3 py-2 text-right">สัดส่วน</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--color-border)]">
          {items.map((item) => (
            <tr key={item.storeId} className="hover:bg-[var(--color-surface-muted)]">
              <td className="px-3 py-2 font-medium text-[var(--color-text-primary)]">{item.storeName}</td>
              <td className="px-3 py-2 text-right font-bold tabular-nums text-[var(--color-success)]">
                ฿{fmt(item.revenue)}
              </td>
              <td className="px-3 py-2 text-right text-[var(--color-text-secondary)] tabular-nums">
                {item.orderCount}
              </td>
              <td className="px-3 py-2 text-right text-[var(--color-text-secondary)] tabular-nums">
                ฿{fmt(item.avgOrderValue)}
              </td>
              <td className="px-3 py-2 text-right text-[var(--color-text-secondary)] tabular-nums">
                {item.posOrderCount}
              </td>
              <td className="px-3 py-2 text-right text-[var(--color-text-secondary)] tabular-nums">
                {item.qrOrderCount}
              </td>
              <td className="px-3 py-2 text-right text-[var(--color-text-secondary)] tabular-nums">
                {item.revenueSharePercent.toLocaleString("th-TH", { maximumFractionDigits: 2 })}%
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PaymentMethodRow({ item }: { item: PaymentMethodSummary }) {
  return (
    <tr className="hover:bg-[var(--color-surface-muted)]">
      <td className="px-3 py-2 text-[var(--color-text-primary)]">{METHOD_LABEL[item.method] ?? item.method}</td>
      <td className="px-3 py-2 text-right text-[var(--color-text-secondary)] tabular-nums">{item.count}</td>
      <td className="px-3 py-2 text-right font-bold tabular-nums text-[var(--color-success)]">
        ฿{fmt(item.totalAmount)}
      </td>
    </tr>
  );
}

function DailySalesRow({ item }: { item: DailySales }) {
  return (
    <tr className="hover:bg-[var(--color-surface-muted)]">
      <td className="px-3 py-2 text-[var(--color-text-secondary)] whitespace-nowrap">{item.date}</td>
      <td className="px-3 py-2 text-right text-[var(--color-text-secondary)] tabular-nums">{item.orderCount}</td>
      <td className="px-3 py-2 text-right font-bold tabular-nums text-[var(--color-success)]">
        ฿{fmt(item.revenue)}
      </td>
    </tr>
  );
}

function TopProductRow({ item, rank }: { item: TopProduct; rank: number }) {
  return (
    <tr className="hover:bg-[var(--color-surface-muted)]">
      <td className="px-3 py-2 text-[var(--color-text-muted)] w-8">{rank}</td>
      <td className="px-3 py-2 font-medium text-[var(--color-text-primary)]">{item.productName}</td>
      <td className="px-3 py-2 text-right text-[var(--color-text-secondary)] tabular-nums">{item.quantitySold}</td>
      <td className="px-3 py-2 text-right font-bold tabular-nums text-[var(--color-success)]">
        ฿{fmt(item.revenue)}
      </td>
    </tr>
  );
}
