import { redirect } from "next/navigation";
import { getResolvedCurrentPermissions } from "@/modules/auth/guards";
import { listEmployeeProfiles, listPayrollAdjustments, getStoreHrSettings } from "@/modules/hr/repository";
import {
  listAttendanceRecords,
  computePayrollSummaries,
  listStoreHolidays,
} from "@/modules/attendance/repository";
import { listStoreMemberships } from "@/modules/settings/repository";
import {
  computePayrollLines,
  type PayrollDay,
  type PayrollDayStatus,
  type PayrollLine,
} from "@/modules/hr/payroll";
import { getStore } from "@/modules/stores/repository";
import { getStoreLocalDate, formatStoreTime } from "@/modules/attendance/date";
import { ADJUSTMENT_LABEL, DEDUCTION_TYPES, PAY_TYPE_LABEL } from "@/modules/hr/types";
import { PrintButton } from "./PrintButton";

export const dynamic = "force-dynamic";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isValidDate = (s: string) => DATE_RE.test(s) && !isNaN(Date.parse(s));
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function money(n: number, currency: string): string {
  return new Intl.NumberFormat("th-TH", { style: "currency", currency, maximumFractionDigits: 2 }).format(n);
}

function Row({
  label,
  value,
  strong,
  muted,
}: {
  label: string;
  value: string;
  strong?: boolean;
  muted?: boolean;
}) {
  return (
    <div
      className={`flex justify-between gap-4 py-1 ${
        strong ? "mt-1 border-t border-gray-400 pt-2 text-base font-bold" : ""
      } ${muted ? "text-gray-500" : ""}`}
    >
      <span>{label}</span>
      <span className="whitespace-nowrap tabular-nums">{value}</span>
    </div>
  );
}

const DAY_STATUS_LABEL: Record<PayrollDayStatus, string> = {
  full: "ทำงานเต็มวัน",
  half: "ทำงานครึ่งวัน",
  in_no_out: "เข้างานไม่ลงออก (นับขาด)",
  unpaid_holiday: "นอกวันทำงาน · เข้างานไม่ครบ (ไม่คิดเงิน)",
  absent: "ขาดงาน",
  leave: "ลา",
  holiday: "วันหยุดร้าน",
  off: "วันหยุดประจำ",
};

const DAY_STATUS_CLASS: Record<PayrollDayStatus, string> = {
  full: "text-green-700",
  half: "text-yellow-700",
  in_no_out: "text-red-700",
  unpaid_holiday: "text-gray-500",
  absent: "text-red-700",
  leave: "text-blue-700",
  holiday: "text-gray-500",
  off: "text-gray-400",
};

const THAI_WEEKDAY = ["อา", "จ", "อ", "พ", "พฤ", "ศ", "ส"];

function weekdayLabel(date: string): string {
  return THAI_WEEKDAY[new Date(`${date}T12:00:00Z`).getUTCDay()] ?? "";
}

function hoursLabel(hours: number): string {
  if (hours <= 0) return "—";
  const h = Math.floor(hours);
  const m = Math.round((hours - h) * 60);
  return m > 0 ? `${h} ชม. ${m} น.` : `${h} ชม.`;
}

