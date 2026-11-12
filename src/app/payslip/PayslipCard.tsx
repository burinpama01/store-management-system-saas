/**
 * การ์ดสลิปเงินเดือน — ใช้ร่วมกัน: ผู้จัดการ (/payslip) และพนักงาน (/my-payslips)
 * รับได้ทั้งบรรทัดที่คำนวณสด และบรรทัดจากสลิปถาวร (snapshot) — ส่วนขั้นสูงเป็น optional
 * แสดงรายการขั้นสูงเฉพาะเมื่อมียอด (ร้านไม่เปิดฟีเจอร์ = ไม่มียอด = ไม่แสดง — R18, R32)
 */
import type { PayrollDay, PayrollDayStatus, PayrollLine } from "@/modules/hr/payroll";
import type { AdvancedPayrollLine } from "@/modules/hr/advanced/compute";
import { formatStoreTime } from "@/modules/attendance/date";
import {
  ADJUSTMENT_LABEL,
  DEDUCTION_TYPES,
  EMPLOYMENT_TYPE_LABEL,
  PAY_TYPE_LABEL,
  type EmploymentType,
} from "@/modules/hr/types";

export function money(n: number, currency: string): string {
  return new Intl.NumberFormat("th-TH", { style: "currency", currency, maximumFractionDigits: 2 }).format(n);
}

