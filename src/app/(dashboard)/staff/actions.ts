"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/modules/auth/guards";
import { getCurrentUser, getUserStores, resolveCurrentStore } from "@/modules/auth/session";
import {
  upsertEmployeeProfile,
  addPayrollAdjustment,
  deletePayrollAdjustment,
  createStaffMember,
  upsertStoreHrSettings,
} from "@/modules/hr/repository";
import type { PayType, AdjustmentType } from "@/modules/hr/types";
import type { Role } from "@/modules/tenants/types";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const PAY_TYPES: PayType[] = ["monthly", "daily", "hourly"];
const ADJ_TYPES: AdjustmentType[] = ["penalty", "bonus", "leave", "absent", "late"];
const ASSIGNABLE_ROLES: Role[] = ["admin", "manager", "cashier", "staff"];

async function getStoreContext() {
  const user = await getCurrentUser();
  if (!user) throw new Error("ไม่มีสิทธิ์เข้าถึง");
  const { organizations, stores, memberships } = await getUserStores();
  const ctx = await resolveCurrentStore(stores, organizations, memberships);
  if (!ctx) throw new Error("ไม่พบข้อมูลร้านค้า");
  return { user, ctx };
}

function money(raw: unknown): number | null {
  const n = Math.round(parseFloat(String(raw ?? "")) * 100) / 100;
  if (isNaN(n) || n < 0 || n > 10_000_000) return null;
  return n;
}

function intInRange(raw: unknown, min: number, max: number): number | null {
  const n = parseInt(String(raw ?? ""), 10);
  if (isNaN(n) || n < min || n > max) return null;
  return n;
}

export async function saveEmployeeProfileAction(formData: FormData): Promise<{ error: string | null }> {
  try {
    await requirePermission("attendance.manage");
    const { ctx } = await getStoreContext();

    const userId = String(formData.get("userId") ?? "");
    if (!UUID_RE.test(userId)) return { error: "พนักงานไม่ถูกต้อง" };

    const payType = String(formData.get("payType") ?? "") as PayType;
    if (!PAY_TYPES.includes(payType)) return { error: "ประเภทค่าจ้างไม่ถูกต้อง" };

    const displayName = (String(formData.get("displayName") ?? "")).trim().slice(0, 100) || undefined;
    const monthlySalary = money(formData.get("monthlySalary")) ?? 0;
    const dailyRate = money(formData.get("dailyRate")) ?? 0;
    const hourlyRate = money(formData.get("hourlyRate")) ?? 0;
    const latePenaltyAmount = money(formData.get("latePenaltyAmount")) ?? 0;
    const absentPenaltyAmount = money(formData.get("absentPenaltyAmount")) ?? 0;

    const graceRaw = String(formData.get("lateGraceMinutes") ?? "0").trim() || "0";
    const lateGraceMinutes = intInRange(graceRaw, 0, 240);
    if (lateGraceMinutes === null) return { error: "เวลาผ่อนผันไม่ถูกต้อง (0–240 นาที)" };

    const startRaw = String(formData.get("expectedStartTime") ?? "").trim();
    const expectedStartTime = startRaw ? (TIME_RE.test(startRaw) ? startRaw : null) : undefined;
    if (expectedStartTime === null) return { error: "เวลาเข้างานไม่ถูกต้อง (HH:MM)" };

    const workingDays = formData
      .getAll("workingDays")
      .map((d) => parseInt(String(d), 10))
      .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6);
    const otEligible = formData.get("otEligible") === "on";

    const result = await upsertEmployeeProfile({
      storeId: ctx.storeId,
      organizationId: ctx.organizationId,
      userId,
      displayName,
      payType,
      monthlySalary,
      dailyRate,
      hourlyRate,
      expectedStartTime,
      lateGraceMinutes,
      latePenaltyAmount,
      absentPenaltyAmount,
      workingDays: [...new Set(workingDays)].sort(),
      otEligible,
    });
    if (result.error) return { error: result.error.userMessage };

    revalidatePath("/staff", "page");
    return { error: null };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}

