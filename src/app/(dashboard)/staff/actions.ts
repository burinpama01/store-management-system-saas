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
  updateStorePayslipIdentity,
} from "@/modules/hr/repository";
import { parseEmployeeIdentity } from "@/modules/hr/employee-identity";
import { getStoreLocalDate } from "@/modules/attendance/date";
import { logSystemEvent } from "@/modules/system/event-log";
import { getAdvancedPayrollAccess } from "@/modules/hr/advanced/store-payroll";
import { recordPayRateChange, setEmployeeSkills, listStoreSkills } from "@/modules/hr/advanced/repository";
import { pushPayrollNotification, formatBaht } from "@/modules/hr/advanced/notify";
import { listEmployeeProfiles } from "@/modules/hr/repository";
import type { PayType, AdjustmentType } from "@/modules/hr/types";
import type { Role } from "@/modules/tenants/types";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const PAY_TYPES: PayType[] = ["monthly", "daily", "hourly"];
const ADJ_TYPES: AdjustmentType[] = ["penalty", "bonus", "leave", "absent", "late", "withholding_tax"];
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
    const { user, ctx } = await getStoreContext();

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

    const today = getStoreLocalDate(ctx.storeTimezone);
    const identityResult = parseEmployeeIdentity((key) => formData.get(key), { today });
    if (identityResult.error !== null) return { error: identityResult.error };
    const identity = identityResult.value;

    // เงินเดือนขั้นสูง (เฉพาะแพ็กที่มีสิทธิ์ + สวิตช์ที่เปิด — R32/R33)
    const access = await getAdvancedPayrollAccess(ctx.organizationId, ctx.storeId);
    const sw = access.settings.switches;
    const before = (await listEmployeeProfiles(ctx.storeId)).data?.find((p) => p.userId === userId);
    const advanced: { ssoEnabled?: boolean; withholdingTaxRate?: number; payFrequency?: "monthly" | "weekly" | "weekly_advance" } = {};
    if (sw.socialSecurity) advanced.ssoEnabled = formData.get("ssoEnabled") === "on";
    // รอบจ่ายรายสัปดาห์ — ตั้งได้เฉพาะเมื่อร้านเปิดสวิตช์ (ปิดสวิตช์ = คงค่าเดิม แต่ไม่มีผล)
    if (sw.weeklyPay && formData.has("payFrequency")) {
      const f = formData.get("payFrequency");
      advanced.payFrequency = f === "weekly" || f === "weekly_advance" ? f : "monthly";
    }
    if (sw.withholdingTax && access.settings.whtMode === "percent") {
      const rate = Math.round(parseFloat(String(formData.get("withholdingTaxRate") ?? "0")) * 100) / 100;
      if (!(rate >= 0 && rate <= 35)) return { error: "อัตราภาษีต้องอยู่ระหว่าง 0–35%" };
      advanced.withholdingTaxRate = rate;
    }
    const rateEffectiveRaw = String(formData.get("rateEffectiveFrom") ?? "").trim();
    if (rateEffectiveRaw && !DATE_RE.test(rateEffectiveRaw)) return { error: "วันที่มีผลของเรทไม่ถูกต้อง" };
    const rateChanged =
      !!before &&
      (before.payType !== payType ||
        before.monthlySalary !== monthlySalary ||
        before.dailyRate !== dailyRate ||
        before.hourlyRate !== hourlyRate);

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
      identity,
      advanced,
    });
    if (result.error) {
      if (result.error.code === "23505") return { error: "รหัสพนักงานนี้มีคนใช้แล้วในสาขานี้" };
      if (result.error.code === "23514") {
        return { error: "ข้อมูลขัดกัน: วันออกงานต้องไม่ก่อนวันเริ่มงาน (ตรวจวันเริ่มงานที่ระบบตั้งให้ด้วย) หรือข้อความยาวเกิน" };
      }
      return { error: result.error.userMessage };
    }

    // ประวัติเรท (R13): เปลี่ยนเรท + เลือกวันมีผล → งวดเก่าคิดเรทเดิม, กลางงวดคิดตามวันจริง (R29)
    if (access.entitled && rateChanged && before) {
      const rateResult = await recordPayRateChange({
        storeId: ctx.storeId,
        organizationId: ctx.organizationId,
        userId,
        previous: { payType: before.payType, monthlySalary: before.monthlySalary, dailyRate: before.dailyRate, hourlyRate: before.hourlyRate },
        next: { payType, monthlySalary, dailyRate, hourlyRate },
        effectiveFrom: rateEffectiveRaw || today,
        actorUserId: user.id,
      });
      if (rateResult.error) return { error: `บันทึกประวัติเรทไม่สำเร็จ: ${rateResult.error.userMessage}` };
    }

    // ทักษะ (R11): ติ๊กได้เลย มีผลงวดถัดไป
    let skillChanges: { granted: string[]; revoked: string[] } = { granted: [], revoked: [] };
    if (sw.skillPay && formData.get("skillsSubmitted") === "1") {
      const valid = new Set((await listStoreSkills(ctx.storeId)).map((s) => s.id));
      const skillIds = formData.getAll("skillIds").map(String).filter((id) => valid.has(id));
      const r = await setEmployeeSkills({
        storeId: ctx.storeId,
        organizationId: ctx.organizationId,
        userId,
        skillIds,
        today,
        actorUserId: user.id,
      });
      if (r.error) return { error: `บันทึกทักษะไม่สำเร็จ: ${r.error}` };
      skillChanges = r;
    }

    // แจ้งเตือนพนักงานรายคน (R31)
    if (sw.payrollNotifications) {
      const notes: { kind: string; key: string; title: string; message: string }[] = [];
      if (skillChanges.granted.length || skillChanges.revoked.length) {
        const names = new Map((await listStoreSkills(ctx.storeId)).map((s) => [s.id, s.name]));
        const g = skillChanges.granted.map((id) => names.get(id)).filter(Boolean).join(", ");
        const rv = skillChanges.revoked.map((id) => names.get(id)).filter(Boolean).join(", ");
        notes.push({
          kind: "skill_changed",
          key: `${userId}:${today}:${skillChanges.granted.join(",")}:${skillChanges.revoked.join(",")}`,
          title: "ทักษะของคุณเปลี่ยน",
          message: [g ? `ได้ทักษะ: ${g}` : "", rv ? `ถอนทักษะ: ${rv}` : "", "มีผลงวดถัดไป"].filter(Boolean).join(" · "),
        });
      }
      if (before && before.employmentType !== "permanent" && identity.employmentType === "permanent") {
        notes.push({
          kind: "became_permanent",
          key: `${userId}:${identity.permanentSince}`,
          title: "คุณเป็นพนักงานประจำแล้ว",
          message: "เริ่มได้ค่าทักษะ/ค่าอายุงาน/โบนัสยอดขาย ตามที่ร้านเปิดใช้ (เริ่มงวดถัดไป)",
        });
      }
      if (rateChanged && access.entitled) {
        const amount = payType === "monthly" ? monthlySalary : payType === "daily" ? dailyRate : hourlyRate;
        notes.push({
          kind: "pay_rate_changed",
          key: `${userId}:${rateEffectiveRaw || today}:${payType}:${amount}`,
          title: "ค่าจ้างของคุณมีการปรับ",
          message: `ค่าจ้างใหม่ ${formatBaht(amount)} มีผล ${rateEffectiveRaw || today}`,
        });
      }
      for (const n of notes) {
        await pushPayrollNotification({
          organizationId: ctx.organizationId,
          storeId: ctx.storeId,
          userIds: [userId],
          kind: n.kind,
          dedupeKey: n.key,
          title: n.title,
          message: n.message,
        });
      }
    }

    // ไม่บันทึกเลขบัญชี/ชื่อจริงลง log — บอกแค่ว่ามีหรือไม่มี
    await logSystemEvent({
      level: "info",
      source: "hr.employee-profile",
      action: "saveEmployeeProfileAction",
      message: "บันทึกข้อมูลพนักงานและค่าจ้าง",
      organizationId: ctx.organizationId,
      storeId: ctx.storeId,
      actorUserId: user.id,
      context: {
        employeeUserId: userId,
        payType,
        employmentType: identity.employmentType,
        permanentSince: identity.permanentSince ?? null,
        seniorityStartDate: identity.seniorityStartDate ?? null,
        employmentEndDate: identity.employmentEndDate ?? null,
        hasEmployeeCode: !!identity.employeeCode,
        hasBankAccount: !!identity.bankAccountNo,
        rateChanged,
        rateEffectiveFrom: rateChanged ? rateEffectiveRaw || today : null,
        skillsGranted: skillChanges.granted.length,
        skillsRevoked: skillChanges.revoked.length,
        payFrequency: advanced.payFrequency ?? null,
        payFrequencyChanged: advanced.payFrequency !== undefined && (before?.payFrequency ?? "monthly") !== advanced.payFrequency,
      },
    });

    revalidatePath("/staff", "page");
    revalidatePath("/payslip", "page");
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
    const halfDayMaxHours = num("halfDayMaxHours", 0, 24);
    const backdatedRaw = parseInt(String(formData.get("backdatedRightsPerMonth") ?? ""), 10);
    const backdatedRightsPerMonth = Number.isInteger(backdatedRaw) && backdatedRaw >= 0 && backdatedRaw <= 31 ? backdatedRaw : null;

    if (
      regularHoursPerDay === null || otMultiplier === null || otDailyCapHours === null ||
      latePenaltyPerMinute === null || latePenaltyMaxPerDay === null || absentPenaltyPerDay === null ||
      halfDayMaxHours === null || backdatedRightsPerMonth === null
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
      halfDayMaxHours,
      backdatedRightsPerMonth,
    });
    if (result.error) return { error: result.error.userMessage };

    revalidatePath("/staff", "page");
    return { error: null };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}