function Row({ label, value, strong, muted }: { label: string; value: string; strong?: boolean; muted?: boolean }) {
  return (
    <div
      className={`flex justify-between gap-4 py-1 ${strong ? "mt-1 border-t border-gray-400 pt-2 text-base font-bold" : ""} ${
        muted ? "text-gray-500" : ""
      }`}
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

export function hoursLabel(hours: number): string {
  if (hours <= 0) return "—";
  const h = Math.floor(hours);
  const m = Math.round((hours - h) * 60);
  return m > 0 ? `${h} ชม. ${m} น.` : `${h} ชม.`;
}

/** ตารางรายวัน — ที่มาของทุกยอดบนสลิป เจ้าของและพนักงานตรวจย้อนได้ทีละวัน */
function DailyTable({ days, timeZone, bonusByDate }: { days: PayrollDay[]; timeZone: string; bonusByDate: Map<string, { amount: number; record: boolean }> }) {
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
          {shown.map((d) => {
            const bonus = bonusByDate.get(d.date);
            return (
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
                  {bonus ? ` · โบนัสยอดขาย +${bonus.amount}${bonus.record ? " 👑" : ""}` : ""}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export interface PayslipEmployeeInfo {
  fullName?: string;
  employeeCode?: string;
  position?: string;
  employmentType?: EmploymentType;
  bankName?: string;
  bankAccountMasked?: string;
}

function monthsLabel(months: number): string {
  const y = Math.floor(months / 12);
  const m = months % 12;
  return [y ? `${y} ปี` : "", m ? `${m} เดือน` : ""].filter(Boolean).join(" ") || "ไม่ถึง 1 เดือน";
}

export function PayslipCard({
  line,
  currency,
  issuer,
  employee,
  dateFrom,
  dateTo,
  timeZone,
  otMultiplier,
  docNo,
  payDate,
  revision,
  issuedAt,
}: {
  line: PayrollLine & Partial<AdvancedPayrollLine>;
  currency: string;
  issuer: { name: string; address?: string; taxId?: string };
  employee?: PayslipEmployeeInfo;
  dateFrom: string;
  dateTo: string;
  timeZone: string;
  otMultiplier: number;
  docNo?: string;
  payDate?: string;
  revision?: number;
  /** เวลาที่ออกสลิป (สลิปถาวร = เวลาปิดงวด, คำนวณสด = เวลาที่เปิดหน้า) */
  issuedAt: string;
}) {
  const count = (status: PayrollDayStatus) => line.days.filter((d) => d.status === status).length;
  const leaveDays = count("leave");
  const holidayDays = count("holiday");
  const inNoOutDays = count("in_no_out");
  const trueAbsentDays = count("absent");
  const lateDays = line.days.filter((d) => d.late && d.hours > 0).length;
  const skillPay = line.skillPay ?? 0;
  const seniorityPay = line.seniorityPay ?? 0;
  const salesBonus = line.salesBonus ?? 0;
  const monthlyBonus = line.monthlySalesBonus ?? 0;
  const monthlyDetail = line.monthlySalesBonusDetail ?? null;
  const sso = line.socialSecurity ?? 0;
  const wht = line.withholdingTax ?? 0;
  const weeklyAdvance = (line as { weeklyAdvance?: number }).weeklyAdvance ?? 0;
  const salaryAdvance = (line as { salaryAdvanceDeduction?: number }).salaryAdvanceDeduction ?? 0;
  const salaryAdvanceItems = (line as { salaryAdvanceItems?: { id: string; paidDate: string; amount: number }[] }).salaryAdvanceItems ?? [];
  const totalDeduction =
    line.latePenalty + line.absentPenalty + line.halfDayDeduction + line.deductionTotal + sso + wht + weeklyAdvance + salaryAdvance;
  // ใช้ยอดที่ระบบคำนวณ (ตรงกับ netPay) · บรรทัดแบบเดิมที่ไม่มี grossEarnings ค่อยรวมเอง
  const totalEarning =
    (line as { grossEarnings?: number }).grossEarnings ??
    line.basePay + line.otPay + line.bonusTotal + skillPay + seniorityPay + salesBonus + monthlyBonus;
  const bonusByDate = new Map((line.salesBonusDays ?? []).map((d) => [d.date, d]));
  const salesDays = line.salesBonusDays ?? [];
  const recordDays = salesDays.filter((d) => d.record).length;
  const normalByAmount = new Map<number, number>();
  for (const d of salesDays) if (!d.record) normalByAmount.set(d.amount, (normalByAmount.get(d.amount) ?? 0) + 1);
  const splitDays = salesDays.filter((d) => d.people !== undefined).length;

  return (
    <section className="mb-8 break-inside-avoid rounded-lg border border-gray-300 p-6">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-bold">{issuer.name}</h2>
          {issuer.address && <p className="text-xs text-gray-500">{issuer.address}</p>}
          {issuer.taxId && <p className="text-xs text-gray-500">เลขประจำตัวผู้เสียภาษี {issuer.taxId}</p>}
          <p className="text-sm text-gray-500">
            ใบแจ้งเงินเดือน · {dateFrom} ถึง {dateTo}
            {payDate ? ` · จ่าย ${payDate}` : ""}
          </p>
        </div>
        <div className="text-right">
          <p className="font-semibold">{employee?.fullName || line.employeeName}</p>
          {(employee?.employeeCode || employee?.position) && (
            <p className="text-sm text-gray-500">{[employee?.employeeCode, employee?.position].filter(Boolean).join(" · ")}</p>
          )}
          <p className="text-sm text-gray-500">
            {employee?.employmentType ? `${EMPLOYMENT_TYPE_LABEL[employee.employmentType]} · ` : ""}
            {PAY_TYPE_LABEL[line.payType]}
          </p>
          {employee?.bankAccountMasked && (
            <p className="text-xs text-gray-500">
              โอนเข้า {employee.bankName ?? ""} {employee.bankAccountMasked}
            </p>
          )}
        </div>
      </div>

      <div className="mb-4 rounded-lg bg-indigo-600 px-4 py-3 text-white">
        <p className="text-xs opacity-80">เงินได้สุทธิ</p>
        <p className="text-2xl font-bold tabular-nums">{money(line.netPay, currency)}</p>
      </div>

      {/* สรุปการเข้างาน */}
      <div className="mb-4 rounded border border-gray-200 bg-gray-50 p-3 text-sm">
        <p className="mb-1 font-semibold">สรุปการเข้างาน</p>
        <Row label="วันที่มาทำงาน" value={`${line.totalDays} วัน`} />
        {line.payType === "monthly" && <Row label="วันปฏิทินในงวด (รวมวันหยุด)" value={`${line.days.length} วัน`} muted />}
        {line.halfDays > 0 && (
          <Row label={`· เต็มวัน ${line.fullDays} วัน / ครึ่งวัน ${line.halfDays} วัน`} value={`คิดค่าแรง ${line.payableDays} วัน`} muted />
        )}
        <Row label="ชั่วโมงทำงานรวม" value={hoursLabel(line.totalHours)} />
        {line.otHours > 0 && <Row label="ชั่วโมง OT" value={hoursLabel(line.otHours)} muted />}
        {lateDays > 0 && <Row label="วันที่มาสาย" value={`${lateDays} วัน`} muted />}
        {trueAbsentDays > 0 && <Row label="วันขาดงาน (ไม่มีบันทึก)" value={`${trueAbsentDays} วัน`} muted />}
        {inNoOutDays > 0 && <Row label="วันที่เข้างานแต่ไม่ลงออก (นับเป็นขาด)" value={`${inNoOutDays} วัน`} muted />}
        {line.unpaidHolidayDays > 0 && (
          <Row label="วันหยุด/นอกวันทำงานที่เข้างานไม่ครบ (ไม่คิดเงิน / ไม่นับขาด)" value={`${line.unpaidHolidayDays} วัน`} muted />
        )}
        {leaveDays > 0 && <Row label="วันลา" value={`${leaveDays} วัน`} muted />}
        {holidayDays > 0 && <Row label="วันหยุดร้าน" value={`${holidayDays} วัน`} muted />}
      </div>

      <div className="text-sm">
        <p className="mb-1 font-semibold">รายรับ</p>
        {(line.rateSegments?.length ?? 0) > 1 ? (
          <>
            <Row label="ค่าจ้างพื้นฐาน (ปรับค่าจ้างกลางงวด)" value={money(line.basePay, currency)} />
            {line.rateSegments!.map((seg) => (
              <Row key={seg.from} label={`· ${seg.from}–${seg.to} (${seg.days} วัน) ${seg.label}`} value="" muted />
            ))}
          </>
        ) : (
          <Row
            label={
              line.payType === "daily"
                ? `ค่าจ้างพื้นฐาน (${line.payableDays} วัน)`
                : line.payType === "hourly"
                  ? `ค่าจ้างพื้นฐาน (${hoursLabel(line.regularHours)})`
                  : "ค่าจ้างพื้นฐาน (เงินเดือนตามช่วงวันที่)"
            }
            value={money(line.basePay, currency)}
          />
        )}
        {skillPay > 0 && (
          <Row label={`ค่าทักษะ ${"★".repeat(Math.min(5, line.skillNames?.length ?? 0))} (${(line.skillNames ?? []).join(", ")})`} value={`+${money(skillPay, currency)}`} />
        )}
        {(line.pendingSkillNames?.length ?? 0) > 0 && (
          <Row label={`· ทักษะใหม่มีผลงวดหน้า: ${line.pendingSkillNames!.join(", ")}`} value="" muted />
        )}
        {seniorityPay > 0 && (
          <Row
            label={`ค่าอายุงาน (${monthsLabel(line.seniorityMonths ?? 0)})${line.nextSeniorityTier ? ` · ขั้นถัดไป ${monthsLabel(line.nextSeniorityTier.months)} +${line.nextSeniorityTier.amount}` : ""}`}
            value={`+${money(seniorityPay, currency)}`}
          />
        )}
        {salesBonus > 0 && (
          <Row
            label={`โบนัสยอดขายรายวัน (${
              splitDays > 0
                ? `หารตามคนเข้างาน ${splitDays} วัน${recordDays ? ` · สถิติ ${recordDays} วัน` : ""}`
                : [
                    ...[...normalByAmount.entries()].map(([amount, days]) => `${days} วัน×${amount}`),
                    recordDays ? `สถิติ ${recordDays} วัน` : "",
                  ]
                    .filter(Boolean)
                    .join(" · ")
            })`}
            value={`+${money(salesBonus, currency)}`}
          />
        )}
        {monthlyBonus > 0 && monthlyDetail && (
          <Row
            label={`โบนัสยอดขายรายเดือน (ยอดรอบ ${money(monthlyDetail.periodSales, currency)}${
              monthlyDetail.totalFullDays
                ? ` · ก้อนรวม ${money(monthlyDetail.tierAmount, currency)} หารตามวันทำงาน ${monthlyDetail.fullDays}/${monthlyDetail.totalFullDays} วัน`
                : ""
            })`}
            value={`+${money(monthlyBonus, currency)}`}
          />
        )}
        {line.otPay > 0 && <Row label={`ค่าล่วงเวลา (${line.otHours} ชม. × ${otMultiplier})`} value={`+${money(line.otPay, currency)}`} />}
        {line.bonusTotal > 0 && <Row label="โบนัส/เพิ่มเติม" value={`+${money(line.bonusTotal, currency)}`} />}
        <Row label="รวมรายรับ" value={money(totalEarning, currency)} />

        <p className="mb-1 mt-3 font-semibold">รายการหัก</p>
        {totalDeduction === 0 ? (
          <Row label="ไม่มีรายการหัก" value="—" muted />
        ) : (
          <>
            {sso > 0 && (
              <Row label={`ประกันสังคม${line.socialSecurityBase ? ` (ฐาน ${money(line.socialSecurityBase, currency)})` : ""}`} value={`−${money(sso, currency)}`} />
            )}
            {wht > 0 && <Row label="ภาษีหัก ณ ที่จ่าย" value={`−${money(wht, currency)}`} />}
            {weeklyAdvance > 0 && <Row label="หักจ่ายล่วงหน้ารายสัปดาห์" value={`−${money(weeklyAdvance, currency)}`} />}
            {salaryAdvance > 0 && (
              <Row
                label={`หักเบิกล่วงหน้า (${salaryAdvanceItems.map((i) => `${i.paidDate} ${money(i.amount, currency)}`).join(", ")})`}
                value={`−${money(salaryAdvance, currency)}`}
              />
            )}
            {line.latePenalty > 0 && <Row label={`หักมาสาย (${lateDays} วัน)`} value={`−${money(line.latePenalty, currency)}`} />}
            {line.absentPenalty > 0 && (
              <Row
                label={`หักขาดงาน (${line.absentDays} วัน × ${money(line.absentRatePerDay, currency)})`}
                value={`−${money(line.absentPenalty, currency)}`}
              />
            )}
            {line.halfDayDeduction > 0 && (
              <Row
                label={`หักครึ่งวัน (${line.halfDayDeductionDays} วัน × 50% × ${money(line.absentRatePerDay, currency)})`}
                value={`−${money(line.halfDayDeduction, currency)}`}
              />
            )}
            {line.adjustments
              .filter((a) => DEDUCTION_TYPES.includes(a.type))
              .map((a) => (
                <Row key={a.id} label={`${ADJUSTMENT_LABEL[a.type]} ${a.date}${a.note ? ` · ${a.note}` : ""}`} value={`−${money(a.amount, currency)}`} />
              ))}
            <Row label="รวมรายการหัก" value={`−${money(totalDeduction, currency)}`} />
          </>
        )}
        <Row label="เงินสุทธิ" value={money(line.netPay, currency)} strong />
      </div>

      {line.adjustments.filter((a) => a.type === "bonus").length > 0 && (
        <div className="mt-3 text-xs text-gray-500">
          <p className="font-semibold">รายการเพิ่ม:</p>
          {line.adjustments
            .filter((a) => a.type === "bonus")
            .map((a) => (
              <p key={a.id}>
                · {a.date} {ADJUSTMENT_LABEL[a.type]} {money(a.amount, currency)}
                {a.note ? ` (${a.note})` : ""}
              </p>
            ))}
        </div>
      )}

      <DailyTable days={line.days} timeZone={timeZone} bonusByDate={bonusByDate} />

      <p className="mt-4 border-t border-gray-200 pt-2 text-[11px] text-gray-400">
        {docNo ? `เลขที่ ${docNo}${revision && revision > 1 ? ` (แก้ไขครั้งที่ ${revision})` : ""} · ` : ""}
        สลิปนี้คำนวณจากบันทึกเข้า-ออกงานจริงในระบบ · ออกเมื่อ{" "}
        {new Date(issuedAt).toLocaleString("th-TH", { timeZone, dateStyle: "medium", timeStyle: "short" })}
      </p>
    </section>
  );
}
