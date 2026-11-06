/**
 * ปิดงวด (R16, R22, R24): คำนวณทั้งสาขา → เก็บสลิปถาวร (snapshot) → แจ้งผู้จัดการ/เจ้าของ
 * ใช้ทั้งปิดอัตโนมัติ (cron, closedBy = null) และผู้จัดการกดปิดเอง/ปิดซ้ำหลังเปิดงวดแก้
 */
import { logSystemEvent } from "@/modules/system/event-log";
import { maskBankAccount } from "../employee-identity";
import type { EmployeeProfile } from "../types";
import type { AdvancedPayrollLine } from "./compute";
import { fullMonthsBetween, seniorityPayFor } from "./income";
import { addDays, type PayPeriod } from "./pay-cycle";
import { savePeriodSnapshot } from "./repository";
import { computeStorePayroll } from "./store-payroll";
import { formatBaht, listStoreManagerUserIds, pushPayrollNotification } from "./notify";

/** ข้อมูลในสลิปถาวร — พอสำหรับวาดสลิปใหม่โดยไม่ต้องคำนวณซ้ำ (เลขบัญชีเก็บแบบปิดหลักเท่านั้น) */
export interface PayslipSnapshotData {
  version: 1;
  period: PayPeriod;
  issuer: { name: string; address?: string; taxId?: string };
  storeName: string;
  currency: string;
  timezone: string;
  otMultiplier: number;
  line: AdvancedPayrollLine;
  employee: {
    fullName?: string;
    employeeCode?: string;
    position?: string;
    employmentType?: EmployeeProfile["employmentType"];
    bankName?: string;
    bankAccountMasked?: string;
    seniorityStartDate?: string;
  };
}

export async function closePayrollPeriodForStore(input: {
  organizationId: string;
  storeId: string;
  period: PayPeriod;
  today: string;
  /** null = ระบบปิดอัตโนมัติ */
  closedBy: string | null;
}): Promise<{ ok: boolean; error: string | null; revision: number; total: number; count: number }> {
  const result = await computeStorePayroll({
    organizationId: input.organizationId,
    storeId: input.storeId,
    periodStart: input.period.start,
    periodEnd: input.period.end,
    today: input.today,
  });
  const profileByUser = new Map(result.profiles.map((p) => [p.userId, p]));
  const lines = result.lines.filter((l) => l.hasProfile || l.netPay !== 0);

  const slips = lines.map((line) => {
    const p = profileByUser.get(line.userId);
    const data: PayslipSnapshotData = {
      version: 1,
      period: input.period,
      issuer: result.issuer,
      storeName: result.storeName,
      currency: result.currency,
      timezone: result.timezone,
      otMultiplier: result.hrSettings.otMultiplier,
      line,
      employee: {
        fullName: p?.fullName,
        employeeCode: p?.employeeCode,
        position: p?.position,
        employmentType: p?.employmentType,
        bankName: p?.bankName,
        bankAccountMasked: maskBankAccount(p?.bankAccountNo) || undefined,
        seniorityStartDate: p?.seniorityStartDate,
      },
    };
    return { userId: line.userId, netPay: line.netPay, data };
  });

  const saved = await savePeriodSnapshot({
    storeId: input.storeId,
    organizationId: input.organizationId,
    periodStart: input.period.start,
    periodEnd: input.period.end,
    payDate: input.period.payDate,
    closedBy: input.closedBy,
    slips,
  });
  const total = Math.round(slips.reduce((s, x) => s + x.netPay, 0) * 100) / 100;

  await logSystemEvent({
    level: saved.error ? "error" : "info",
    source: "hr.payroll-period",
    action: input.closedBy ? "closePeriodManual" : "closePeriodAuto",
    message: saved.error
      ? `ปิดงวด ${input.period.start}–${input.period.end} ไม่สำเร็จ: ${saved.error}`
      : saved.alreadyClosed
        ? `งวด ${input.period.start}–${input.period.end} ถูกปิดไปแล้ว (ข้าม)`
        : `ปิดงวด ${input.period.start}–${input.period.end} (ฉบับที่ ${saved.revision}) ${slips.length} คน รวม ${formatBaht(total)}`,
    organizationId: input.organizationId,
    storeId: input.storeId,
    actorUserId: input.closedBy,
    context: { periodStart: input.period.start, periodEnd: input.period.end, revision: saved.revision, count: slips.length },
  });
  if (saved.error) return { ok: false, error: saved.error, revision: saved.revision, total, count: slips.length };
  // อีกงานปิดไปก่อนแล้ว (cron กับคนกดพร้อมกัน) — ไม่แจ้งเตือนซ้ำ
  if (saved.alreadyClosed) return { ok: true, error: null, revision: saved.revision, total, count: slips.length };

  // แจ้งผู้จัดการ/เจ้าของ (R31) — เฉพาะเมื่อเปิดสวิตช์แจ้งเตือน
  if (result.access.settings.switches.payrollNotifications) {
    const managers = await listStoreManagerUserIds(input.organizationId, input.storeId);
    // ค่าอายุงานที่จะเพิ่มงวดหน้า
    let seniorityUp = 0;
    let seniorityUpAmount = 0;
    if (result.access.settings.switches.seniorityPay) {
      const nextStart = addDays(input.period.end, 1);
      for (const p of result.profiles) {
        if (p.employmentType !== "permanent" || !p.seniorityStartDate) continue;
        const now = seniorityPayFor(fullMonthsBetween(p.seniorityStartDate, input.period.start), result.access.settings.seniorityTiers);
        const next = seniorityPayFor(fullMonthsBetween(p.seniorityStartDate, nextStart), result.access.settings.seniorityTiers);
        if (next > now) {
          seniorityUp += 1;
          seniorityUpAmount += next - now;
        }
      }
    }
    await pushPayrollNotification({
      organizationId: input.organizationId,
      storeId: input.storeId,
      userIds: managers,
      kind: "period_closed",
      dedupeKey: `${input.period.start}:r${saved.revision}`,
      title: "ปิดงวดเงินเดือนแล้ว",
      message:
        `งวด ${input.period.start} ถึง ${input.period.end} · ${slips.length} คน · รวม ${formatBaht(total)} · จ่าย ${input.period.payDate}` +
        (input.closedBy ? "" : " — ตรวจได้ก่อนพนักงานเห็นในวันจ่าย") +
        (seniorityUp ? ` · งวดหน้าค่าอายุงานเพิ่ม ${seniorityUp} คน รวม +${formatBaht(seniorityUpAmount)}` : ""),
    });
  }
  return { ok: true, error: null, revision: saved.revision, total, count: slips.length };
}