export async function saveHrSettingsAction(formData: FormData): Promise<{ error: string | null }> {
  try {
    await requirePermission("attendance.manage");
    const { ctx } = await getStoreContext();

    const num = (key: string, min: number, max: number): number | null => {
      const n = Math.round(parseFloat(String(formData.get(key) ?? "")) * 100) / 100;
      if (isNaN(n) || n < min || n > max) return null;
      return n;
    };

    const regularHoursPerDay = num("regularHoursPerDay", 1, 24);
    const otMultiplier = num("otMultiplier", 1, 5);
    const otDailyCapHours = num("otDailyCapHours", 0, 12);
    const latePenaltyPerMinute = num("latePenaltyPerMinute", 0, 10_000);
    const latePenaltyMaxPerDay = num("latePenaltyMaxPerDay", 0, 100_000);
    const absentPenaltyPerDay = num("absentPenaltyPerDay", 0, 100_000);
    const backdatedRaw = parseInt(String(formData.get("backdatedRightsPerMonth") ?? ""), 10);
    const backdatedRightsPerMonth = Number.isInteger(backdatedRaw) && backdatedRaw >= 0 && backdatedRaw <= 31 ? backdatedRaw : null;

    if (
      regularHoursPerDay === null || otMultiplier === null || otDailyCapHours === null ||
      latePenaltyPerMinute === null || latePenaltyMaxPerDay === null || absentPenaltyPerDay === null ||
      backdatedRightsPerMonth === null
    ) {
      return { error: "ค่าตั้งค่าไม่ถูกต้อง" };
    }

    const result = await upsertStoreHrSettings({
      storeId: ctx.storeId,
      organizationId: ctx.organizationId,
      regularHoursPerDay,
      otMultiplier,
      otDailyCapHours,
      latePenaltyPerMinute,
      latePenaltyMaxPerDay,
      absentPenaltyPerDay,
      backdatedRightsPerMonth,
    });
    if (result.error) return { error: result.error.userMessage };

    revalidatePath("/staff", "page");
    return { error: null };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}

export async function addStaffMemberAction(formData: FormData): Promise<{ error: string | null }> {
  try {
    await requirePermission("users.manage");
    const { ctx } = await getStoreContext();

    const email = String(formData.get("email") ?? "").trim().toLowerCase();
    const password = String(formData.get("password") ?? "");
    const role = String(formData.get("role") ?? "") as Role;

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: "อีเมลไม่ถูกต้อง" };
    if (password.length < 8 || password.length > 72) return { error: "รหัสผ่านต้องมี 8–72 ตัวอักษร" };
    if (!ASSIGNABLE_ROLES.includes(role)) return { error: "บทบาทไม่ถูกต้อง" };

    const result = await createStaffMember({
      organizationId: ctx.organizationId,
      storeId: ctx.storeId,
      email,
      password,
      role,
    });
    if (result.error) return { error: result.error.userMessage };

    revalidatePath("/staff", "page");
    return { error: null };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}

export async function addAdjustmentAction(formData: FormData): Promise<{ error: string | null }> {
  try {
    await requirePermission("attendance.manage");
    const { user, ctx } = await getStoreContext();

    const userId = String(formData.get("userId") ?? "");
    if (!UUID_RE.test(userId)) return { error: "พนักงานไม่ถูกต้อง" };
    const employeeName = String(formData.get("employeeName") ?? "").trim().slice(0, 100) || userId;
    const type = String(formData.get("type") ?? "") as AdjustmentType;
    if (!ADJ_TYPES.includes(type)) return { error: "ประเภทไม่ถูกต้อง" };
    const date = String(formData.get("date") ?? "").trim();
    if (!DATE_RE.test(date) || isNaN(Date.parse(date))) return { error: "วันที่ไม่ถูกต้อง" };
    const amount = money(formData.get("amount"));
    if (amount === null || amount <= 0) return { error: "จำนวนเงินไม่ถูกต้อง" };
    const note = (String(formData.get("note") ?? "")).trim().slice(0, 200) || undefined;

    const result = await addPayrollAdjustment({
      storeId: ctx.storeId,
      organizationId: ctx.organizationId,
      userId,
      employeeName,
      date,
      type,
      amount,
      note,
      createdByUserId: user.id,
    });
    if (result.error) return { error: result.error.userMessage };

    revalidatePath("/staff", "page");
    return { error: null };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}

export async function deleteAdjustmentAction(id: string): Promise<{ error: string | null }> {
  try {
    await requirePermission("attendance.manage");
    const { ctx } = await getStoreContext();
    if (!UUID_RE.test(id)) return { error: "รายการไม่ถูกต้อง" };
    const result = await deletePayrollAdjustment(id, ctx.storeId);
    if (result.error) return { error: result.error.userMessage };
    revalidatePath("/staff", "page");
    return { error: null };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}
