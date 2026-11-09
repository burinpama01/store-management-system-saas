import { redirect } from "next/navigation";
import { getResolvedCurrentPermissions } from "@/modules/auth/guards";
import { listEmployeeProfiles, listPayrollAdjustments, getStoreHrSettings } from "@/modules/hr/repository";
import { listEmployeeSelfInfo } from "@/modules/hr/self-info-repository";
import { applySelfInfo } from "@/modules/hr/self-info";
import { getReceiptSettings } from "@/modules/settings/repository";
import { maskBankAccount, resolvePayslipIssuer } from "@/modules/hr/employee-identity";
import {
  listAttendanceRecords,
  computePayrollSummaries,
  listStoreHolidays,
} from "@/modules/attendance/repository";
import { listStoreMemberships } from "@/modules/settings/repository";
// computePayrollLines เดิมถูกห่อด้วย computeAdvancedPayrollLines (ไม่มีสิทธิ์/ปิดสวิตช์ = ผลเท่าเดิม)
import { computeAdvancedPayrollLines, type AdvancedPayrollLine } from "@/modules/hr/advanced/compute";
import { getAdvancedPayrollAccess, loadAdvancedContext } from "@/modules/hr/advanced/store-payroll";
import { listCurrentPayslipsForPeriod, listPayrollPeriods } from "@/modules/hr/advanced/repository";
import type { PayslipSnapshotData } from "@/modules/hr/advanced/close-period";
import { getStore } from "@/modules/stores/repository";
import { getStoreLocalDate } from "@/modules/attendance/date";
import { PrintButton } from "./PrintButton";
import { SaveImageButton } from "./SaveImageButton";
import { PayslipCard, money, type PayslipEmployeeInfo } from "./PayslipCard";

