import Link from "next/link";
import { getConsignmentAccess } from "@/modules/consignment/access";
import { getDailyReport, listResaleProducts, listSettlements } from "@/modules/consignment/repository";
import type { DailyReportRow } from "@/modules/consignment/types";
import { validateReportRange } from "@/modules/consignment/validate";
import { listSuppliers } from "@/modules/inventory/repository";
import { baht, ConsignmentHeader, ConsignmentLocked, inputClass, itemLabel, NotEnabledNotice } from "../ConsignmentChrome";

export const dynamic = "force-dynamic";

const TRIGGER_LABEL = { daily_close: "ปิดรอบ", restock: "เติมของ", manual: "เคลียร์เอง" } as const;

function bangkokToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok" }).format(new Date());
}

export default async function ConsignmentReportPage({ searchParams }: { searchParams: Promise<{ from?: string; to?: string }> }) {
  const { ctx, decision } = await getConsignmentAccess();
  if (!decision.allowed) return <ConsignmentLocked message={decision.message} />;
  if (!decision.enabled) {
    return (
      <section className="page-shell max-w-5xl space-y-5">
        <ConsignmentHeader active="/consignment/report" description="ยอดรายวันต่อเจ้าของ" />
        <NotEnabledNotice />
      </section>
    );
  }
  const params = await searchParams;
  const today = bangkokToday();
  const range = validateReportRange(params.from ?? today, params.to ?? today);
  const from = "error" in range ? today : range.from;
  const to = "error" in range ? today : range.to;

  const [reportRes, productsRes, suppliersRes, settlementsRes] = await Promise.all([
    getDailyReport(ctx.storeId, from, to),
    listResaleProducts(ctx.storeId),
    listSuppliers(ctx.storeId),
    listSettlements(ctx.storeId, 30),
  ]);
  const error = reportRes.error ?? productsRes.error ?? suppliersRes.error ?? settlementsRes.error;
  if (error) return <ConsignmentLocked message={error} />;
  const products = productsRes.data ?? [];
  const supplierName = new Map((suppliersRes.data ?? []).map((s) => [s.id, s.name]));
  const rows = reportRes.data ?? [];

  // จัดกลุ่ม วัน → เจ้าของ
  const byDay = new Map<string, Map<string, DailyReportRow[]>>();
  for (const r of rows) {
    const day = byDay.get(r.day) ?? new Map<string, DailyReportRow[]>();
    const list = day.get(r.supplierId) ?? [];
    list.push(r);
    day.set(r.supplierId, list);
    byDay.set(r.day, day);
  }
  const sum = (list: DailyReportRow[], k: keyof DailyReportRow) => list.reduce((s, r) => s + (r[k] as number), 0);
  const totals = {
    qty: sum(rows, "qtySold"),
    gross: sum(rows, "grossSales"),
    due: sum(rows, "ownerDue"),
    cost: sum(rows, "resaleCost"),
    profit: sum(rows, "storeProfit"),
    unsettled: sum(rows, "unsettledDue"),
  };

  return (
    <section className="page-shell max-w-5xl space-y-5">
      <ConsignmentHeader active="/consignment/report" description="ยอดรายวันต่อเจ้าของ: ขายได้ ต้องจ่าย ร้านได้ ยังไม่เคลียร์ ของเสีย และคืนของ (นับเฉพาะบิลที่จ่ายแล้ว)" />

      <form className="flex flex-wrap items-end gap-2" action="/consignment/report">
        <label className="block text-sm">
          <span className="text-[var(--muted)]">ตั้งแต่</span>
          <input type="date" name="from" defaultValue={from} className={inputClass} />
        </label>
        <label className="block text-sm">
          <span className="text-[var(--muted)]">ถึง</span>
          <input type="date" name="to" defaultValue={to} className={inputClass} />
        </label>
        <button type="submit" className="btn-primary min-h-11">ดู</button>
        <Link href="/consignment/report" className="btn-secondary inline-flex min-h-11 items-center">วันนี้</Link>
      </form>
      {"error" in range && <p className="text-sm text-red-700">{range.error} — แสดงวันนี้แทน</p>}

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        {[
          ["ขายได้ (ชิ้น)", String(totals.qty)],
          ["ยอดขาย", baht(totals.gross)],
          ["ต้องจ่ายเจ้าของ", baht(totals.due)],
          ["ต้นทุนซื้อขาด/เสียหาย", baht(totals.cost)],
          ["ร้านได้", baht(totals.profit)],
          ["ยังไม่เคลียร์", baht(totals.unsettled)],
        ].map(([label, value]) => (
          <div key={label} className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3">
            <p className="text-xs text-[var(--muted)]">{label}</p>
            <p className="text-lg font-bold text-[var(--ink)]">{value}</p>
          </div>
        ))}
      </div>

      {rows.length === 0 ? (
        <p className="rounded-xl border border-dashed border-[var(--border)] p-6 text-center text-sm text-[var(--muted)]">ไม่มีรายการในช่วงนี้</p>
      ) : (
        [...byDay.entries()].map(([day, suppliers]) => (
          <div key={day} className="space-y-2">
            <h2 className="text-base font-semibold text-[var(--ink)]">{new Date(`${day}T00:00:00`).toLocaleDateString("th-TH", { dateStyle: "full" })}</h2>
            {[...suppliers.entries()].map(([sid, list]) => (
              <div key={sid} className="overflow-x-auto rounded-xl border border-[var(--border)] bg-[var(--surface)]">
                <div className="flex flex-wrap justify-between gap-2 border-b border-[var(--border)] p-2 text-sm">
                  <span className="font-semibold">{supplierName.get(sid) ?? "เจ้าของที่ถูกลบ"}</span>
                  <span className="text-[var(--muted)]">
                    ร้านได้ {baht(sum(list, "storeProfit"))}
                    {sum(list, "unsettledDue") > 0 ? ` · ยังไม่เคลียร์ ${baht(sum(list, "unsettledDue"))}` : ""}
                  </span>
                </div>
                <table className="w-full min-w-[640px] text-sm">
                  <thead className="text-left text-xs text-[var(--muted)]">
                    <tr>
                      <th className="p-2">เมนู/รส</th>
                      <th className="p-2">แบบ</th>
                      <th className="p-2 text-right">ขาย</th>
                      <th className="p-2 text-right">ยอดขาย</th>
                      <th className="p-2 text-right">จ่ายเจ้าของ/ต้นทุน</th>
                      <th className="p-2 text-right">ร้านได้</th>
                      <th className="p-2">อื่น ๆ</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--border)]">
                    {list.map((r) => (
                      <tr key={`${r.productId}:${r.optionId ?? "-"}:${r.mode}`}>
                        <td className="p-2">{itemLabel(products, r.productId, r.optionId)}</td>
                        <td className="p-2">{r.mode === "resale" ? "ซื้อขาด" : "ฝากขาย"}</td>
                        <td className="p-2 text-right">{r.qtySold}</td>
                        <td className="p-2 text-right">{baht(r.grossSales)}</td>
                        <td className="p-2 text-right">{baht(r.ownerDue + r.resaleCost)}</td>
                        <td className={`p-2 text-right ${r.storeProfit < 0 ? "text-red-700" : ""}`}>{baht(r.storeProfit)}</td>
                        <td className="p-2 text-xs text-[var(--muted)]">
                          {[
                            r.damagedStore ? `เสีย (ร้าน) ${r.damagedStore}` : null,
                            r.damagedOwner ? `เสีย/หาย (เจ้าของ) ${r.damagedOwner}` : null,
                            r.returned ? `คืน ${r.returned}` : null,
                            r.boughtOut ? `ร้านซื้อไว้ ${r.boughtOut}` : null,
                          ]
                            .filter(Boolean)
                            .join(" · ") || "-"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </div>
        ))
      )}

      <div className="space-y-2">
        <h2 className="text-lg font-semibold text-[var(--ink)]">ประวัติการเคลียร์เงิน</h2>
        {(settlementsRes.data ?? []).length === 0 ? (
          <p className="text-sm text-[var(--muted)]">ยังไม่มี</p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-[var(--border)] bg-[var(--surface)]">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="text-left text-xs text-[var(--muted)]">
                <tr>
                  <th className="p-2">เวลา</th>
                  <th className="p-2">เจ้าของ</th>
                  <th className="p-2">จาก</th>
                  <th className="p-2 text-right">ชิ้น</th>
                  <th className="p-2 text-right">ยอดจ่าย</th>
                  <th className="p-2">วิธี</th>
                  <th className="p-2 text-right">ยกไป</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border)]">
                {(settlementsRes.data ?? []).map((s) => (
                  <tr key={s.id}>
                    <td className="p-2">{new Date(s.settledAt).toLocaleString("th-TH")}</td>
                    <td className="p-2">{supplierName.get(s.supplierId) ?? "-"}</td>
                    <td className="p-2">{TRIGGER_LABEL[s.triggerKind]}</td>
                    <td className="p-2 text-right">{s.qtySold}</td>
                    <td className="p-2 text-right">{baht(s.paidAmount)}</td>
                    <td className="p-2">{s.payoutMethod === "cash" ? "เงินสด" : s.payoutMethod === "transfer" ? "โอน" : "-"}</td>
                    <td className="p-2 text-right">{s.carryOut > 0 ? `−${baht(s.carryOut)}` : "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