/** ตารางรายวัน — ที่มาของทุกยอดบนสลิป เจ้าของและพนักงานตรวจย้อนได้ทีละวัน */
function DailyTable({ days, timeZone }: { days: PayrollDay[]; timeZone: string }) {
  const shown = days.filter((d) => d.status !== "off" || d.hours > 0);
  if (shown.length === 0) return null;
  return (
    <div className="mt-4">
      <p className="mb-1 text-sm font-semibold">รายละเอียดรายวัน</p>
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr className="border-b border-gray-300 text-left text-gray-500">
            <th className="py-1 font-medium">วันที่</th>
            <th className="py-1 font-medium">เข้า</th>
            <th className="py-1 font-medium">ออก</th>
            <th className="py-1 text-right font-medium">รวม</th>
            <th className="py-1 font-medium">สถานะ</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((d) => (
            <tr key={d.date} className="border-b border-gray-100">
              <td className="whitespace-nowrap py-1">
                {d.date.slice(8)}/{d.date.slice(5, 7)} ({weekdayLabel(d.date)})
              </td>
              <td className="py-1 tabular-nums">{d.clockInAt ? formatStoreTime(d.clockInAt, timeZone) : "—"}</td>
              <td className="py-1 tabular-nums">{d.clockOutAt ? formatStoreTime(d.clockOutAt, timeZone) : "—"}</td>
              <td className="py-1 text-right tabular-nums">{hoursLabel(d.hours)}</td>
              <td className={`py-1 ${DAY_STATUS_CLASS[d.status]}`}>
                {DAY_STATUS_LABEL[d.status]}
                {d.late && d.hours > 0 ? ` · สาย ${d.lateMinutes} น.` : ""}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Payslip({
  line,
  currency,
  storeName,
  dateFrom,
  dateTo,
  timeZone,
  otMultiplier,
}: {
  line: PayrollLine;
  currency: string;
  storeName: string;
  dateFrom: string;
  dateTo: string;
  timeZone: string;
  otMultiplier: number;
}) {
  const count = (status: PayrollDayStatus) => line.days.filter((d) => d.status === status).length;
  const leaveDays = count("leave");
  const holidayDays = count("holiday");
  const inNoOutDays = count("in_no_out");
  const trueAbsentDays = count("absent");
  const lateDays = line.days.filter((d) => d.late && d.hours > 0).length;
  const totalDeduction = line.latePenalty + line.absentPenalty + line.halfDayDeduction + line.deductionTotal;
  const totalEarning = line.basePay + line.otPay + line.bonusTotal;

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

      {/* สรุปการเข้างาน */}
      <div className="mb-4 rounded border border-gray-200 bg-gray-50 p-3 text-sm">
        <p className="mb-1 font-semibold">สรุปการเข้างาน</p>
        <Row label="วันที่มาทำงาน" value={`${line.totalDays} วัน`} />
        {line.halfDays > 0 && (
          <Row
            label={`· เต็มวัน ${line.fullDays} วัน / ครึ่งวัน ${line.halfDays} วัน`}
            value={`คิดค่าแรง ${line.payableDays} วัน`}
            muted
          />
        )}
        <Row label="ชั่วโมงทำงานรวม" value={hoursLabel(line.totalHours)} />
        {line.otHours > 0 && <Row label="ชั่วโมง OT" value={hoursLabel(line.otHours)} muted />}
        {lateDays > 0 && <Row label="วันที่มาสาย" value={`${lateDays} วัน`} muted />}
        {trueAbsentDays > 0 && <Row label="วันขาดงาน (ไม่มีบันทึก)" value={`${trueAbsentDays} วัน`} muted />}
        {inNoOutDays > 0 && (
          <Row label="วันที่เข้างานแต่ไม่ลงออก (นับเป็นขาด)" value={`${inNoOutDays} วัน`} muted />
        )}
        {line.unpaidHolidayDays > 0 && (
          <Row
            label="วันหยุด/นอกวันทำงานที่เข้างานไม่ครบ (ไม่คิดเงิน / ไม่นับขาด)"
            value={`${line.unpaidHolidayDays} วัน`}
            muted
          />
        )}
        {leaveDays > 0 && <Row label="วันลา" value={`${leaveDays} วัน`} muted />}
        {holidayDays > 0 && <Row label="วันหยุดร้าน" value={`${holidayDays} วัน`} muted />}
      </div>

      {/* รายรับ / รายการหัก */}
      <div className="text-sm">
        <p className="mb-1 font-semibold">รายรับ</p>
        <Row
          label={
            line.payType === "daily"
              ? `ค่าจ้างพื้นฐาน (${line.payableDays} วัน)`
              : line.payType === "hourly"
                ? `ค่าจ้างพื้นฐาน (${hoursLabel(line.totalHours)})`
                : "ค่าจ้างพื้นฐาน (เงินเดือน)"
          }
          value={money(line.basePay, currency)}
        />
        {line.otPay > 0 && (
          <Row
            label={`ค่าล่วงเวลา (${line.otHours} ชม. × ${otMultiplier})`}
            value={`+${money(line.otPay, currency)}`}
          />
        )}
        {line.bonusTotal > 0 && <Row label="โบนัส/เพิ่มเติม" value={`+${money(line.bonusTotal, currency)}`} />}
        <Row label="รวมรายรับ" value={money(totalEarning, currency)} />

        <p className="mb-1 mt-3 font-semibold">รายการหัก</p>
        {totalDeduction === 0 ? (
          <Row label="ไม่มีรายการหัก" value="—" muted />
        ) : (
          <>
            {line.latePenalty > 0 && (
              <Row label={`หักมาสาย (${lateDays} วัน)`} value={`−${money(line.latePenalty, currency)}`} />
            )}
            {line.absentPenalty > 0 && (
              <Row
                label={`หักขาดงาน (${line.absentDays} วัน × ${money(line.absentRatePerDay, currency)})`}
                value={`−${money(line.absentPenalty, currency)}`}
              />
            )}
            {line.halfDayDeduction > 0 && (
              <Row
                label={`หักครึ่งวัน (${line.halfDays} วัน × 50% × ${money(line.absentRatePerDay, currency)})`}
                value={`−${money(line.halfDayDeduction, currency)}`}
              />
            )}
            {line.adjustments
              .filter((a) => DEDUCTION_TYPES.includes(a.type))
              .map((a) => (
                <Row
                  key={a.id}
                  label={`${ADJUSTMENT_LABEL[a.type]} ${a.date}${a.note ? ` · ${a.note}` : ""}`}
                  value={`−${money(a.amount, currency)}`}
                />
              ))}
            <Row label="รวมรายการหัก" value={`−${money(totalDeduction, currency)}`} />
          </>
        )}
        <Row label="เงินสุทธิ" value={money(line.netPay, currency)} strong />
      </div>

      {line.adjustments.filter((a) => !DEDUCTION_TYPES.includes(a.type)).length > 0 && (
        <div className="mt-3 text-xs text-gray-500">
          <p className="font-semibold">รายการเพิ่ม:</p>
          {line.adjustments
            .filter((a) => !DEDUCTION_TYPES.includes(a.type))
            .map((a) => (
              <p key={a.id}>
                · {a.date} {ADJUSTMENT_LABEL[a.type]} {money(a.amount, currency)}
                {a.note ? ` (${a.note})` : ""}
              </p>
            ))}
        </div>
      )}

      <DailyTable days={line.days} timeZone={timeZone} />

      <p className="mt-4 border-t border-gray-200 pt-2 text-[11px] text-gray-400">
        สลิปนี้คำนวณจากบันทึกเข้า-ออกงานจริงในระบบ · ออกเมื่อ{" "}
        {new Date().toLocaleString("th-TH", { timeZone, dateStyle: "medium", timeStyle: "short" })}
      </p>
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

  const [membersRes, profilesRes, recordsRes, adjustmentsRes, holidaysRes, storeRes, hrSettings] = await Promise.all([
    listStoreMemberships(ctx.organizationId, ctx.storeId),
    listEmployeeProfiles(ctx.storeId),
    // Org-wide, then narrowed to this store's roster — same scope as /staff so the slip always
    // agrees with the table it was printed from.
    listAttendanceRecords(ctx.organizationId, null, dateFrom, dateTo),
    listPayrollAdjustments(ctx.storeId, dateFrom, dateTo),
    listStoreHolidays(ctx.storeId, dateFrom, dateTo),
    getStore(ctx.storeId),
    getStoreHrSettings(ctx.storeId, ctx.organizationId),
  ]);

  const roster = new Set(
    (membersRes.data ?? []).filter((m) => m.role !== "super_admin").map((m) => m.userId),
  );
  const records = (recordsRes.data ?? []).filter((r) => roster.has(r.userId));
  const summaries = computePayrollSummaries(records, null, ctx.organizationId, dateFrom, dateTo);
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
                <th className="py-2 text-right">วันที่จ่าย</th>
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
                  <td className="py-2 text-right tabular-nums">
                    {l.payableDays}
                    {l.halfDays > 0 ? ` (ครึ่งวัน ${l.halfDays})` : ""}
                  </td>
                  <td className="py-2 text-right">{money(l.basePay, currency)}</td>
                  <td className="py-2 text-right">{l.otPay ? money(l.otPay, currency) : "—"}</td>
                  <td className="py-2 text-right">
                    {money(l.latePenalty + l.absentPenalty + l.halfDayDeduction + l.deductionTotal, currency)}
                  </td>
                  <td className="py-2 text-right font-semibold">{money(l.netPay, currency)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-gray-300 font-bold">
                <td className="py-2">รวมทั้งหมด ({lines.length} คน)</td>
                <td colSpan={4} />
                <td className="py-2 text-right">{money(grandTotal, currency)}</td>
              </tr>
            </tfoot>
          </table>
        </section>
      ) : (
        lines.map((l) => (
          <Payslip
            key={l.userId}
            line={l}
            currency={currency}
            storeName={storeName}
            dateFrom={dateFrom}
            dateTo={dateTo}
            timeZone={ctx.storeTimezone}
            otMultiplier={hrSettings.otMultiplier}
          />
        ))
      )}
    </main>
  );
}
