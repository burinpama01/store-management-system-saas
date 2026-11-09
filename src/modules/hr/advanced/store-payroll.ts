/**
 * โหลด + คำนวณเงินเดือนทั้งสาขาสำหรับงวดหนึ่ง (ใช้ร่วมกัน: หน้า /staff, /payslip, ปิดงวด, cron)
 * ใช้ service client — ผู้เรียกต้องตรวจสิทธิ์ (attendance.manage) หรือเป็น cron ที่ยืนยันกุญแจแล้ว
 */
import { applySelfInfo, type EmployeeSelfInfo } from "../self-info";
import { logSystemEvent } from "@/modules/system/event-log";
import { createSupabaseServiceClient } from "@/server/integrations/supabase/server";
import { getOrganizationBillingState } from "@/modules/billing/billing-service";
import { DEFAULT_BILLING_STATE, getPlanFeatures } from "@/modules/billing/types";
import { computePayrollSummaries, mapRecord } from "@/modules/attendance/repository";
import { mapAdjustment, mapHrSettings, mapProfile } from "../repository";
import { DEFAULT_HR_SETTINGS, type EmployeeProfile, type StoreHrSettings } from "../types";
import { resolvePayslipIssuer } from "../employee-identity";
import { computeAdvancedPayrollLines, type AdvancedComputeContext, type AdvancedPayrollLine } from "./compute";
import { effectiveSwitches, type AdvancedPayrollSettings } from "./settings";
import {
  getAdvancedPayrollSettings,
  listEmployeeSkillGrants,
  listPayRates,
  loadDailySales,
  loadMaxDailySalesBefore,
} from "./repository";

export interface AdvancedPayrollAccess {
  entitled: boolean;
  /** ค่าที่ร้านตั้งไว้ (สวิตช์ตามที่บันทึก) */
  stored: AdvancedPayrollSettings;
  /** ค่าที่มีผลจริง (แพ็กไม่มีสิทธิ์ = ปิดทุกสวิตช์) */
  settings: AdvancedPayrollSettings;
}

export async function getAdvancedPayrollAccess(organizationId: string, storeId: string): Promise<AdvancedPayrollAccess> {
  const [billing, stored] = await Promise.all([
    getOrganizationBillingState(organizationId),
    getAdvancedPayrollSettings(storeId),
  ]);
  const entitled = getPlanFeatures(billing ?? DEFAULT_BILLING_STATE).advancedPayroll;
  return { entitled, stored, settings: { ...stored, switches: effectiveSwitches(entitled, stored.switches) } };
}

/** context ขั้นสูงของงวด — โหลดยอดขายเฉพาะเมื่อเปิดโบนัสยอดขาย; ประวัติเรทโหลดเสมอ (ข้อมูลเงินเดือนต้องถูกแม้หมดแพ็ก) */
export async function loadAdvancedContext(
  storeId: string,
  settings: AdvancedPayrollSettings,
  periodStart: string,
  periodEnd: string,
): Promise<AdvancedComputeContext> {
  const sw = settings.switches;
  const [skills, rates, dailySales, maxBefore] = await Promise.all([
    sw.skillPay ? listEmployeeSkillGrants(storeId) : Promise.resolve(new Map()),
    listPayRates(storeId),
    sw.salesBonus
      ? loadDailySales(storeId, periodStart, periodEnd, settings.salesBonusChannels)
      : Promise.resolve(new Map<string, number>()),
    sw.salesBonus
      ? loadMaxDailySalesBefore(storeId, periodStart, settings.salesBonusChannels)
      : Promise.resolve(0),
  ]);
  const userIds = new Set<string>([...skills.keys(), ...rates.keys()]);
  const employees = new Map(
    [...userIds].map((id) => [id, { skills: skills.get(id) ?? [], rates: rates.get(id) ?? [] }]),
  );
  return { settings, employees, dailySales, maxSalesBeforePeriod: maxBefore };
}

export interface StorePayrollResult {
  lines: AdvancedPayrollLine[];
  profiles: EmployeeProfile[];
  hrSettings: StoreHrSettings;
  access: AdvancedPayrollAccess;
  issuer: { name: string; address?: string; taxId?: string };
  storeName: string;
  currency: string;
  timezone: string;
  closingTime: string | null;
}

/**
 * คำนวณเงินเดือนทั้งสาขา (service client) — roster = สมาชิกที่ผูกสาขานี้หรือทั้งองค์กร (ไม่รวม super_admin)
 * attendance อ่านทั้งองค์กรแล้วกรองด้วย roster (เหมือนหน้า /staff)
 */
