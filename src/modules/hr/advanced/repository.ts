/**
 * ที่เก็บข้อมูล "เงินเดือนขั้นสูง" — ใช้ service client เฉพาะใน server code ที่ตรวจสิทธิ์แล้วเท่านั้น
 * (ตารางใหม่ยังไม่อยู่ใน database.types จึงพิมพ์ type ของแถวเองที่นี่)
 * ทุกฟังก์ชันกรองด้วย store_id เสมอ
 */
import {
  createSupabaseServerClient,
  createSupabaseServiceClient,
} from "@/server/integrations/supabase/server";
import { mapError } from "@/shared/utils/error";
import type { PayType } from "../types";
import {
  DEFAULT_ADVANCED_PAYROLL_SETTINGS,
  normalizeSwitches,
  parseTiers,
  SALES_CHANNELS,
  type AdvancedPayrollSettings,
  type SalesChannel,
} from "./settings";
import type { EmployeeSkillGrant, PayRateEntry } from "./income";
import { logSystemEvent } from "@/modules/system/event-log";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- ตารางใหม่ยังไม่อยู่ใน database.types
type Db = any;

async function service(): Promise<Db> {
  return createSupabaseServiceClient();
}

// ---------------------------------------------------------------------------
// ตั้งค่า
// ---------------------------------------------------------------------------
export function mapAdvancedSettings(row: Record<string, unknown> | null | undefined): AdvancedPayrollSettings {
  if (!row) return { ...DEFAULT_ADVANCED_PAYROLL_SETTINGS, switches: { ...DEFAULT_ADVANCED_PAYROLL_SETTINGS.switches } };
  const d = DEFAULT_ADVANCED_PAYROLL_SETTINGS;
  const n = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? v : Number(v ?? NaN) || fallback);
  const channels = Array.isArray(row.sales_bonus_channels)
    ? (row.sales_bonus_channels as string[]).filter((c): c is SalesChannel => (SALES_CHANNELS as string[]).includes(c))
    : d.salesBonusChannels;
  return {
    switches: normalizeSwitches({
      salesTargetBar: row.feat_sales_target_bar === true,
      salesBonus: row.feat_sales_bonus === true,
      monthlySalesBonus: row.feat_monthly_sales_bonus === true,
      skillPay: row.feat_skill_pay === true,
      seniorityPay: row.feat_seniority_pay === true,
      socialSecurity: row.feat_social_security === true,
      withholdingTax: row.feat_withholding_tax === true,
      payCycle: row.feat_pay_cycle === true,
      myPayslip: row.feat_my_payslip === true,
      payrollNotifications: row.feat_payroll_notifications === true,
      weeklyPay: row.feat_weekly_pay === true,
    }),
    payCycleStartDay: n(row.pay_cycle_start_day, d.payCycleStartDay),
    payDay: row.pay_day === 0 ? 0 : n(row.pay_day, d.payDay),
    skillTiers: row.skill_tiers ? parseTiers(row.skill_tiers, "count", { maxKey: 50, maxAmount: 1_000_000 }) : d.skillTiers,
    seniorityTiers: row.seniority_tiers ? parseTiers(row.seniority_tiers, "months", { maxKey: 600, maxAmount: 1_000_000 }) : d.seniorityTiers,
    salesBonusTiers: row.sales_bonus_tiers ? parseTiers(row.sales_bonus_tiers, "minSales", { maxKey: 100_000_000, maxAmount: 1_000_000 }) : d.salesBonusTiers,
    salesBonusChannels: channels.length ? channels : d.salesBonusChannels,
    salesBonusLateMaxMinutes:
      row.sales_bonus_late_max_minutes === null || row.sales_bonus_late_max_minutes === undefined
        ? null
        : n(row.sales_bonus_late_max_minutes, 0),
    salesRecordBonus: n(row.sales_record_bonus, d.salesRecordBonus),
    salesRecordMode: row.sales_record_mode === "stack" ? "stack" : "replace",
    salesRecordBaseline: n(row.sales_record_baseline, 0),
    salesBonusMode: row.sales_bonus_mode === "split" ? "split" : "per_person",
    salesBonusUserIds: Array.isArray(row.sales_bonus_user_ids)
      ? (row.sales_bonus_user_ids as unknown[]).filter((v): v is string => typeof v === "string")
      : null,
    monthlyBonusTiers: row.monthly_bonus_tiers
      ? parseTiers(row.monthly_bonus_tiers, "minSales", { maxKey: 1_000_000_000, maxAmount: 10_000_000 })
      : d.monthlyBonusTiers,
    monthlyBonusMode: row.monthly_bonus_mode === "split" ? "split" : "per_person",
    ssoRate: n(row.sso_rate, d.ssoRate),
    ssoWageFloor: n(row.sso_wage_floor, d.ssoWageFloor),
    ssoWageCeiling: n(row.sso_wage_ceiling, d.ssoWageCeiling),
    whtMode: row.wht_mode === "percent" ? "percent" : "manual",
    // 0 = อาทิตย์ เป็นค่าที่ถูกต้อง (n() จะแทน 0 ด้วยค่าเริ่มต้น จึงตรวจเอง)
    weeklyStartDay:
      Number.isInteger(Number(row.weekly_start_day)) && Number(row.weekly_start_day) >= 0 && Number(row.weekly_start_day) <= 6 && row.weekly_start_day !== null && row.weekly_start_day !== undefined
        ? Number(row.weekly_start_day)
        : d.weeklyStartDay,
    weeklyRateBasis: row.weekly_rate_basis === "working_days" ? "working_days" : "profile",
    weeklyPayEnabledAt: (row.weekly_pay_enabled_at as string | null) ?? null,
    payCycleEnabledAt: (row.pay_cycle_enabled_at as string | null) ?? null,
  };
}

