/**
 * ยอดเบิกได้ของพนักงานหนึ่งคน ณ ตอนนี้ (server) — ใช้ทั้งหน้าเบิกเงิน, ตอนส่งคำขอ และตอนอนุมัติ
 * รอบ = งวดเงินเดือนปัจจุบัน · พนักงานรายสัปดาห์แบบแยกรอบ = สัปดาห์ปัจจุบัน
 */
import { createSupabaseServiceClient } from "@/server/integrations/supabase/server";
import { logSystemEvent } from "@/modules/system/event-log";
import { addDays, businessDate, periodContaining } from "./pay-cycle";
import { getCashOnHand, listSalaryAdvances, listWeeklyPayouts, type SalaryAdvanceRow } from "./repository";
import { cashAdvanceMax, computeAdvanceCap, type AdvanceCap } from "./salary-advance";
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
  /** เงินสดในลิ้นชักตอนนี้ (ใช้ตรวจเบิกเงินสด — ไม่แสดงให้พนักงานเห็นยอดเต็ม) */
  cashOnHand: number;
  /** เบิกเงินสดได้สูงสุด = min(เพดาน, เงินสดในลิ้นชักปัดลงหลักร้อย) */
  cashMax: number;
  /** มีรอบเงินสดเปิดอยู่ (ไม่มี = ยอดเงินสดมาจากตอนปิดรอบล่าสุด อาจไม่เป็นปัจจุบัน) */
  cashSessionOpen: boolean;
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

  const [advances, cash] = await Promise.all([
    listSalaryAdvances(input.storeId, { userId: input.userId, limit: 100 }),
    // อ่านยอดเงินสดไม่ได้ = ถือว่า 0 (เบิกเงินสดไม่ได้ แต่ยังเลือกโอนได้ — หน้าไม่ล่ม) + log
    getCashOnHand(input.storeId).catch(async (e) => {
      await logSystemEvent({
        level: "warn",
        source: "hr.salary-advance",
        action: "getCashOnHand",
        message: `อ่านยอดเงินสดในลิ้นชักไม่สำเร็จ — ปิดการเบิกเงินสดชั่วคราว: ${e instanceof Error ? e.message : String(e)}`,
        organizationId: input.organizationId,
        storeId: input.storeId,
      }).catch(() => undefined);
      return { amount: 0, sessionOpen: false };
    }),
  ]);
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
    cashOnHand: cash.amount,
    cashMax: cashAdvanceMax(cap.available, cash.amount),
    cashSessionOpen: cash.sessionOpen,
    advances,
  };
}
