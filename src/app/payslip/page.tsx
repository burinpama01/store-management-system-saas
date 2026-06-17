import { redirect } from "next/navigation";
import { getResolvedCurrentPermissions } from "@/modules/auth/guards";
import { listEmployeeProfiles, listPayrollAdjustments, getStoreHrSettings } from "@/modules/hr/repository";
import { listAttendanceRecords, computePayrollSummaries, listStoreHolidays } from "@/modules/attendance/repository";
import { computePayrollLines, type PayrollLine } from "@/modules/hr/payroll";
import { getStore } from "@/modules/stores/repository";
import { getStoreLocalDate } from "@/modules/attendance/date";
import { PAY_TYPE_LABEL } from "@/modules/hr/types";
import { PrintButton } from "./PrintButton";

export const dynamic = "force-dynamic";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isValidDate = (s: string) => DATE_RE.test(s) && !isNaN(Date.parse(s));
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function money(n: number, currency: string): string {
  return new Intl.NumberFormat("th-TH", { style: "currency", currency, maximumFractionDigits: 2 }).format(n);
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={`flex justify-between py-1 ${strong ? "border-t border-gray-300 font-bold" : ""}`}>
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );
}

function Payslip({ line, currency, storeName, dateFrom, dateTo }: {
  line: PayrollLine; currency: string; storeName: string; dateFrom: string; dateTo: string;
}) {
  return (
    <section className="mb-8 break-inside-avoid rounded-lg border border-gray-300 p-6">
      <div className="mb-4 flex items-start justify-between">
        <div>
          <h2 className="text-lg font-bold">{storeName}</h2>
          <p className="text-sm text-gray-500">สลิปเงินเดือน · {dateFrom} ถึง {dateTo}</p>
        </div>
        <div className="text-right">
          <p className="font-semibold">{line.employeeName}</p>
          <p className="text-sm text-gray-500">{PAY_TYPE_LABEL[line.payType]}</p>
        </div>
      </div>
      <div className="text-sm">
        <Row label={`จำนวนวันทำงาน`} value={`${line.totalDays} วัน`} />
        <Row label={`ชั่วโมงรวม`} value={`${line.totalHours} ชม.`} />
        <Row label="ค่าจ้างพื้นฐาน" value={money(line.basePay, currency)} />
        {line.otPay > 0 && <Row label={`ค่าล่วงเวลา (OT ${line.otHours} ชม.)`} value={`+${money(line.otPay, currency)}`} />}
        {line.bonusTotal > 0 && <Row label="โบนัส/เพิ่มเติม" value={`+${money(line.bonusTotal, currency)}`} />}
        {line.latePenalty > 0 && <Row label="หักมาสาย" value={`−${money(line.latePenalty, currency)}`} />}
        {line.absentPenalty > 0 && <Row label={`หักขาดงาน (${line.absentDays} วัน)`} value={`−${money(line.absentPenalty, currency)}`} />}
        {line.deductionTotal > 0 && <Row label="หักอื่นๆ" value={`−${money(line.deductionTotal, currency)}`} />}
        <Row label="เงินสุทธิ" value={money(line.netPay, currency)} strong />
      </div>
      {line.adjustments.length > 0 && (
        <div className="mt-3 text-xs text-gray-500">
          <p className="font-semibold">รายการปรับ:</p>
          {line.adjustments.map((a) => (
            <p key={a.id}>· {a.date} {a.type} {money(a.amount, currency)}{a.note ? ` (${a.note})` : ""}</p>
          ))}
        </div>
      )}
    </section>
  );
}