export async function getAdvancedPayrollSettings(storeId: string): Promise<AdvancedPayrollSettings> {
  const db = await service();
  const { data } = await db.from("store_hr_settings").select("*").eq("store_id", storeId).maybeSingle();
  return mapAdvancedSettings(data);
}

export async function saveAdvancedPayrollSettings(
  storeId: string,
  organizationId: string,
  s: AdvancedPayrollSettings,
) {
  const db = await service();
  const sw = normalizeSwitches(s.switches);
  const { error } = await db.from("store_hr_settings").upsert(
    {
      store_id: storeId,
      organization_id: organizationId,
      feat_sales_target_bar: sw.salesTargetBar,
      feat_sales_bonus: sw.salesBonus,
      feat_monthly_sales_bonus: sw.monthlySalesBonus,
      feat_skill_pay: sw.skillPay,
      feat_seniority_pay: sw.seniorityPay,
      feat_social_security: sw.socialSecurity,
      feat_withholding_tax: sw.withholdingTax,
      feat_pay_cycle: sw.payCycle,
      feat_my_payslip: sw.myPayslip,
      feat_payroll_notifications: sw.payrollNotifications,
      feat_weekly_pay: sw.weeklyPay,
      weekly_start_day: s.weeklyStartDay,
      weekly_rate_basis: s.weeklyRateBasis,
      weekly_pay_enabled_at: sw.weeklyPay ? s.weeklyPayEnabledAt ?? null : null,
      pay_cycle_start_day: s.payCycleStartDay,
      pay_day: s.payDay,
      skill_tiers: s.skillTiers,
      seniority_tiers: s.seniorityTiers,
      sales_bonus_tiers: s.salesBonusTiers,
      sales_bonus_channels: s.salesBonusChannels,
      sales_bonus_late_max_minutes: s.salesBonusLateMaxMinutes,
      sales_record_bonus: s.salesRecordBonus,
      sales_record_mode: s.salesRecordMode,
      sales_record_baseline: s.salesRecordBaseline,
      sales_bonus_mode: s.salesBonusMode,
      sales_bonus_user_ids: s.salesBonusUserIds,
      monthly_bonus_tiers: s.monthlyBonusTiers,
      monthly_bonus_mode: s.monthlyBonusMode,
      sso_rate: s.ssoRate,
      sso_wage_floor: s.ssoWageFloor,
      sso_wage_ceiling: s.ssoWageCeiling,
      wht_mode: s.whtMode,
      pay_cycle_enabled_at: sw.payCycle ? s.payCycleEnabledAt ?? null : null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "store_id" },
  );
  if (error) return { ok: false, error: mapError(error) };
  return { ok: true, error: null };
}