export async function computeStorePayroll(input: {
  organizationId: string;
  storeId: string;
  periodStart: string;
  periodEnd: string;
  today: string;
}): Promise<StorePayrollResult> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- อ่านหลายตารางแบบเดียวกับ repository เดิม
  const db: any = await createSupabaseServiceClient();
  const [storeRes, membersRes, profilesRes, recordsRes, adjRes, holidaysRes, hrRes, receiptRes, access, selfRes] = await Promise.all([
    db.from("stores").select("name, timezone, currency_code, closing_time").eq("id", input.storeId).maybeSingle(),
    db
      .from("memberships")
      .select("user_id, role, store_id")
      .eq("organization_id", input.organizationId)
      .or(`store_id.eq.${input.storeId},store_id.is.null`)
      .not("joined_at", "is", null),
    db.from("employee_profiles").select("*").eq("store_id", input.storeId),
    db
      .from("attendance_records")
      .select("*")
      .eq("organization_id", input.organizationId)
      .gte("date", input.periodStart)
      .lte("date", input.periodEnd)
      .order("date", { ascending: false })
      .order("clock_in_at", { ascending: false }),
    db
      .from("payroll_adjustments")
      .select("*")
      .eq("store_id", input.storeId)
      .gte("date", input.periodStart)
      .lte("date", input.periodEnd),
    db.from("store_holidays").select("date").eq("store_id", input.storeId).gte("date", input.periodStart).lte("date", input.periodEnd),
    db.from("store_hr_settings").select("*").eq("store_id", input.storeId).maybeSingle(),
    db.from("receipt_settings").select("store_name, address, tax_id").eq("store_id", input.storeId).maybeSingle(),
    getAdvancedPayrollAccess(input.organizationId, input.storeId),
    // ข้อมูลที่พนักงานกรอกเอง — ใช้แทนช่องตัวตน/บัญชีที่เจ้าของยังไม่ตั้ง (อ่านไม่ได้ = ข้าม)
    db.from("employee_self_info").select("user_id, full_name, bank_name, bank_account_no, bank_account_name").eq("store_id", input.storeId),
  ]);
  for (const r of [storeRes, membersRes, profilesRes, recordsRes, adjRes, holidaysRes]) {
    if (r.error) throw new Error(r.error.message);
  }

  const timezone: string = storeRes.data?.timezone ?? "Asia/Bangkok";
  const storeName: string = storeRes.data?.name ?? "";
  const hrSettings: StoreHrSettings = hrRes.data
    ? mapHrSettings(hrRes.data)
    : { storeId: input.storeId, organizationId: input.organizationId, ...DEFAULT_HR_SETTINGS, createdAt: "", updatedAt: "" };
  const roster = new Set<string>(
    ((membersRes.data ?? []) as { user_id: string; role: string }[]).filter((m) => m.role !== "super_admin").map((m) => m.user_id),
  );
  const records = (recordsRes.data ?? []).map(mapRecord).filter((r: { userId: string }) => roster.has(r.userId));
  if (selfRes?.error) {
    await logSystemEvent({
      level: "warn",
      source: "hr.self-info",
      action: "computeStorePayroll.selfInfo",
      message: `อ่านข้อมูลที่พนักงานกรอกเองไม่สำเร็จ (สลิปใช้เฉพาะค่าของร้าน): ${selfRes.error.message}`,
      organizationId: input.organizationId,
      storeId: input.storeId,
      context: { code: selfRes.error.code },
    }).catch(() => undefined);
  }
  const selfByUser = new Map<string, EmployeeSelfInfo>(
    ((selfRes?.data ?? []) as { user_id: string; full_name: string | null; bank_name: string | null; bank_account_no: string | null; bank_account_name: string | null }[]).map((r) => [
      r.user_id,
      {
        storeId: input.storeId,
        userId: r.user_id,
        fullName: r.full_name ?? undefined,
        bankName: r.bank_name ?? undefined,
        bankAccountNo: r.bank_account_no ?? undefined,
        bankAccountName: r.bank_account_name ?? undefined,
      },
    ]),
  );
  const profiles: EmployeeProfile[] = (profilesRes.data ?? [])
    .map(mapProfile)
    .filter((p: EmployeeProfile) => roster.has(p.userId))
    .map((p: EmployeeProfile) => applySelfInfo(p, selfByUser.get(p.userId)));
  const adjustments = (adjRes.data ?? []).map(mapAdjustment).filter((a: { userId: string }) => roster.has(a.userId));
  const summaries = computePayrollSummaries(records, null, input.organizationId, input.periodStart, input.periodEnd);
  const adv = await loadAdvancedContext(input.storeId, access.settings, input.periodStart, input.periodEnd);

  const lines = computeAdvancedPayrollLines(
    {
      summaries,
      records,
      profiles,
      adjustments,
      settings: hrSettings,
      holidayDates: ((holidaysRes.data ?? []) as { date: string }[]).map((h) => h.date),
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      today: input.today,
      timezone,
    },
    adv,
  );

  const receipt = receiptRes.data
    ? { storeName: receiptRes.data.store_name ?? undefined, address: receiptRes.data.address ?? undefined, taxId: receiptRes.data.tax_id ?? undefined }
    : null;

  return {
    lines,
    profiles,
    hrSettings,
    access,
    issuer: resolvePayslipIssuer(hrSettings, receipt, storeName),
    storeName,
    currency: storeRes.data?.currency_code ?? "THB",
    timezone,
    closingTime: storeRes.data?.closing_time ?? null,
  };
}
