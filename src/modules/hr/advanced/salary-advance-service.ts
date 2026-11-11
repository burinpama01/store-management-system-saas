/**
 * ยอดเบิกได้ของพนักงานหนึ่งคน ณ ตอนนี้ (server) — ใช้ทั้งหน้าเบิกเงิน, ตอนส่งคำขอ และตอนอนุมัติ
 * รอบ = งวดเงินเดือนปัจจุบัน · พนักงานรายสัปดาห์แบบแยกรอบ = สัปดาห์ปัจจุบัน
 */
import { createSupabaseServiceClient } from "@/server/integrations/supabase/server";
import { addDays, businessDate, periodContaining } from "./pay-cycle";
import { listSalaryAdvances, listWeeklyPayouts, type SalaryAdvanceRow } from "./repository";
import { computeAdvanceCap, type AdvanceCap } from "./salary-advance";
import { computeStorePayroll, getAdvancedPayrollAccess } from "./store-payroll";
import { weekContaining, workedDayPay } from "./weekly";

export interface AdvanceAvailability {
  enabled: boolean;
  today: string;
  cycle: { kind: "monthly" | "weekly"; start: string; end: string };
  employeeName: string;
  hasProfile: boolean;
  workedDays: number;
  /** ค่าแรงจากวันที่มาแล้ว (ฐาน + OT) */
  earned: number;
  weeklyPaidInCycle: number;
  cap: AdvanceCap;
  advances: SalaryAdvanceRow[];
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** ยอดค้างของคำขอ: รออนุมัติ = ยอดขอ · จ่ายแล้ว = ยอดอนุมัติ − ที่หักไปแล้ว */
export function advanceOutstanding(a: Pick<SalaryAdvanceRow, "status" | "requestedAmount" | "approvedAmount" | "deducted">): number {
  if (a.status === "pending") return a.requestedAmount;
  if (a.status === "paid") return round2(Math.max(0, (a.approvedAmount ?? 0) - a.deducted));
  return 0;
}

export async function getAdvanceAvailability(input: {
  organizationId: string;
  storeId: string;
  userId: string;
  /** ไม่นับคำขอนี้ (ตอนอนุมัติ — ยอดของคำขอเองถูกนับเป็น "รออนุมัติ" อยู่) */
  excludeAdvanceId?: string;
  now?: Date;
}): Promise<AdvanceAvailability> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- อ่านเวลาสาขาด้วย service client
  const db: any = await createSupabaseServiceClient();
  const [{ data: store }, access, { data: own }] = await Promise.all([
    db.from("stores").select("timezone, closing_time").eq("id", input.storeId).maybeSingle(),
    getAdvancedPayrollAccess(input.organizationId, input.storeId),
    db.from("employee_profiles").select("pay_frequency").eq("store_id", input.storeId).eq("user_id", input.userId).maybeSingle(),
  ]);
  const settings = access.settings;
  const today = businessDate(input.now ?? new Date(), store?.timezone ?? "Asia/Bangkok", store?.closing_time ?? null);

  // รอบ: พนักงานรายสัปดาห์แบบแยกรอบ = สัปดาห์ปัจจุบัน · อื่น ๆ = งวดเงินเดือนปัจจุบัน
  const period = periodContaining(today, settings.payCycleStartDay, settings.payDay);
  let cycle: AdvanceAvailability["cycle"] = { kind: "monthly", start: period.start, end: period.end };
  if (settings.switches.weeklyPay && own?.pay_frequency === "weekly") {
    const week = weekContaining(today, settings.weeklyStartDay);
    cycle = { kind: "weekly", start: week.start, end: week.end };
  }
  const result = await computeStorePayroll({ ...input, periodStart: cycle.start, periodEnd: today, today });
  const profile = result.profiles.find((p) => p.userId === input.userId);
  const line = result.lines.find((l) => l.userId === input.userId);

  let earned = 0;
  let workedDays = 0;
  if (line && profile) {
    const worked = workedDayPay(line, profile, cycle.start, today, {
      rateBasis: settings.weeklyRateBasis,
      storeWorkingDays: result.hrSettings.workingDays,
      payCycleStartDay: settings.payCycleStartDay,
      payDay: settings.payDay,
    });
    earned = round2(worked.basePay + line.otPay);
    workedDays = worked.workedDays;
  }

  // แบบจ่ายล่วงหน้ารายสัปดาห์: เงินที่จ่ายไปแล้วสำหรับวันที่มาในงวดนี้
  let weeklyPaidInCycle = 0;
  if (cycle.kind === "monthly" && profile?.payFrequency === "weekly_advance") {
    const payouts = await listWeeklyPayouts(input.storeId, addDays(cycle.start, -6));
    weeklyPaidInCycle = round2(
      payouts
        .filter((p) => p.userId === input.userId && p.weekEnd >= cycle.start && p.weekStart <= today)
        .reduce((s, p) => s + p.amount, 0),
    );
  }

  const advances = await listSalaryAdvances(input.storeId, { userId: input.userId, limit: 100 });
  const counted = advances.filter((a) => a.id !== input.excludeAdvanceId);
  const outstanding = round2(counted.reduce((s, a) => s + advanceOutstanding(a), 0));
  const inCycle = counted.filter((a) => a.cycleStart === cycle.start && (a.status === "pending" || a.status === "paid"));
  const usedInCycle = round2(inCycle.reduce((s, a) => s + (a.status === "paid" ? a.approvedAmount ?? 0 : a.requestedAmount), 0));

  const cap = computeAdvanceCap({
    earned,
    maxPercent: settings.advanceMaxPercent,
    maxAmount: settings.advanceMaxAmount,
    maxRequests: settings.advanceMaxRequests,
    weeklyPaidInCycle,
    outstanding,
    usedInCycle,
    countInCycle: inCycle.length,
  });

  return {
    enabled: settings.switches.salaryAdvance,
    today,
    cycle,
    employeeName: line?.employeeName ?? "พนักงาน",
    hasProfile: !!profile,
    workedDays,
    earned,
    weeklyPaidInCycle,
    cap,
    advances,
  };
}