/** สาขาที่เปิดอย่างน้อยหนึ่งสวิตช์ที่ต้องใช้ cron */
export async function listStoresWithPayrollAutomation(): Promise<
  { storeId: string; organizationId: string; row: Record<string, unknown> }[]
> {
  const db = await service();
  const { data, error } = await db
    .from("store_hr_settings")
    .select("*")
    .or("feat_pay_cycle.eq.true,feat_payroll_notifications.eq.true,feat_sales_bonus.eq.true,feat_weekly_pay.eq.true");
  if (error || !data) return [];
  return (data as Record<string, unknown>[]).map((row) => ({
    storeId: String(row.store_id),
    organizationId: String(row.organization_id),
    row,
  }));
}

// ---------------------------------------------------------------------------
// ทักษะ
// ---------------------------------------------------------------------------
export interface StoreSkill {
  id: string;
  name: string;
  sortOrder: number;
}

export async function listStoreSkills(storeId: string): Promise<StoreSkill[]> {
  const db = await service();
  const { data } = await db
    .from("store_skills")
    .select("id, name, sort_order")
    .eq("store_id", storeId)
    .is("archived_at", null)
    .order("sort_order")
    .order("created_at");
  return ((data ?? []) as { id: string; name: string; sort_order: number }[]).map((r) => ({
    id: r.id,
    name: r.name,
    sortOrder: r.sort_order,
  }));
}

export async function addStoreSkill(storeId: string, organizationId: string, name: string, sortOrder: number) {
  const db = await service();
  const { error } = await db.from("store_skills").insert({ store_id: storeId, organization_id: organizationId, name, sort_order: sortOrder });
  if (error) return { ok: false, error: mapError(error) };
  return { ok: true, error: null };
}

/** เก็บประวัติไว้ (ไม่ลบ) — ทักษะที่เก็บแล้วไม่แสดงในฟอร์มอีก และถอนจากพนักงานทุกคน ณ วันนี้ */
export async function archiveStoreSkill(storeId: string, skillId: string, today: string) {
  const db = await service();
  const { error } = await db
    .from("store_skills")
    .update({ archived_at: new Date().toISOString() })
    .eq("store_id", storeId)
    .eq("id", skillId);
  if (error) return { ok: false, error: mapError(error) };
  const { error: revokeError } = await db
    .from("employee_skills")
    .update({ revoked_at: today })
    .eq("store_id", storeId)
    .eq("skill_id", skillId)
    .is("revoked_at", null);
  if (revokeError) return { ok: false, error: mapError(revokeError) };
  return { ok: true, error: null };
}

/** ทักษะของพนักงานทุกคนในสาขา (รวมที่ถอนแล้ว เพื่อคิดย้อนหลังได้) */
export async function listEmployeeSkillGrants(storeId: string): Promise<Map<string, EmployeeSkillGrant[]>> {
  const db = await service();
  const { data } = await db
    .from("employee_skills")
    .select("user_id, skill_id, granted_at, revoked_at, store_skills(name)")
    .eq("store_id", storeId);
  const out = new Map<string, EmployeeSkillGrant[]>();
  for (const r of (data ?? []) as {
    user_id: string;
    skill_id: string;
    granted_at: string;
    revoked_at: string | null;
    store_skills: { name: string } | null;
  }[]) {
    const list = out.get(r.user_id) ?? [];
    list.push({ skillId: r.skill_id, skillName: r.store_skills?.name ?? "", grantedAt: r.granted_at, revokedAt: r.revoked_at });
    out.set(r.user_id, list);
  }
  return out;
}

/**
 * ตั้งทักษะที่พนักงานมี "ตอนนี้" — ได้ใหม่ = granted_at วันนี้, ถูกเอาออก = revoked_at วันนี้
 * (มีผลงวดถัดไปเองตามกติกา R9 เพราะงวดนี้ดูสถานะ ณ วันแรกของงวด)
 */
