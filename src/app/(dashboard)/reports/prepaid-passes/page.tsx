import Link from "next/link";
import { redirect } from "next/navigation";
import { getResolvedCurrentPermissions } from "@/modules/auth/guards";
import { bangkokToday, INSIGHTS_PRESETS, resolveInsightsRange } from "@/modules/reports/insights";
import { getPassReport } from "@/modules/prepaid-passes/report";

export const dynamic = "force-dynamic";

const money = (value: number) =>
  new Intl.NumberFormat("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
const count = (value: number) => new Intl.NumberFormat("th-TH").format(value);

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="panel p-4">
      <p className="text-xs font-semibold text-[var(--color-text-muted)]">{label}</p>
      <p className="mt-1 text-2xl font-black tabular-nums text-[var(--color-text-primary)]">{value}</p>
      {hint && <p className="mt-1 text-xs text-[var(--color-text-muted)]">{hint}</p>}
    </div>
  );
}

export default async function PrepaidPassReportPage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const { ctx, resolved } = await getResolvedCurrentPermissions();
  if (!resolved.can("reports.view")) redirect("/dashboard");

  const params = await searchParams;
  const today = bangkokToday();
  const range = resolveInsightsRange({ range: params.range ?? "mtd", from: params.from, to: params.to }, today);
  const { data, error } = await getPassReport(ctx.storeId, range.from, range.to);

  return (
    <div className="page-shell">
      <div className="page-header">
        <div>
          <h1 className="page-title">รายงานแพ็กซื้อล่วงหน้า</h1>
          <p className="page-kicker">
            เงินขายแพ็กเป็นรายได้รับล่วงหน้า — รับรู้เป็นรายได้จริงตอนลูกค้าใช้สิทธิ์ (มูลค่าต่อสิทธิ์ × จำนวนที่ใช้)
          </p>
        </div>
        <Link href="/reports" className="btn-secondary">
          ← รายงาน
        </Link>
      </div>

      <div className="flex flex-wrap gap-2">
        {INSIGHTS_PRESETS.map((preset) => (
          <Link
            key={preset.key}
            href={`/reports/prepaid-passes?range=${preset.key}`}
            className={range.preset === preset.key ? "btn-primary" : "btn-secondary"}
          >
            {preset.label}
          </Link>
        ))}
        <span className="self-center text-sm text-[var(--color-text-muted)]">
          {range.from} ถึง {range.to}
        </span>
      </div>

      {error && (
        <p className="alert-danger" role="alert">
          โหลดรายงานไม่สำเร็จ: {error}
        </p>
      )}

      {data && (
        <>
          <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat
              label="ขายแพ็ก (เงินเข้า)"
              value={`฿${money(data.sold.valueAll)}`}
              hint={`${count(data.sold.countAll)} แพ็ก · POS ${count(data.sold.countPos)} · ออนไลน์ ${count(data.sold.countOnline)}`}
            />
            <Stat
              label="รายได้ที่รับรู้จากการใช้สิทธิ์"
              value={`฿${money(data.sold.valueRecognized)}`}
              hint={`ใช้ไป ${count(data.sold.creditsUsed)} สิทธิ์ที่สาขานี้`}
            />
            <Stat
              label="ยอดคงค้าง (ต้องให้บริการต่อ)"
              value={`฿${money(data.outstanding.value)}`}
              hint={`${count(data.outstanding.credits)} สิทธิ์ ใน ${count(data.outstanding.passes)} แพ็ก · ณ ตอนนี้`}
            />
            <Stat
              label="สิทธิ์หมดอายุ/ยกเลิก"
              value={`฿${money(data.sold.valueExpired + data.sold.valueVoided)}`}
              hint={`หมดอายุ ${count(data.sold.creditsExpired)} สิทธิ์ · ยกเลิกบิลขาย ${count(data.sold.countVoided)} แพ็ก`}
            />
          </section>

          {data.outstanding.expiring7d > 0 && (
            <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
              มี {count(data.outstanding.expiring7d)} แพ็กจะหมดอายุภายใน 7 วัน — แจ้งลูกค้าให้มาใช้สิทธิ์ได้
            </p>
          )}

          <section className="panel overflow-x-auto p-4">
            <h2 className="mb-2 text-base font-bold text-[var(--color-text-primary)]">แยกตามแพ็ก</h2>
            {data.byPlan.length === 0 ? (
              <p className="text-sm text-[var(--color-text-muted)]">ช่วงนี้ยังไม่มีการขายหรือใช้แพ็ก</p>
            ) : (
              <table className="w-full min-w-[520px] text-sm">
                <thead>
                  <tr className="text-left text-xs text-[var(--color-text-muted)]">
                    <th className="py-2">แพ็ก</th>
                    <th className="py-2 text-right">ขาย (แพ็ก)</th>
                    <th className="py-2 text-right">เงินเข้า</th>
                    <th className="py-2 text-right">ใช้สิทธิ์</th>
                    <th className="py-2 text-right">รายได้ที่รับรู้</th>
                  </tr>
                </thead>
                <tbody>
                  {data.byPlan.map((row) => (
                    <tr key={row.planId || row.planName} className="border-t border-[var(--color-border)]">
                      <td className="py-2">{row.planName}</td>
                      <td className="py-2 text-right tabular-nums">{count(row.sold)}</td>
                      <td className="py-2 text-right tabular-nums">฿{money(row.soldValue)}</td>
                      <td className="py-2 text-right tabular-nums">{count(row.creditsUsed)}</td>
                      <td className="py-2 text-right tabular-nums">฿{money(row.valueRecognized)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <p className="text-xs text-[var(--color-text-muted)]">
            ขายแพ็กนับที่สาขาที่ขาย · ใช้สิทธิ์นับที่สาขาที่ลูกค้ามาใช้ · ยอดคงค้างนับแพ็กที่สาขานี้ขาย ·
            ยอดขาย POS ปกติยังรวมเงินขายแพ็กไว้ในวันที่ขาย (บรรทัดใช้แพ็กเป็น ฿0) · ขายออนไลน์ลงบัญชีรายรับหมวด “ขายแพ็กออนไลน์”
          </p>
        </>
      )}
    </div>
  );
}
