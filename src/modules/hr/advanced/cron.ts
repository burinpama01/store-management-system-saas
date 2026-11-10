/**
 * งานรอบ 30 นาทีของเงินเดือนขั้นสูง (เรียกจาก pg_cron → /api/hr/cron/payroll)
 *   - ปิดงวดอัตโนมัติหลังเวลาปิดร้านของวันสุดท้าย (R16, R22)
 *   - แจ้งเตือน (R31): สลิปออกวันจ่าย, ใกล้วันจ่าย, ข้อมูลไม่ครบก่อนสิ้นงวด, ยอดถึงขั้นโบนัส/ทำสถิติ,
 *     เตือนลืมลงเวลาออกก่อนปิดร้าน, ครบขั้นอายุงาน
 * ทุกสาขาต้องผ่าน: แพ็กมีสิทธิ์ (R33) + สวิตช์ของงานนั้น (R32)
 */
import { createSupabaseServiceClient } from "@/server/integrations/supabase/server";
import { getOrganizationBillingState } from "@/modules/billing/billing-service";
import { DEFAULT_BILLING_STATE, getPlanFeatures } from "@/modules/billing/types";
import { logActionError, logSystemEvent } from "@/modules/system/event-log";
import { closePayrollPeriodForStore } from "./close-period";
import { fullMonthsBetween, isPermanentOn, seniorityPayFor, tierAmountFor } from "./income";
import { addDays, businessDate, isPeriodDue, periodContaining, previousPeriod, type PayPeriod } from "./pay-cycle";
import { effectiveSwitches, type AdvancedPayrollSettings } from "./settings";
import { getPayrollPeriod, listStoresWithPayrollAutomation, loadDailySales, loadMaxDailySalesBefore, mapAdvancedSettings } from "./repository";
import { formatBaht, listStoreManagerUserIds, listStoreMemberUserIds, pushPayrollNotification } from "./notify";
import { mapProfile } from "../repository";
import type { EmployeeProfile } from "../types";

export interface PayrollCronResult {
  stores: number;
  closed: number;
  notified: number;
  skipped: number;
  errors: number;
}

function localMinutes(now: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(now);
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0) % 24;
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return h * 60 + m;
}