export async function setEmployeeSkills(input: {
  storeId: string;
  organizationId: string;
  userId: string;
  skillIds: string[];
  today: string;
  actorUserId: string;
}): Promise<{ granted: string[]; revoked: string[]; error: string | null }> {
  const db = await service();
  const { data: current, error } = await db
    .from("employee_skills")
    .select("id, skill_id")
    .eq("store_id", input.storeId)
    .eq("user_id", input.userId)
    .is("revoked_at", null);
  if (error) return { granted: [], revoked: [], error: mapError(error).userMessage };
  const have = new Map<string, string>(
    ((current ?? []) as { id: string; skill_id: string }[]).map((r) => [r.skill_id, r.id]),
  );
  const want = new Set(input.skillIds);
  const toRevoke = [...have.entries()].filter(([skillId]) => !want.has(skillId));
  const toGrant = [...want].filter((id) => !have.has(id));
  if (toRevoke.length) {
    const { error: e } = await db
      .from("employee_skills")
      .update({ revoked_at: input.today })
      .in("id", toRevoke.map(([, id]) => id));
    if (e) return { granted: [], revoked: [], error: mapError(e).userMessage };
  }
  if (toGrant.length) {
    const { error: e } = await db.from("employee_skills").insert(
      toGrant.map((skillId) => ({
        organization_id: input.organizationId,
        store_id: input.storeId,
        user_id: input.userId,
        skill_id: skillId,
        granted_at: input.today,
        granted_by: input.actorUserId,
      })),
    );
    if (e) return { granted: [], revoked: toRevoke.map(([s]) => s), error: mapError(e).userMessage };
  }
  return { granted: toGrant, revoked: toRevoke.map(([s]) => s), error: null };
}

// ---------------------------------------------------------------------------
// ประวัติเรท
// ---------------------------------------------------------------------------
export async function listPayRates(storeId: string): Promise<Map<string, PayRateEntry[]>> {
  const db = await service();
  const { data } = await db
    .from("employee_pay_rates")
    .select("user_id, pay_type, monthly_salary, daily_rate, hourly_rate, effective_from")
    .eq("store_id", storeId)
    .order("effective_from");
  const out = new Map<string, PayRateEntry[]>();
  for (const r of (data ?? []) as {
    user_id: string;
    pay_type: PayType;
    monthly_salary: number;
    daily_rate: number;
    hourly_rate: number;
    effective_from: string;
  }[]) {
    const list = out.get(r.user_id) ?? [];
    list.push({
      payType: r.pay_type,
      monthlySalary: Number(r.monthly_salary),
      dailyRate: Number(r.daily_rate),
      hourlyRate: Number(r.hourly_rate),
      effectiveFrom: r.effective_from,
    });
    out.set(r.user_id, list);
  }
  return out;
}

/** บันทึกเรทใหม่ + เรทเดิม (ถ้ายังไม่มีประวัติ) เพื่อให้งวดเก่าใช้เรทเดิม (R13) */
export async function recordPayRateChange(input: {
  storeId: string;
  organizationId: string;
  userId: string;
  previous: Omit<PayRateEntry, "effectiveFrom"> | null;
  next: Omit<PayRateEntry, "effectiveFrom">;
  effectiveFrom: string;
  actorUserId: string;
}) {
  const db = await service();
  const { count } = await db
    .from("employee_pay_rates")
    .select("id", { count: "exact", head: true })
    .eq("store_id", input.storeId)
    .eq("user_id", input.userId);
  const rows: Record<string, unknown>[] = [];
  const toRow = (r: Omit<PayRateEntry, "effectiveFrom">, effectiveFrom: string) => ({
    organization_id: input.organizationId,
    store_id: input.storeId,
    user_id: input.userId,
    pay_type: r.payType,
    monthly_salary: r.monthlySalary,
    daily_rate: r.dailyRate,
    hourly_rate: r.hourlyRate,
    effective_from: effectiveFrom,
    created_by: input.actorUserId,
  });
  if (!count && input.previous) rows.push(toRow(input.previous, "2000-01-01"));
  rows.push(toRow(input.next, input.effectiveFrom));
  const { error } = await db.from("employee_pay_rates").upsert(rows, { onConflict: "store_id,user_id,effective_from" });
  if (error) return { ok: false, error: mapError(error) };
  return { ok: true, error: null };
}

// ---------------------------------------------------------------------------
// ยอดขายรายวัน (RPC ใน DB — aggregate ไม่ดึงออเดอร์ทุกแถว)
// ---------------------------------------------------------------------------
export async function loadDailySales(
  storeId: string,
  from: string,
  to: string,
  channels: SalesChannel[],
): Promise<Map<string, number>> {
  const db = await service();
  const { data, error } = await db.rpc("payroll_store_daily_sales", {
    p_store_id: storeId,
    p_from: from,
    p_to: to,
    p_channels: channels,
  });
  if (error) throw new Error(`payroll_store_daily_sales: ${error.message}`);
  return new Map(((data ?? []) as { business_date: string; total: number }[]).map((r) => [r.business_date, Number(r.total)]));
}