export const dynamic = "force-dynamic";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isValidDate = (s: string) => DATE_RE.test(s) && !isNaN(Date.parse(s));
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface SlipView {
  line: AdvancedPayrollLine;
  employee?: PayslipEmployeeInfo;
  docNo?: string;
  revision?: number;
  issuedAt?: string;
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
  const periodId = params.periodId && UUID_RE.test(params.periodId) ? params.periodId : null;

  const storeRes = await getStore(ctx.storeId);
  const currency = storeRes.data?.currencyCode ?? "THB";
  const storeName = ctx.storeName;
  let views: SlipView[] = [];
  let issuer: { name: string; address?: string; taxId?: string } = { name: storeName };
  let otMultiplier = 1.5;
  let payDate: string | undefined;

  if (periodId) {
    // สลิปถาวรของงวดที่ปิดแล้ว (R24) — ผู้จัดการยังเปิดดู/พิมพ์ได้แม้แพ็กหมดอายุ (R33)
    const periods = await listPayrollPeriods(ctx.storeId, 60);
    const period = periods.find((p) => p.id === periodId);
    if (!period) redirect("/staff");
    const slips = await listCurrentPayslipsForPeriod(ctx.storeId, periodId);
    dateFrom = period.periodStart;
    dateTo = period.periodEnd;
    payDate = period.payDate;
    views = slips.map((s) => {
      const data = s.data as PayslipSnapshotData;
      issuer = data.issuer ?? issuer;
      otMultiplier = data.otMultiplier ?? otMultiplier;
      return {
        line: data.line,
        employee: data.employee,
        docNo: s.docNo,
        revision: s.revision,
        issuedAt: s.createdAt,
      };
    });
    views.sort((a, b) => a.line.employeeName.localeCompare(b.line.employeeName));
  } else {
    const [membersRes, profilesRes, recordsRes, adjustmentsRes, holidaysRes, hrSettings, receiptRes, access, selfInfo] = await Promise.all([
      listStoreMemberships(ctx.organizationId, ctx.storeId),
      listEmployeeProfiles(ctx.storeId),
      // Org-wide, then narrowed to this store's roster — same scope as /staff so the slip always
      // agrees with the table it was printed from.
      listAttendanceRecords(ctx.organizationId, null, dateFrom, dateTo),
      listPayrollAdjustments(ctx.storeId, dateFrom, dateTo),
      listStoreHolidays(ctx.storeId, dateFrom, dateTo),
      getStoreHrSettings(ctx.storeId, ctx.organizationId),
      getReceiptSettings(ctx.storeId, ctx.organizationId),
      getAdvancedPayrollAccess(ctx.organizationId, ctx.storeId),
      listEmployeeSelfInfo(ctx.storeId),
    ]);

    const roster = new Set((membersRes.data ?? []).filter((m) => m.role !== "super_admin").map((m) => m.userId));
    const records = (recordsRes.data ?? []).filter((r) => roster.has(r.userId));
    const summaries = computePayrollSummaries(records, null, ctx.organizationId, dateFrom, dateTo);
    const adv = await loadAdvancedContext(ctx.storeId, access.settings, dateFrom, dateTo);
    const lines = computeAdvancedPayrollLines(
      {
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
      },
      adv,
    );
    issuer = resolvePayslipIssuer(hrSettings, receiptRes.data, storeName);
    otMultiplier = hrSettings.otMultiplier;
    // ชื่อจริง/บัญชี: ค่าที่เจ้าของตั้งก่อน ไม่มีจึงใช้ที่พนักงานกรอกเอง
    const profileByUser = new Map((profilesRes.data ?? []).map((p) => [p.userId, applySelfInfo(p, selfInfo.get(p.userId))]));
    views = lines.map((line) => {
      const p = profileByUser.get(line.userId);
      return {
        line,
        employee: p
          ? {
              fullName: p.fullName,
              employeeCode: p.employeeCode,
              position: p.position,
              employmentType: p.employmentType,
              bankName: p.bankName,
              bankAccountMasked: maskBankAccount(p.bankAccountNo) || undefined,
            }
          : undefined,
      };
    });
  }
  if (userId) views = views.filter((v) => v.line.userId === userId);
  const grandTotal = views.reduce((s, v) => s + v.line.netPay, 0);
  const generatedAt = new Date().toISOString();

  return (
    <main className="mx-auto max-w-3xl bg-white p-6 text-gray-900">
      <style>{`@media print { @page { margin: 12mm; } body { background: white; } }`}</style>
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between print:hidden">
        <h1 className="text-xl font-bold">
          {mode === "summary" ? "สรุปเงินเดือนทั้งงวด" : "สลิปเงินเดือน"}
          {periodId ? " (งวดที่ปิดแล้ว)" : ""}
        </h1>
        <div className="flex flex-wrap items-start gap-2">
          <PrintButton />
          {views.length > 0 && (
            <SaveImageButton fileName={`${mode === "summary" ? "payroll-summary" : "payslip"}_${dateFrom}_${dateTo}.png`} />
          )}
        </div>
      </div>

      <div id="payslip-image-content" className="bg-white">
        {views.length === 0 ? (
          <p className="text-center text-gray-400">ไม่มีข้อมูลในช่วงนี้</p>
        ) : mode === "summary" ? (
          <section>
            <div className="mb-4">
              <h2 className="text-lg font-bold">{storeName}</h2>
              <p className="text-sm text-gray-500">
                สรุปเงินเดือน · {dateFrom} ถึง {dateTo}
                {payDate ? ` · จ่าย ${payDate}` : ""}
              </p>
            </div>
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b-2 border-gray-300 text-left">
                  <th className="py-2">พนักงาน</th>
                  <th className="py-2 text-right">วันที่จ่าย</th>
                  <th className="py-2 text-right">ฐาน</th>
                  <th className="py-2 text-right">OT</th>
                  <th className="py-2 text-right">เพิ่ม</th>
                  <th className="py-2 text-right">หัก</th>
                  <th className="py-2 text-right">สุทธิ</th>
                </tr>
              </thead>
              <tbody>
                {views.map(({ line: l, employee }) => (
                  <tr key={l.userId} className="border-b border-gray-200">
                    <td className="py-2">{employee?.fullName || l.employeeName}</td>
                    <td className="py-2 text-right tabular-nums">
                      {l.payableDays}
                      {l.halfDays > 0 ? ` (ครึ่งวัน ${l.halfDays})` : ""}
                    </td>
                    <td className="py-2 text-right">{money(l.basePay, currency)}</td>
                    <td className="py-2 text-right">{l.otPay ? money(l.otPay, currency) : "—"}</td>
                    <td className="py-2 text-right">
                      {money(l.bonusTotal + (l.skillPay ?? 0) + (l.seniorityPay ?? 0) + (l.salesBonus ?? 0), currency)}
                    </td>
                    <td className="py-2 text-right">
                      {money(
                        l.latePenalty + l.absentPenalty + l.halfDayDeduction + l.deductionTotal + (l.socialSecurity ?? 0) + (l.withholdingTax ?? 0),
                        currency,
                      )}
                    </td>
                    <td className="py-2 text-right font-semibold">{money(l.netPay, currency)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-gray-300 font-bold">
                  <td className="py-2">รวมทั้งหมด ({views.length} คน)</td>
                  <td colSpan={5} />
                  <td className="py-2 text-right">{money(grandTotal, currency)}</td>
                </tr>
              </tfoot>
            </table>
          </section>
        ) : (
          views.map((v) => (
            <PayslipCard
              key={v.line.userId}
              line={v.line}
              currency={currency}
              issuer={issuer}
              employee={v.employee}
              dateFrom={dateFrom}
              dateTo={dateTo}
              timeZone={ctx.storeTimezone}
              otMultiplier={otMultiplier}
              docNo={v.docNo}
              revision={v.revision}
              issuedAt={v.issuedAt ?? generatedAt}
              payDate={payDate}
            />
          ))
        )}
      </div>
    </main>
  );
}