/** ข้อมูลนิติบุคคลบนสลิป (R30: ผู้จัดการ/เจ้าของเท่านั้น — attendance.manage) */
export async function savePayslipIdentityAction(formData: FormData): Promise<{ error: string | null }> {
  try {
    await requirePermission("attendance.manage");
    const { user, ctx } = await getStoreContext();
    const clean = (key: string, max: number) => {
      const v = String(formData.get(key) ?? "").replace(/\s+/g, " ").trim();
      return v ? v.slice(0, max) : undefined;
    };
    const legalName = clean("payslipLegalName", 200);
    const address = clean("payslipAddress", 400);
    const taxIdRaw = String(formData.get("payslipTaxId") ?? "").replace(/[\s-]/g, "");
    if (taxIdRaw && !/^\d{13}$/.test(taxIdRaw)) return { error: "เลขประจำตัวผู้เสียภาษีต้องเป็นตัวเลข 13 หลัก" };

    const result = await updateStorePayslipIdentity({
      storeId: ctx.storeId,
      organizationId: ctx.organizationId,
      legalName,
      address,
      taxId: taxIdRaw || undefined,
    });
    if (result.error) return { error: result.error.userMessage };

    await logSystemEvent({
      level: "info",
      source: "hr.payslip-identity",
      action: "savePayslipIdentityAction",
      message: "บันทึกข้อมูลนิติบุคคลบนสลิป",
      organizationId: ctx.organizationId,
      storeId: ctx.storeId,
      actorUserId: user.id,
      context: { hasLegalName: !!legalName, hasAddress: !!address, hasTaxId: !!taxIdRaw },
    });

    revalidatePath("/staff", "page");
    revalidatePath("/payslip", "page");
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
    if (type === "withholding_tax") {
      const access = await getAdvancedPayrollAccess(ctx.organizationId, ctx.storeId);
      if (!access.settings.switches.withholdingTax || access.settings.whtMode !== "manual") {
        return { error: "ต้องเปิดภาษีหัก ณ ที่จ่ายแบบกรอกเองก่อน" };
      }
    }
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