export async function loadMaxDailySalesBefore(storeId: string, before: string, channels: SalesChannel[]): Promise<number> {
  const db = await service();
  const { data, error } = await db.rpc("payroll_store_max_daily_sales_before", {
    p_store_id: storeId,
    p_before: before,
    p_channels: channels,
  });
  if (error) throw new Error(`payroll_store_max_daily_sales_before: ${error.message}`);
  return Number(data ?? 0);
}

// ---------------------------------------------------------------------------
// งวด + สลิป
// ---------------------------------------------------------------------------
export interface PayrollPeriodRow {
  id: string;
  periodStart: string;
  periodEnd: string;
  payDate: string;
  status: "closed" | "reopened";
  revision: number;
  closedAt: string | null;
  closedBy: string | null;
  totalNetPay: number;
  employeeCount: number;
}

function mapPeriod(r: Record<string, unknown>): PayrollPeriodRow {
  return {
    id: String(r.id),
    periodStart: String(r.period_start),
    periodEnd: String(r.period_end),
    payDate: String(r.pay_date),
    status: r.status === "reopened" ? "reopened" : "closed",
    revision: Number(r.revision ?? 1),
    closedAt: (r.closed_at as string | null) ?? null,
    closedBy: (r.closed_by as string | null) ?? null,
    totalNetPay: Number(r.total_net_pay ?? 0),
    employeeCount: Number(r.employee_count ?? 0),
  };
}

export async function listPayrollPeriods(storeId: string, limit = 24): Promise<PayrollPeriodRow[]> {
  const db = await service();
  const { data } = await db
    .from("payroll_periods")
    .select("*")
    .eq("store_id", storeId)
    .order("period_start", { ascending: false })
    .limit(limit);
  return ((data ?? []) as Record<string, unknown>[]).map(mapPeriod);
}

export async function getPayrollPeriod(storeId: string, periodStart: string): Promise<PayrollPeriodRow | null> {
  const db = await service();
  const { data } = await db
    .from("payroll_periods")
    .select("*")
    .eq("store_id", storeId)
    .eq("period_start", periodStart)
    .maybeSingle();
  return data ? mapPeriod(data) : null;
}

export interface PayslipSnapshotInsert {
  userId: string;
  netPay: number;
  data: unknown;
}

/**
 * ปิดงวด (R22, R24) ผ่าน RPC close_payroll_period_snapshot — ธุรกรรมเดียว + advisory lock ต่อสาขา/งวด
 * (upsert งวด → แทนฉบับเก่า → เพิ่มฉบับใหม่) ล้มขั้นไหน = ย้อนทั้งหมด; ปิดแล้ว = ไม่ทำซ้ำ
 * เรียกจาก server ที่ตรวจสิทธิ์แล้ว หรือ cron ที่ยืนยันกุญแจแล้วเท่านั้น
 */
export async function savePeriodSnapshot(input: {
  storeId: string;
  organizationId: string;
  periodStart: string;
  periodEnd: string;
  payDate: string;
  closedBy: string | null;
  slips: PayslipSnapshotInsert[];
}): Promise<{ periodId: string | null; revision: number; alreadyClosed: boolean; error: string | null }> {
  const db = await service();
  const { data, error } = await db.rpc("close_payroll_period_snapshot", {
    p_organization_id: input.organizationId,
    p_store_id: input.storeId,
    p_period_start: input.periodStart,
    p_period_end: input.periodEnd,
    p_pay_date: input.payDate,
    p_closed_by: input.closedBy,
    p_slips: input.slips.map((s) => ({ user_id: s.userId, net_pay: s.netPay, data: s.data })),
  });
  if (error) return { periodId: null, revision: 0, alreadyClosed: false, error: mapError(error).userMessage };
  const r = (data ?? {}) as { status?: string; period_id?: string; revision?: number };
  return {
    periodId: r.period_id ?? null,
    revision: Number(r.revision ?? 0),
    alreadyClosed: r.status === "already_closed",
    error: null,
  };
}

