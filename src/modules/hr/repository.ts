import {
  createSupabaseServerClient,
  createSupabaseServiceClient,
} from "@/server/integrations/supabase/server";
import { mapError } from "@/shared/utils/error";
import type { EmployeeIdentityInput } from "./employee-identity";
import type {
  EmployeeProfile,
  PayrollAdjustment,
  PayType,
  AdjustmentType,
  StoreHrSettings,
  StoreOtDay,
  OtMode,
  OtOverflowPay,
} from "./types";
import { DEFAULT_HR_SETTINGS } from "./types";
import type { Database } from "@/server/integrations/supabase/database.types";

type ProfileRow = Database["public"]["Tables"]["employee_profiles"]["Row"];
type AdjustmentRow = Database["public"]["Tables"]["payroll_adjustments"]["Row"];
type HrSettingsRow = Database["public"]["Tables"]["store_hr_settings"]["Row"];
type OtDayRow = Database["public"]["Tables"]["store_ot_days"]["Row"];

export function mapProfile(row: ProfileRow): EmployeeProfile {
  return {
    id: row.id,
    organizationId: row.organization_id,
    storeId: row.store_id,
    userId: row.user_id,
    displayName: row.display_name ?? undefined,
    payType: row.pay_type,
    monthlySalary: row.monthly_salary,
    dailyRate: row.daily_rate,
    hourlyRate: row.hourly_rate,
    expectedStartTime: row.expected_start_time ?? undefined,
    lateGraceMinutes: row.late_grace_minutes,
    latePenaltyAmount: row.late_penalty_amount,
    absentPenaltyAmount: row.absent_penalty_amount,
    workingDays: row.working_days ?? [],
    otEligible: row.ot_eligible,
    employeeCode: row.employee_code ?? undefined,
    fullName: row.full_name ?? undefined,
    position: row.position ?? undefined,
    employmentType: row.employment_type ?? "permanent",
    permanentSince: row.permanent_since ?? undefined,
    seniorityStartDate: row.seniority_start_date ?? undefined,
    employmentEndDate: row.employment_end_date ?? undefined,
    bankName: row.bank_name ?? undefined,
    bankAccountNo: row.bank_account_no ?? undefined,
    bankAccountName: row.bank_account_name ?? undefined,
    ssoEnabled: row.sso_enabled ?? true,
    withholdingTaxRate: row.withholding_tax_rate ?? 0,
    payFrequency:
      row.pay_frequency === "weekly" || row.pay_frequency === "weekly_advance" ? row.pay_frequency : "monthly",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function mapHrSettings(row: HrSettingsRow): StoreHrSettings {
  return {
    storeId: row.store_id,
    organizationId: row.organization_id,
    regularHoursPerDay: row.regular_hours_per_day,
    otMultiplier: row.ot_multiplier,
    otDailyCapHours: row.ot_daily_cap_hours,
    otMode: row.ot_mode === "scheduled" ? "scheduled" : "daily",
    otOverflowPay: row.ot_overflow_pay === "none" ? "none" : "regular",
    latePenaltyPerMinute: row.late_penalty_per_minute,
    latePenaltyMaxPerDay: row.late_penalty_max_per_day,
    absentPenaltyPerDay: row.absent_penalty_per_day,
    halfDayMaxHours: row.half_day_max_hours ?? 0,
    backdatedRightsPerMonth: row.backdated_rights_per_month,
    workingDays: row.working_days ?? [0, 1, 2, 3, 4, 5, 6],
    payslipLegalName: row.payslip_legal_name ?? undefined,
    payslipAddress: row.payslip_address ?? undefined,
    payslipTaxId: row.payslip_tax_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function mapAdjustment(row: AdjustmentRow): PayrollAdjustment {
  return {
    id: row.id,
    organizationId: row.organization_id,
    storeId: row.store_id,
    userId: row.user_id,
    employeeName: row.employee_name,
    date: row.date,
    type: row.type,
    amount: row.amount,
    note: row.note ?? undefined,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
  };
}

export async function listEmployeeProfiles(storeId: string) {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("employee_profiles")
    .select("*")
    .eq("store_id", storeId);
  if (error) return { data: null, error: mapError(error) };
  return { data: (data ?? []).map(mapProfile), error: null };
}

export interface UpsertProfileInput {
  storeId: string;
  organizationId: string;
  userId: string;
  displayName?: string;
  payType: PayType;
  monthlySalary: number;
  dailyRate: number;
  hourlyRate: number;
  expectedStartTime?: string;
  lateGraceMinutes: number;
  latePenaltyAmount: number;
  absentPenaltyAmount: number;
  workingDays: number[];
  otEligible: boolean;
  /** ข้อมูลสำหรับสลิป — ไม่ส่ง = ไม่แตะคอลัมน์เหล่านี้ */
  identity?: EmployeeIdentityInput;
  /** เงินเดือนขั้นสูง: ประกันสังคม/ภาษีรายคน — ไม่ส่ง = ไม่แตะ */
  advanced?: { ssoEnabled?: boolean; withholdingTaxRate?: number; payFrequency?: "monthly" | "weekly" | "weekly_advance" };
}

export async function upsertEmployeeProfile(input: UpsertProfileInput) {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.from("employee_profiles").upsert(
    {
      store_id: input.storeId,
      organization_id: input.organizationId,
      user_id: input.userId,
      display_name: input.displayName ?? null,
      pay_type: input.payType,
      monthly_salary: input.monthlySalary,
      daily_rate: input.dailyRate,
      hourly_rate: input.hourlyRate,
      expected_start_time: input.expectedStartTime ?? null,
      late_grace_minutes: input.lateGraceMinutes,
      late_penalty_amount: input.latePenaltyAmount,
      absent_penalty_amount: input.absentPenaltyAmount,
      working_days: input.workingDays,
      ot_eligible: input.otEligible,
      ...(input.identity
        ? {
            employee_code: input.identity.employeeCode ?? null,
            full_name: input.identity.fullName ?? null,
            position: input.identity.position ?? null,
            employment_type: input.identity.employmentType,
            permanent_since: input.identity.permanentSince ?? null,
            // ว่าง = ไม่แตะ: ระบบตั้งให้จากการลงเวลาครั้งแรก (trigger) ไม่ควรถูกล้างด้วยฟอร์มว่าง
            ...(input.identity.seniorityStartDate
              ? { seniority_start_date: input.identity.seniorityStartDate }
              : {}),
            employment_end_date: input.identity.employmentEndDate ?? null,
            bank_name: input.identity.bankName ?? null,
            // ฟอร์มไม่มีเลขเต็ม (ไม่ส่งไป browser) → ว่าง = คงเลขเดิม เว้นแต่ติ๊กลบ
            ...(input.identity.bankAccountNo
              ? { bank_account_no: input.identity.bankAccountNo }
              : input.identity.clearBankAccount
                ? { bank_account_no: null }
                : {}),
            bank_account_name: input.identity.bankAccountName ?? null,
          }
        : {}),
      ...(input.advanced?.ssoEnabled !== undefined ? { sso_enabled: input.advanced.ssoEnabled } : {}),
      ...(input.advanced?.withholdingTaxRate !== undefined
        ? { withholding_tax_rate: input.advanced.withholdingTaxRate }
        : {}),
      ...(input.advanced?.payFrequency !== undefined ? { pay_frequency: input.advanced.payFrequency } : {}),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "store_id,user_id" },
  );
  if (error) return { ok: false, error: mapError(error) };
  return { ok: true, error: null };
}

/** Store HR policy; returns defaults (not persisted) when no row exists yet. */
export async function getStoreHrSettings(
  storeId: string,
  organizationId: string,
): Promise<StoreHrSettings> {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase
    .from("store_hr_settings")
    .select("*")
    .eq("store_id", storeId)
    .maybeSingle();
  if (data) return mapHrSettings(data);
  return {
    storeId,
    organizationId,
    ...DEFAULT_HR_SETTINGS,
    createdAt: "",
    updatedAt: "",
  };
}

export interface UpsertHrSettingsInput {
  storeId: string;
  organizationId: string;
  regularHoursPerDay: number;
  otMultiplier: number;
  otDailyCapHours: number;
  otMode: OtMode;
  otOverflowPay: OtOverflowPay;
  latePenaltyPerMinute: number;
  latePenaltyMaxPerDay: number;
  absentPenaltyPerDay: number;
  halfDayMaxHours: number;
  backdatedRightsPerMonth: number;
}

export async function upsertStoreHrSettings(input: UpsertHrSettingsInput) {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.from("store_hr_settings").upsert(
    {
      store_id: input.storeId,
      organization_id: input.organizationId,
      regular_hours_per_day: input.regularHoursPerDay,
      ot_multiplier: input.otMultiplier,
      ot_daily_cap_hours: input.otDailyCapHours,
      ot_mode: input.otMode,
      ot_overflow_pay: input.otOverflowPay,
      late_penalty_per_minute: input.latePenaltyPerMinute,
      late_penalty_max_per_day: input.latePenaltyMaxPerDay,
      absent_penalty_per_day: input.absentPenaltyPerDay,
      half_day_max_hours: input.halfDayMaxHours,
      backdated_rights_per_month: input.backdatedRightsPerMonth,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "store_id" },
  );
  if (error) return { ok: false, error: mapError(error) };
  return { ok: true, error: null };
}

/** ข้อมูลนิติบุคคลบนสลิป — ว่าง = กลับไปใช้ข้อมูลจากตั้งค่าใบเสร็จ */
export async function updateStorePayslipIdentity(input: {
  storeId: string;
  organizationId: string;
  legalName?: string;
  address?: string;
  taxId?: string;
}) {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.from("store_hr_settings").upsert(
    {
      store_id: input.storeId,
      organization_id: input.organizationId,
      payslip_legal_name: input.legalName ?? null,
      payslip_address: input.address ?? null,
      payslip_tax_id: input.taxId ?? null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "store_id" },
  );
  if (error) return { ok: false, error: mapError(error) };
  return { ok: true, error: null };
}

/** Update only the store's open weekdays; other HR settings keep their values/DB defaults. */
export async function updateStoreWorkingDays(
  storeId: string,
  organizationId: string,
  workingDays: number[],
) {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.from("store_hr_settings").upsert(
    {
      store_id: storeId,
      organization_id: organizationId,
      working_days: workingDays,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "store_id" },
  );
  if (error) return { ok: false, error: mapError(error) };
  return { ok: true, error: null };
}

export async function listPayrollAdjustments(storeId: string, dateFrom: string, dateTo: string) {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("payroll_adjustments")
    .select("*")
    .eq("store_id", storeId)
    .gte("date", dateFrom)
    .lte("date", dateTo)
    .order("date", { ascending: false });
  if (error) return { data: null, error: mapError(error) };
  return { data: (data ?? []).map(mapAdjustment), error: null };
}

export interface AddAdjustmentInput {
  storeId: string;
  organizationId: string;
  userId: string;
  employeeName: string;
  date: string;
  type: AdjustmentType;
  amount: number;
  note?: string;
  createdByUserId: string;
}

/** Dates a user has a 'leave' adjustment within a range (for the attendance calendar). */
export async function listLeaveDatesForUser(
  storeId: string,
  userId: string,
  from: string,
  to: string,
): Promise<string[]> {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase
    .from("payroll_adjustments")
    .select("date")
    .eq("store_id", storeId)
    .eq("user_id", userId)
    .eq("type", "leave")
    .gte("date", from)
    .lte("date", to);
  return (data ?? []).map((r) => r.date);
}

export async function addPayrollAdjustment(input: AddAdjustmentInput) {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.from("payroll_adjustments").insert({
    store_id: input.storeId,
    organization_id: input.organizationId,
    user_id: input.userId,
    employee_name: input.employeeName,
    date: input.date,
    type: input.type,
    amount: input.amount,
    note: input.note ?? null,
    created_by_user_id: input.createdByUserId,
  });
  if (error) return { ok: false, error: mapError(error) };
  return { ok: true, error: null };
}

export async function deletePayrollAdjustment(id: string, storeId: string, type?: AdjustmentType) {
  const supabase = await createSupabaseServerClient();
  let query = supabase
    .from("payroll_adjustments")
    .delete({ count: "exact" })
    .eq("id", id)
    .eq("store_id", storeId);
  if (type) query = query.eq("type", type);
  const { error, count } = await query;
  if (error) return { ok: false, error: mapError(error) };
  if (count === 0) return { ok: false, error: mapError(new Error("ไม่พบรายการที่ต้องลบ")) };
  return { ok: true, error: null };
}

/**
 * Create a staff auth user + an already-joined membership for a store.
 * Uses the service client (admin) — caller must enforce users.manage permission.
 */
export interface CreateStaffInput {
  organizationId: string;
  storeId: string;
  email: string;
  password: string;
  role: Database["public"]["Tables"]["memberships"]["Row"]["role"];
}

export async function createStaffMember(input: CreateStaffInput) {
  const service = await createSupabaseServiceClient();

  const { data: created, error: createErr } = await service.auth.admin.createUser({
    email: input.email,
    password: input.password,
    email_confirm: true,
  });
  if (createErr || !created.user) {
    return { ok: false, error: mapError(createErr ?? new Error("ไม่สามารถสร้างผู้ใช้ได้")) };
  }

  const now = new Date().toISOString();
  const { error: memberErr } = await service.from("memberships").insert({
    organization_id: input.organizationId,
    store_id: input.storeId,
    user_id: created.user.id,
    role: input.role,
    invited_at: now,
    joined_at: now,
  });
  if (memberErr) {
    // Roll back the orphaned auth user.
    await service.auth.admin.deleteUser(created.user.id).catch(() => {});
    return { ok: false, error: mapError(memberErr) };
  }

  return { ok: true, error: null, userId: created.user.id };
}

// ---------------------------------------------------------------------------
// วันที่ให้ OT (โหมด "เฉพาะวันที่กำหนด")
// ---------------------------------------------------------------------------
export function mapOtDay(row: OtDayRow): StoreOtDay {
  return {
    id: row.id,
    storeId: row.store_id,
    organizationId: row.organization_id,
    date: row.date,
    capHours: Number(row.cap_hours),
    multiplier: row.multiplier == null ? null : Number(row.multiplier),
    userIds: row.user_ids ?? [],
    note: row.note ?? undefined,
    updatedByUserId: row.updated_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function isMissingTable(error: { code?: string } | null): boolean {
  return !!error && (error.code === "42P01" || error.code === "PGRST205");
}

/**
 * วันให้ OT ในช่วง from–to · ตารางยังไม่ถูกสร้าง (โค้ดขึ้นก่อน migration) = ไม่มีวันให้ OT
 * error อื่นต้องไม่เงียบ — ไม่งั้นงวดที่ตั้ง OT ไว้จะคิดเงินขาด
 */
export async function listStoreOtDays(storeId: string, from: string, to: string): Promise<StoreOtDay[]> {
  const supabase = await createSupabaseServiceClient();
  const { data, error } = await supabase
    .from("store_ot_days")
    .select("*")
    .eq("store_id", storeId)
    .gte("date", from)
    .lte("date", to)
    .order("date", { ascending: true });
  if (error) {
    if (isMissingTable(error)) return [];
    throw new Error(`อ่านวันให้ OT ไม่สำเร็จ: ${error.message}`);
  }
  return (data ?? []).map(mapOtDay);
}

export async function getStoreOtDay(storeId: string, id: string): Promise<StoreOtDay | null> {
  const supabase = await createSupabaseServiceClient();
  const { data, error } = await supabase.from("store_ot_days").select("*").eq("store_id", storeId).eq("id", id).maybeSingle();
  if (error) throw new Error(`อ่านวันให้ OT ไม่สำเร็จ: ${error.message}`);
  return data ? mapOtDay(data) : null;
}

/** บันทึกวันให้ OT (หลายวันพร้อมกัน) — วันเดิมถูกแทนที่ · เรียกหลัง server action ตรวจสิทธิ์/กฎย้อนหลังแล้วเท่านั้น */
export async function upsertStoreOtDays(rows: {
  storeId: string;
  organizationId: string;
  date: string;
  capHours: number;
  multiplier: number | null;
  userIds: string[];
  note?: string;
  updatedByUserId: string;
}[]): Promise<{ error: string | null }> {
  if (rows.length === 0) return { error: null };
  const supabase = await createSupabaseServiceClient();
  const now = new Date().toISOString();
  const { error } = await supabase.from("store_ot_days").upsert(
    rows.map((r) => ({
      store_id: r.storeId,
      organization_id: r.organizationId,
      date: r.date,
      cap_hours: r.capHours,
      multiplier: r.multiplier,
      user_ids: r.userIds,
      note: r.note ?? null,
      updated_by_user_id: r.updatedByUserId,
      updated_at: now,
    })),
    { onConflict: "store_id,date" },
  );
  if (error) return { error: isMissingTable(error) ? "ยังไม่ได้เปิดใช้ตารางวันให้ OT (รอ migration)" : error.message };
  return { error: null };
}

export async function deleteStoreOtDay(storeId: string, id: string): Promise<{ error: string | null }> {
  const supabase = await createSupabaseServiceClient();
  const { error, count } = await supabase.from("store_ot_days").delete({ count: "exact" }).eq("store_id", storeId).eq("id", id);
  if (error) return { error: error.message };
  if (count === 0) return { error: "ไม่พบวันให้ OT ที่ต้องลบ (อาจถูกลบไปแล้ว)" };
  return { error: null };
}

/**
 * งวด/สัปดาห์ที่จ่ายเงินแล้วซึ่งทับช่วง from–to — ใช้ล็อกการเพิ่ม/แก้/ลบวันให้ OT
 * อ่านไม่ได้ (error อื่นที่ไม่ใช่ตารางยังไม่มี) = โยน error ให้ action ปฏิเสธ ไม่ปล่อยผ่านเงียบ ๆ
 */
export async function loadPaidLocks(
  storeId: string,
  from: string,
  to: string,
): Promise<{ periods: { periodStart: string; periodEnd: string; status: "closed" | "reopened" }[]; weeks: { userId: string; weekStart: string; weekEnd: string }[] }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ตารางเงินเดือนขั้นสูงยังไม่อยู่ใน database.types
  const db: any = await createSupabaseServiceClient();
  const [periodsRes, weeksRes] = await Promise.all([
    db.from("payroll_periods").select("period_start, period_end, status").eq("store_id", storeId).lte("period_start", to).gte("period_end", from),
    db.from("payroll_weekly_payouts").select("user_id, week_start, week_end").eq("store_id", storeId).lte("week_start", to).gte("week_end", from),
  ]);
  for (const r of [periodsRes, weeksRes]) {
    if (r.error && !isMissingTable(r.error)) throw new Error(`ตรวจงวดที่จ่ายแล้วไม่สำเร็จ: ${r.error.message}`);
  }
  return {
    periods: ((periodsRes.error ? [] : periodsRes.data ?? []) as { period_start: string; period_end: string; status: string }[]).map((p) => ({
      periodStart: p.period_start,
      periodEnd: p.period_end,
      status: p.status === "reopened" ? "reopened" : "closed",
    })),
    weeks: ((weeksRes.error ? [] : weeksRes.data ?? []) as { user_id: string; week_start: string; week_end: string }[]).map((w) => ({
      userId: w.user_id,
      weekStart: w.week_start,
      weekEnd: w.week_end,
    })),
  };
}