export default async function PayslipPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string>>;
}) {
  const { ctx, resolved } = await getResolvedCurrentPermissions();
  if (!resolved.can("attendance.manage")) redirect("/dashboard");

  const params = await searchParams;
  const today = getStoreLocalDate(ctx.storeTimezone);
  let dateFrom = isValidDate(params.dateFrom ?? "") ? params.dateFrom! : today.slice(0, 7) + "-01";
  let dateTo = isValidDate(params.dateTo ?? "") ? params.dateTo! : today;
  if (dateFrom > dateTo) [dateFrom, dateTo] = [dateTo, dateFrom];
  const mode = params.mode === "summary" ? "summary" : "payslip";
  const userId = params.userId && UUID_RE.test(params.userId) ? params.userId : null;

  const [profilesRes, recordsRes, adjustmentsRes, holidaysRes, storeRes, hrSettings] = await Promise.all([
    listEmployeeProfiles(ctx.storeId),
    listAttendanceRecords(ctx.organizationId, ctx.storeId, dateFrom, dateTo),
    listPayrollAdjustments(ctx.storeId, dateFrom, dateTo),
    listStoreHolidays(ctx.storeId, dateFrom, dateTo),
    getStore(ctx.storeId),
    getStoreHrSettings(ctx.storeId, ctx.organizationId),
  ]);

  const records = recordsRes.data ?? [];
  const summaries = computePayrollSummaries(records, ctx.storeId, ctx.organizationId, dateFrom, dateTo);
  let lines = computePayrollLines({
    summaries,
    records,
    profiles: profilesRes.data ?? [],
    adjustments: adjustmentsRes.data ?? [],
    settings: hrSettings,
    holidayDates: (holidaysRes.data ?? []).map((h) => h.date),
    periodStart: dateFrom,
    periodEnd: dateTo,
    today,
    timezone: ctx.storeTimezone,
  });
  if (userId) lines = lines.filter((l) => l.userId === userId);

  const currency = storeRes.data?.currencyCode ?? "THB";
  const storeName = ctx.storeName;
  const grandTotal = lines.reduce((s, l) => s + l.netPay, 0);

  return (
    <main className="mx-auto max-w-3xl bg-white p-6 text-gray-900">
      <style>{`@media print { @page { margin: 12mm; } body { background: white; } }`}</style>
      <div className="mb-6 flex items-center justify-between print:hidden">
        <h1 className="text-xl font-bold">{mode === "summary" ? "สรุปเงินเดือนทั้งงวด" : "สลิปเงินเดือน"}</h1>
        <PrintButton />
      </div>

      {lines.length === 0 ? (
        <p className="text-center text-gray-400">ไม่มีข้อมูลในช่วงนี้</p>
      ) : mode === "summary" ? (
        <section>
          <div className="mb-4">
            <h2 className="text-lg font-bold">{storeName}</h2>
            <p className="text-sm text-gray-500">สรุปเงินเดือน · {dateFrom} ถึง {dateTo}</p>
          </div>
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b-2 border-gray-300 text-left">
                <th className="py-2">พนักงาน</th>
                <th className="py-2 text-right">ฐาน</th>
                <th className="py-2 text-right">OT</th>
                <th className="py-2 text-right">หัก</th>
                <th className="py-2 text-right">สุทธิ</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.userId} className="border-b border-gray-200">
                  <td className="py-2">{l.employeeName}</td>
                  <td className="py-2 text-right">{money(l.basePay, currency)}</td>
                  <td className="py-2 text-right">{l.otPay ? money(l.otPay, currency) : "—"}</td>
                  <td className="py-2 text-right">{money(l.latePenalty + l.absentPenalty + l.deductionTotal, currency)}</td>
                  <td className="py-2 text-right font-semibold">{money(l.netPay, currency)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-gray-300 font-bold">
                <td className="py-2">รวมทั้งหมด ({lines.length} คน)</td>
                <td colSpan={3} />
                <td className="py-2 text-right">{money(grandTotal, currency)}</td>
              </tr>
            </tfoot>
          </table>
        </section>
      ) : (
        lines.map((l) => (
          <Payslip key={l.userId} line={l} currency={currency} storeName={storeName} dateFrom={dateFrom} dateTo={dateTo} />
        ))
      )}
    </main>
  );
}