export async function reopenPayrollPeriod(storeId: string, periodId: string, actorUserId: string) {
  const db = await service();
  const { error } = await db
    .from("payroll_periods")
    .update({ status: "reopened", reopened_at: new Date().toISOString(), reopened_by: actorUserId })
    .eq("store_id", storeId)
    .eq("id", periodId);
  if (error) return { ok: false, error: mapError(error) };
  return { ok: true, error: null };
}

export interface PayslipRow {
  id: string;
  periodId: string;
  userId: string;
  revision: number;
  docNo: string;
  netPay: number;
  data: unknown;
  visibleFrom: string;
  supersededAt: string | null;
  createdAt: string;
}

function mapPayslip(r: Record<string, unknown>): PayslipRow {
  return {
    id: String(r.id),
    periodId: String(r.period_id),
    userId: String(r.user_id),
    revision: Number(r.revision ?? 1),
    docNo: String(r.doc_no),
    netPay: Number(r.net_pay),
    data: r.data,
    visibleFrom: String(r.visible_from),
    supersededAt: (r.superseded_at as string | null) ?? null,
    createdAt: String(r.created_at),
  };
}

/** ผู้จัดการ: สลิปฉบับปัจจุบันของงวด */
export async function listCurrentPayslipsForPeriod(storeId: string, periodId: string): Promise<PayslipRow[]> {
  const db = await service();
  const { data } = await db
    .from("payslips")
    .select("*")
    .eq("store_id", storeId)
    .eq("period_id", periodId)
    .is("superseded_at", null);
  return ((data ?? []) as Record<string, unknown>[]).map(mapPayslip);
}

/** พนักงาน: ผ่าน RLS (เห็นเฉพาะของตัวเอง ฉบับปัจจุบัน ถึงวันจ่ายแล้ว และยังไม่พ้นวันออกงาน) */
export async function listMyVisiblePayslips(storeId: string): Promise<PayslipRow[]> {
  const supabase = await createSupabaseServerClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ตารางใหม่ยังไม่อยู่ใน database.types
  const { data } = await (supabase as any)
    .from("payslips")
    .select("*")
    .eq("store_id", storeId)
    .is("superseded_at", null)
    .order("visible_from", { ascending: false })
    .limit(36);
  return ((data ?? []) as Record<string, unknown>[]).map(mapPayslip);
}

// ---------------------------------------------------------------------------
// กันแจ้งเตือนซ้ำ
// ---------------------------------------------------------------------------
/** true = เพิ่งจองได้ (ส่งได้), false = เคยส่งแล้ว */
/** เคยบันทึกเหตุการณ์นี้แล้วหรือยัง (ใช้เป็นเครื่องหมาย "ทำแล้ว" ของ cron) */
export async function hasPayrollNotification(storeId: string, kind: string, dedupeKey: string): Promise<boolean> {
  const db = await service();
  const { data, error } = await db
    .from("payroll_notification_log")
    .select("dedupe_key")
    .eq("store_id", storeId)
    .eq("kind", kind)
    .eq("dedupe_key", dedupeKey)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return !!data;
}

/** จำนวนพนักงานที่ตั้งรอบจ่ายรายสัปดาห์ (cron ข้ามสาขาที่ไม่มีโดยไม่ต้องคำนวณ) */
export async function countWeeklyEmployees(storeId: string): Promise<number> {
  const db = await service();
  const { count, error } = await db
    .from("employee_profiles")
    .select("id", { count: "exact", head: true })
    .eq("store_id", storeId)
    .in("pay_frequency", ["weekly", "weekly_advance"]);
  if (error) throw new Error(error.message);
  return count ?? 0;
}

export async function claimPayrollNotification(storeId: string, kind: string, dedupeKey: string): Promise<boolean> {
  const db = await service();
  const { error } = await db.from("payroll_notification_log").insert({ store_id: storeId, kind, dedupe_key: dedupeKey });
  return !error;
}

// ---------------------------------------------------------------------------
// จ่ายรายสัปดาห์ (W7/W8) — snapshot ยอดที่บันทึกแล้ว
// ---------------------------------------------------------------------------
export interface WeeklyPayoutRow {
  id: string;
  userId: string;
  weekStart: string;
  weekEnd: string;
  mode: "weekly" | "weekly_advance";
  amount: number;
  data: Record<string, unknown>;
  createdAt: string;
}

