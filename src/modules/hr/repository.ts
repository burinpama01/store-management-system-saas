import {
  createSupabaseServerClient,
  createSupabaseServiceClient,
} from "@/server/integrations/supabase/server";
import { mapError } from "@/shared/utils/error";
import type {
  EmployeeProfile,
  PayrollAdjustment,
  PayType,
  AdjustmentType,
  StoreHrSettings,
} from "./types";
import { DEFAULT_HR_SETTINGS } from "./types";
import type { Database } from "@/server/integrations/supabase/database.types";

type ProfileRow = Database["public"]["Tables"]["employee_profiles"]["Row"];
type AdjustmentRow = Database["public"]["Tables"]["payroll_adjustments"]["Row"];
type HrSettingsRow = Database["public"]["Tables"]["store_hr_settings"]["Row"];

function mapProfile(row: ProfileRow): EmployeeProfile {
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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapHrSettings(row: HrSettingsRow): StoreHrSettings {
  return {
    storeId: row.store_id,
    organizationId: row.organization_id,
    regularHoursPerDay: row.regular_hours_per_day,
    otMultiplier: row.ot_multiplier,
    otDailyCapHours: row.ot_daily_cap_hours,
    latePenaltyPerMinute: row.late_penalty_per_minute,
    latePenaltyMaxPerDay: row.late_penalty_max_per_day,
    absentPenaltyPerDay: row.absent_penalty_per_day,
    backdatedRightsPerMonth: row.backdated_rights_per_month,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapAdjustment(row: AdjustmentRow): PayrollAdjustment {
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
  latePenaltyPerMinute: number;
  latePenaltyMaxPerDay: number;
  absentPenaltyPerDay: number;
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
      late_penalty_per_minute: input.latePenaltyPerMinute,
      late_penalty_max_per_day: input.latePenaltyMaxPerDay,
      absent_penalty_per_day: input.absentPenaltyPerDay,
      backdated_rights_per_month: input.backdatedRightsPerMonth,
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

export async function deletePayrollAdjustment(id: string, storeId: string) {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase
    .from("payroll_adjustments")
    .delete()
    .eq("id", id)
    .eq("store_id", storeId);
  if (error) return { ok: false, error: mapError(error) };
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
