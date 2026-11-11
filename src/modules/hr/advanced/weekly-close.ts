/**
 * บันทึกยอดค่าแรงรายสัปดาห์ + แจ้งเจ้าของ/ผู้จัดการ (W8)
 *   ใช้ทั้ง cron (actorUserId = null, หลังเวลาปิดร้านของวันสุดท้ายของสัปดาห์) และผู้จัดการกดบันทึกเอง
 *   คนที่บันทึกแล้วในสัปดาห์นั้นไม่ถูกเขียนทับ — กดซ้ำ = เพิ่มเฉพาะคนที่ยังไม่มียอด
 * แจ้งเตือนส่งเมื่อเปิดสวิตช์จ่ายรายสัปดาห์ (ผู้ใช้สั่งให้แจ้งเจ้าของ ไม่ผูกกับสวิตช์แจ้งเตือนเงินเดือน)
 */
import { logSystemEvent } from "@/modules/system/event-log";
import { saveWeeklyPayouts } from "./repository";
import { computeStorePayroll } from "./store-payroll";
import { formatBaht, listStoreManagerUserIds, pushPayrollNotification } from "./notify";
import { computeWeeklyPayouts, weeklyOwnerMessage, type PayWeek, type WeeklyPayout } from "./weekly";

export interface RecordWeeklyResult {
  ok: boolean;
  error: string | null;
  /** ยอดที่เพิ่มใหม่ในครั้งนี้ */
  inserted: WeeklyPayout[];
  /** จำนวนคนที่ตั้งรายสัปดาห์และมีบรรทัดในสัปดาห์นั้น (รวมที่บันทึกไปแล้ว) */
  eligible: number;
  total: number;
  notified: number;
}

export async function recordWeeklyPayoutsForStore(input: {
  organizationId: string;
  storeId: string;
  week: PayWeek;
  today: string;
  /** null = ระบบบันทึกอัตโนมัติ */
  actorUserId: string | null;
}): Promise<RecordWeeklyResult> {
  const { organizationId, storeId, week } = input;
  const fail = async (error: string): Promise<RecordWeeklyResult> => {
    await logSystemEvent({
      level: "error",
      source: "hr.payroll-weekly",
      action: input.actorUserId ? "recordWeekManual" : "recordWeekAuto",
      message: `บันทึกค่าแรงรายสัปดาห์ ${week.start}–${week.end} ไม่สำเร็จ: ${error}`,
      organizationId,
      storeId,
      actorUserId: input.actorUserId,
      context: { weekStart: week.start, weekEnd: week.end },
    });
    return { ok: false, error, inserted: [], eligible: 0, total: 0, notified: 0 };
  };
  if (input.today <= week.end) return fail("สัปดาห์นี้ยังไม่จบ (บันทึกได้หลังวันสุดท้ายของสัปดาห์)");

  let result: Awaited<ReturnType<typeof computeStorePayroll>>;
  try {
    result = await computeStorePayroll({ organizationId, storeId, periodStart: week.start, periodEnd: week.end, today: input.today });
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
  const settings = result.access.settings;
  if (!settings.switches.weeklyPay) return fail("ยังไม่ได้เปิดสวิตช์จ่ายค่าแรงรายสัปดาห์ (หรือแพ็กไม่มีสิทธิ์)");

  const payouts = computeWeeklyPayouts({
    week,
    lines: result.lines,
    profiles: result.profiles,
    hrSettings: result.hrSettings,
    rateBasis: settings.weeklyRateBasis,
    payCycleStartDay: settings.payCycleStartDay,
    payDay: settings.payDay,
  });
  const saved = await saveWeeklyPayouts(
    payouts.map((p) => ({
      storeId,
      organizationId,
      userId: p.userId,
      weekStart: week.start,
      weekEnd: week.end,
      mode: p.mode,
      amount: p.amount,
      data: { version: 1, ...p, rateBasis: settings.weeklyRateBasis, recordedBy: input.actorUserId },
    })),
  );
  if (saved.error) return fail(saved.error);

  const insertedIds = new Set(saved.inserted.map((r) => r.userId));
  const inserted = payouts.filter((p) => insertedIds.has(p.userId));
  const total = Math.round(inserted.reduce((s, p) => s + p.amount, 0) * 100) / 100;

  await logSystemEvent({
    level: "info",
    source: "hr.payroll-weekly",
    action: input.actorUserId ? "recordWeekManual" : "recordWeekAuto",
    message:
      payouts.length === 0
        ? `สัปดาห์ ${week.start}–${week.end}: ไม่มีพนักงานรายสัปดาห์ที่ต้องจ่าย`
        : inserted.length === 0
          ? `สัปดาห์ ${week.start}–${week.end}: บันทึกครบทุกคนไปแล้ว (ข้าม)`
          : `บันทึกค่าแรงรายสัปดาห์ ${week.start}–${week.end} ${inserted.length} คน รวม ${formatBaht(total)}`,
    organizationId,
    storeId,
    actorUserId: input.actorUserId,
    context: { weekStart: week.start, weekEnd: week.end, eligible: payouts.length, inserted: inserted.length, total },
  });

  let notified = 0;
  if (inserted.length > 0) {
    const managers = await listStoreManagerUserIds(organizationId, storeId);
    const r = await pushPayrollNotification({
      organizationId,
      storeId,
      userIds: managers,
      kind: "weekly_payout",
      // กดเพิ่มทีหลัง (คนที่ตกหล่น) = แจ้งเฉพาะคนใหม่ ไม่ซ้ำกับรอบแรก
      dedupeKey: `${week.start}:${[...insertedIds].sort().join(",")}`,
      title: `ค่าแรงรายสัปดาห์ ${week.start} ถึง ${week.end}`,
      message: weeklyOwnerMessage(inserted, formatBaht),
    });
    notified = r.sent;
  }
  return { ok: true, error: null, inserted, eligible: payouts.length, total, notified };
}