function mapWeeklyPayout(r: Record<string, unknown>): WeeklyPayoutRow {
  return {
    id: String(r.id),
    userId: String(r.user_id),
    weekStart: String(r.week_start),
    weekEnd: String(r.week_end),
    mode: r.mode === "weekly_advance" ? "weekly_advance" : "weekly",
    amount: Number(r.amount ?? 0),
    data: (r.data as Record<string, unknown>) ?? {},
    createdAt: String(r.created_at ?? ""),
  };
}

/** ผลรวมยอดจ่ายล่วงหน้าต่อคน ของสัปดาห์ที่วันจบอยู่ในช่วง from–to (หักในงวดรายเดือน) */
export async function loadWeeklyAdvances(storeId: string, from: string, to: string): Promise<Map<string, number>> {
  const db = await service();
  const { data, error } = await db
    .from("payroll_weekly_payouts")
    .select("user_id, amount")
    .eq("store_id", storeId)
    .eq("mode", "weekly_advance")
    .gte("week_end", from)
    .lte("week_end", to);
  if (error) {
    // ตารางยังไม่ถูกสร้าง (โค้ดขึ้นก่อน migration) = ยังไม่เคยมียอดล่วงหน้า → หน้าเงินเดือนทุกสาขาต้องไม่ล่ม
    if (error.code === "42P01" || error.code === "PGRST205") {
      await logSystemEvent({
        level: "warn",
        source: "hr.payroll-weekly",
        action: "loadWeeklyAdvances",
        message: "ยังไม่มีตาราง payroll_weekly_payouts (ยังไม่ได้ apply migration) — ถือว่าไม่มียอดจ่ายล่วงหน้า",
        storeId,
        context: { code: error.code },
      }).catch(() => undefined);
      return new Map();
    }
    // error อื่นต้องไม่เงียบ — งวดรายเดือนจะจ่ายซ้ำ
    throw new Error(`อ่านยอดจ่ายล่วงหน้ารายสัปดาห์ไม่สำเร็จ: ${error.message}`);
  }
  const out = new Map<string, number>();
  for (const r of (data ?? []) as { user_id: string; amount: number | string }[]) {
    out.set(r.user_id, Math.round(((out.get(r.user_id) ?? 0) + Number(r.amount)) * 100) / 100);
  }
  return out;
}

/** บันทึกยอดรายสัปดาห์ — คนที่บันทึกแล้วในสัปดาห์นั้นไม่ถูกเขียนทับ (snapshot ครั้งเดียว) · คืนเฉพาะแถวที่เพิ่มใหม่ */
export async function saveWeeklyPayouts(
  rows: {
    storeId: string;
    organizationId: string;
    userId: string;
    weekStart: string;
    weekEnd: string;
    mode: "weekly" | "weekly_advance";
    amount: number;
    data: Record<string, unknown>;
  }[],
): Promise<{ inserted: WeeklyPayoutRow[]; error: string | null }> {
  if (rows.length === 0) return { inserted: [], error: null };
  const db = await service();
  const { data, error } = await db
    .from("payroll_weekly_payouts")
    .upsert(
      rows.map((r) => ({
        store_id: r.storeId,
        organization_id: r.organizationId,
        user_id: r.userId,
        week_start: r.weekStart,
        week_end: r.weekEnd,
        mode: r.mode,
        amount: r.amount,
        data: r.data,
      })),
      { onConflict: "store_id,user_id,week_start", ignoreDuplicates: true },
    )
    .select("*");
  if (error) return { inserted: [], error: error.message };
  return { inserted: ((data ?? []) as Record<string, unknown>[]).map(mapWeeklyPayout), error: null };
}

export async function listWeeklyPayouts(storeId: string, fromWeekStart: string): Promise<WeeklyPayoutRow[]> {
  const db = await service();
  const { data, error } = await db
    .from("payroll_weekly_payouts")
    .select("*")
    .eq("store_id", storeId)
    .gte("week_start", fromWeekStart)
    .order("week_start", { ascending: false })
    .limit(500);
  if (error) throw new Error(error.message);
  return ((data ?? []) as Record<string, unknown>[]).map(mapWeeklyPayout);
}