export async function runPayrollCron(now: Date = new Date()): Promise<PayrollCronResult> {
  const result: PayrollCronResult = { stores: 0, closed: 0, notified: 0, skipped: 0, errors: 0 };
  const candidates = await listStoresWithPayrollAutomation();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- อ่าน stores/profiles ด้วย service client
  const db: any = await createSupabaseServiceClient();

  // ทีละ 5 สาขาพร้อมกัน — สาขาท้ายรายการไม่โดนตัดเพราะ maxDuration
  const BATCH = 5;
  for (let i = 0; i < candidates.length; i += BATCH) {
    await Promise.allSettled(candidates.slice(i, i + BATCH).map((c) => runStore(c)));
  }

  async function runStore(c: (typeof candidates)[number]): Promise<void> {
    result.stores += 1;
    try {
      const billing = await getOrganizationBillingState(c.organizationId);
      const entitled = getPlanFeatures(billing ?? DEFAULT_BILLING_STATE).advancedPayroll;
      const stored = mapAdvancedSettings(c.row);
      const settings: AdvancedPayrollSettings = { ...stored, switches: effectiveSwitches(entitled, stored.switches) };
      if (!entitled) {
        result.skipped += 1;
        await logSystemEvent({
          level: "info",
          source: "cron.payroll",
          action: "skipStore",
          message: "ข้ามสาขา: แพ็กเกจไม่มีเงินเดือนขั้นสูง (สวิตช์ทำงานเหมือนปิด)",
          organizationId: c.organizationId,
          storeId: c.storeId,
        });
        return;
      }
      const { data: store } = await db.from("stores").select("timezone, closing_time").eq("id", c.storeId).maybeSingle();
      const tz: string = store?.timezone ?? "Asia/Bangkok";
      const closingTime: string | null = store?.closing_time ?? null;
      const today = businessDate(now, tz, closingTime);
      const sw = settings.switches;
      const notify = sw.payrollNotifications;

      // ---- 1) รอบเงินเดือน: ปิดงวดที่เพิ่งจบ + แจ้งเตือนรอบงวด ----
      if (sw.payCycle) {
        const current = periodContaining(today, settings.payCycleStartDay, settings.payDay);
        const prev = previousPeriod(current, settings.payCycleStartDay, settings.payDay);
        // งวดที่จบแล้วแต่ยังไม่ปิด ย้อนได้สูงสุด 6 งวด (cron หยุดไปนาน) — เฉพาะงวดที่จบตั้งแต่วันเปิดรอบเงินเดือน
        // ไม่ย้อนปิดงวดเก่าก่อนร้านเปิดใช้ (ผู้จัดการปิดเองได้)
        const due: PayPeriod[] = [];
        let probe = prev;
        for (let n = 0; n < 6; n += 1) {
          if (settings.payCycleEnabledAt && probe.end < settings.payCycleEnabledAt) break;
          if (!settings.payCycleEnabledAt && n > 0) break;
          if (isPeriodDue(probe, today) && !(await getPayrollPeriod(c.storeId, probe.start))) due.unshift(probe);
          probe = previousPeriod(probe, settings.payCycleStartDay, settings.payDay);
        }
        for (const period of due) {
          const closed = await closePayrollPeriodForStore({
            organizationId: c.organizationId,
            storeId: c.storeId,
            period,
            today,
            closedBy: null,
          });
          if (closed.ok) result.closed += 1;
          else result.errors += 1;
          if (!closed.ok && notify) {
            const managers = await listStoreManagerUserIds(c.organizationId, c.storeId);
            const r = await pushPayrollNotification({
              organizationId: c.organizationId,
              storeId: c.storeId,
              userIds: managers,
              kind: "period_close_failed",
              dedupeKey: `${period.start}:${today}`,
              title: "ปิดงวดอัตโนมัติไม่สำเร็จ",
              message: `งวด ${period.start} ถึง ${period.end} — กดปิดงวดเองได้ที่หน้าพนักงาน แท็บเงินเดือน`,
            });
            result.notified += r.sent;
          }
        }

        if (notify) {
          const lastClosed = await getPayrollPeriod(c.storeId, prev.start);
          // วันจ่าย: สลิปเปิดให้พนักงาน → แจ้งรายคน (เฉพาะเมื่อเปิด "สลิปของฉัน")
          if (lastClosed && lastClosed.status === "closed" && today >= lastClosed.payDate && sw.myPayslip) {
            const { data: slips } = await db
              .from("payslips")
              .select("user_id")
              .eq("period_id", lastClosed.id)
              .is("superseded_at", null);
            const r = await pushPayrollNotification({
              organizationId: c.organizationId,
              storeId: c.storeId,
              userIds: ((slips ?? []) as { user_id: string }[]).map((s) => s.user_id),
              kind: lastClosed.revision > 1 ? "payslip_revised" : "payslip_ready",
              dedupeKey: `${lastClosed.periodStart}:r${lastClosed.revision}`,
              title: lastClosed.revision > 1 ? `สลิปถูกแก้ไข (ครั้งที่ ${lastClosed.revision})` : "สลิปเงินเดือนพร้อมแล้ว",
              message: `งวด ${lastClosed.periodStart} ถึง ${lastClosed.periodEnd} · แตะเพื่อดูที่เมนู "สลิปของฉัน"`,
            });
            result.notified += r.sent;
          }
          // 1 วันก่อนวันจ่าย → เจ้าของ/ผู้จัดการ
          if (lastClosed && lastClosed.status === "closed" && today === addDays(lastClosed.payDate, -1)) {
            const r = await pushPayrollNotification({
              organizationId: c.organizationId,
              storeId: c.storeId,
              userIds: await listStoreManagerUserIds(c.organizationId, c.storeId),
              kind: "payday_tomorrow",
              dedupeKey: `${lastClosed.periodStart}:r${lastClosed.revision}`,
              title: "พรุ่งนี้วันจ่ายเงินเดือน",
              message: `ยอดโอนรวม ${formatBaht(lastClosed.totalNetPay)} · ${lastClosed.employeeCount} คน`,
            });
            result.notified += r.sent;
          }
          // 2 วันก่อนสิ้นงวด → ข้อมูลไม่ครบ
          if (today === addDays(current.end, -2)) {
            const warnings = await incompleteDataWarnings(db, c.organizationId, c.storeId, current.start, today);
            if (warnings.length) {
              const r = await pushPayrollNotification({
                organizationId: c.organizationId,
                storeId: c.storeId,
                userIds: await listStoreManagerUserIds(c.organizationId, c.storeId),
                kind: "period_data_incomplete",
                dedupeKey: current.start,
                title: "ข้อมูลเงินเดือนยังไม่ครบ (อีก 2 วันปิดงวด)",
                message: warnings.join(" · "),
              });
              result.notified += r.sent;
            }
          }
        }
      }

      if (!notify) return;
      const { data: profileRows } = await db.from("employee_profiles").select("*").eq("store_id", c.storeId);
      const profiles: EmployeeProfile[] = (profileRows ?? []).map(mapProfile);

      // ---- 2) ยอดขายวันนี้ถึงขั้น / ทำสถิติ ----
      if (sw.salesBonus) {
        const sales = (await loadDailySales(c.storeId, today, today, settings.salesBonusChannels)).get(today) ?? 0;
        const tier = [...settings.salesBonusTiers].reverse().find((t) => sales >= t.minSales);
        const onShift = await openShiftUserIds(db, c.storeId, today);
        const eligibleOnShift = onShift.filter((id) => isPermanentOn(profiles.find((p) => p.userId === id), today));
        if (tier && eligibleOnShift.length) {
          const r = await pushPayrollNotification({
            organizationId: c.organizationId,
            storeId: c.storeId,
            userIds: eligibleOnShift,
            kind: "sales_tier_reached",
            dedupeKey: `${today}:${tier.minSales}`,
            title: "ยอดขายถึงขั้นโบนัสแล้ว 🎉",
            message: `ยอดวันนี้ทะลุ ${tier.minSales.toLocaleString("th-TH")} · โบนัส +${tierAmountFor(sales, settings.salesBonusTiers)}/คน (ต้องทำเต็มวัน)`,
          });
          result.notified += r.sent;
        }
        const record = Math.max(settings.salesRecordBaseline, await loadMaxDailySalesBefore(c.storeId, today, settings.salesBonusChannels));
        if (sales > 0 && sales > record && settings.salesRecordBonus > 0) {
          const r = await pushPayrollNotification({
            organizationId: c.organizationId,
            storeId: c.storeId,
            userIds: [...eligibleOnShift, ...(await listStoreManagerUserIds(c.organizationId, c.storeId))],
            kind: "sales_record",
            dedupeKey: today,
            title: "ทำสถิติยอดขายสูงสุดของร้าน! 👑",
            message: `ยอดวันนี้ ${formatBaht(sales)} · โบนัสสถิติ +${settings.salesRecordBonus}/คน`,
          });
          result.notified += r.sent;
        }
      }

      // ---- 3) เตือนลืมลงเวลาออก (ช่วง 1 ชม. ก่อนเวลาปิดร้าน) ----
      if (closingTime) {
        const closeMin = (() => {
          const m = /^(\d{1,2}):(\d{2})/.exec(closingTime);
          return m ? Number(m[1]) * 60 + Number(m[2]) : null;
        })();
        if (closeMin !== null) {
          const nowMin = localMinutes(now, tz);
          const diff = (closeMin - nowMin + 1440) % 1440;
          if (diff > 0 && diff <= 60) {
            const withProfile = new Set(profiles.map((p) => p.userId));
            const open = (await openShiftUserIds(db, c.storeId, today)).filter((id) => withProfile.has(id));
            for (const userId of open) {
              const r = await pushPayrollNotification({
                organizationId: c.organizationId,
                storeId: c.storeId,
                userIds: [userId],
                kind: "forgot_clock_out",
                dedupeKey: `${today}:${userId}`,
                title: "อย่าลืมลงเวลาออกงาน",
                message: "ลืมลงเวลาออก = นับเป็นขาดงาน และไม่ได้โบนัสยอดขายของวันนี้",
              });
              result.notified += r.sent;
            }
          }
        }
      }

      // ---- 4) ครบขั้นอายุงาน ----
      if (sw.seniorityPay) {
        for (const p of profiles) {
          if (p.employmentType !== "permanent" || !p.seniorityStartDate) continue;
          const months = fullMonthsBetween(p.seniorityStartDate, today);
          const before = fullMonthsBetween(p.seniorityStartDate, addDays(today, -1));
          const tier = settings.seniorityTiers.find((t) => t.months === months);
          if (!tier || before >= months) continue;
          const r = await pushPayrollNotification({
            organizationId: c.organizationId,
            storeId: c.storeId,
            userIds: [p.userId],
            kind: "seniority_milestone",
            dedupeKey: `${p.userId}:${tier.months}`,
            title: "ครบขั้นอายุงานแล้ว",
            message: `อายุงานครบ ${tier.months >= 12 && tier.months % 12 === 0 ? `${tier.months / 12} ปี` : `${tier.months} เดือน`} · ค่าอายุงาน +${seniorityPayFor(months, settings.seniorityTiers)} เริ่มงวดถัดไป`,
          });
          result.notified += r.sent;
        }
      }
    } catch (error) {
      result.errors += 1;
      logActionError({ source: "cron.payroll", action: "runStore", error, context: { storeId: c.storeId } });
    }
  }

  await logSystemEvent({
    level: result.errors ? "warn" : "info",
    source: "cron.payroll",
    action: "runPayrollCron",
    message: `รอบเงินเดือน: ${result.stores} สาขา · ปิดงวด ${result.closed} · แจ้งเตือน ${result.notified} เครื่อง · ข้าม ${result.skipped} · ผิดพลาด ${result.errors}`,
    context: { ...result },
  });
  return result;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- service client
async function openShiftUserIds(db: any, storeId: string, date: string): Promise<string[]> {
  const { data } = await db
    .from("attendance_records")
    .select("user_id")
    .eq("store_id", storeId)
    .eq("date", date)
    .is("clock_out_at", null);
  return [...new Set(((data ?? []) as { user_id: string }[]).map((r) => r.user_id))];
}

async function incompleteDataWarnings(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- service client
  db: any,
  organizationId: string,
  storeId: string,
  periodStart: string,
  today: string,
): Promise<string[]> {
  const [members, profiles, openShifts, selfBanks] = await Promise.all([
    listStoreMemberUserIds(organizationId, storeId),
    db.from("employee_profiles").select("user_id, bank_account_no, employment_end_date").eq("store_id", storeId),
    db
      .from("attendance_records")
      .select("user_id, date")
      .eq("store_id", storeId)
      .gte("date", periodStart)
      .lt("date", today)
      .is("clock_out_at", null),
    db.from("employee_self_info").select("user_id").eq("store_id", storeId).not("bank_account_no", "is", null),
  ]);
  // พนักงานกรอกเลขบัญชีเองแล้วก็นับว่ามี (อ่านไม่ได้ = นับเกินแบบปลอดภัย + log)
  if (selfBanks?.error) {
    await logSystemEvent({
      level: "warn",
      source: "hr.self-info",
      action: "incompleteDataWarnings.selfInfo",
      message: `อ่านเลขบัญชีที่พนักงานกรอกเองไม่สำเร็จ: ${selfBanks.error.message}`,
      organizationId,
      storeId,
    }).catch(() => undefined);
  }
  const selfBankUsers = new Set(((selfBanks?.data ?? []) as { user_id: string }[]).map((r) => r.user_id));
  const rows = (profiles.data ?? []) as { user_id: string; bank_account_no: string | null; employment_end_date: string | null }[];
  const active = rows.filter((p) => !p.employment_end_date || p.employment_end_date >= periodStart);
  const withProfile = new Set(rows.map((p) => p.user_id));
  const out: string[] = [];
  const noBank = active.filter((p) => !p.bank_account_no && !selfBankUsers.has(p.user_id)).length;
  if (noBank) out.push(`${noBank} คนยังไม่มีเลขบัญชี`);
  const noProfile = members.filter((id) => !withProfile.has(id)).length;
  if (noProfile) out.push(`${noProfile} คนยังไม่ตั้งค่าจ้าง`);
  const open = (openShifts.data ?? []).length;
  if (open) out.push(`${open} กะยังไม่ลงเวลาออก`);
  return out;
}
