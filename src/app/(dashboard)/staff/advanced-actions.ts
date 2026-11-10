"use server";

/**
 * เงินเดือนขั้นสูง (แผนสลิป v4 · P2–P6) — ทุก action:
 *   1) requirePermission("attendance.manage") = ผู้จัดการหรือเจ้าของ (R30)
 *   2) แพ็กต้องมี advancedPayroll (R33) — ไม่มีสิทธิ์ = เปิดสวิตช์/ปิดงวดไม่ได้
 *   3) log ลง system_event_logs
 */
import { revalidatePath } from "next/cache";
import { requirePermission } from "@/modules/auth/guards";
import { listStoreMemberships } from "@/modules/settings/repository";
import { getCurrentUser, getUserStores, resolveCurrentStore } from "@/modules/auth/session";
import { getStoreLocalDate } from "@/modules/attendance/date";
import { logSystemEvent } from "@/modules/system/event-log";
import {
  PAYROLL_FEATURE_KEYS,
  PAYROLL_FEATURE_LABEL,
  SALES_CHANNELS,
  normalizeSwitches,
  parseTiers,
  type AdvancedPayrollSettings,
  type PayrollFeatureSwitches,
  type SalesChannel,
} from "@/modules/hr/advanced/settings";
import {
  addStoreSkill,
  archiveStoreSkill,
  getPayrollPeriod,
  listStoreSkills,
  reopenPayrollPeriod,
  saveAdvancedPayrollSettings,
} from "@/modules/hr/advanced/repository";
import { getAdvancedPayrollAccess } from "@/modules/hr/advanced/store-payroll";
import { closePayrollPeriodForStore } from "@/modules/hr/advanced/close-period";
import { businessDate, isPeriodDue, periodContaining } from "@/modules/hr/advanced/pay-cycle";
import { listStoreManagerUserIds, pushPayrollNotification } from "@/modules/hr/advanced/notify";
import { createSupabaseServiceClient } from "@/server/integrations/supabase/server";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const LOCKED = "ฟีเจอร์นี้มีในแพ็ก Enterprise หรือซื้อ \"เงินเดือนขั้นสูง\" เพิ่มในแพ็ก Business";

async function context() {
  await requirePermission("attendance.manage");
  const user = await getCurrentUser();
  if (!user) throw new Error("ไม่มีสิทธิ์เข้าถึง");
  const { organizations, stores, memberships } = await getUserStores();
  const ctx = await resolveCurrentStore(stores, organizations, memberships, user.id);
  if (!ctx) throw new Error("ไม่พบข้อมูลร้านค้า");
  const access = await getAdvancedPayrollAccess(ctx.organizationId, ctx.storeId);
  return { user, ctx, access };
}

function done() {
  revalidatePath("/staff", "page");
  revalidatePath("/payslip", "page");
  revalidatePath("/my-payslips", "page");
  revalidatePath("/pos", "page");
  revalidatePath("/attendance", "page");
}

function num(raw: FormDataEntryValue | null, min: number, max: number): number | null {
  const n = Math.round(parseFloat(String(raw ?? "").replace(/,/g, "")) * 100) / 100;
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}

export async function saveAdvancedPayrollSettingsAction(formData: FormData): Promise<{ error: string | null }> {
  try {
    const { user, ctx, access } = await context();
    if (!access.entitled) return { error: LOCKED };

    const switches = normalizeSwitches(
      Object.fromEntries(PAYROLL_FEATURE_KEYS.map((k) => [k, formData.get(`feat_${k}`) === "on"])) as Partial<PayrollFeatureSwitches>,
    );
    const startDay = num(formData.get("payCycleStartDay"), 1, 28);
    const payDay = num(formData.get("payDay"), 0, 31);
    const recordBonus = num(formData.get("salesRecordBonus"), 0, 1_000_000);
    const baseline = num(formData.get("salesRecordBaseline") || "0", 0, 100_000_000);
    const ssoRate = num(formData.get("ssoRate"), 0, 20);
    const ssoFloor = num(formData.get("ssoWageFloor"), 0, 1_000_000);
    const ssoCeiling = num(formData.get("ssoWageCeiling"), 0, 1_000_000);
    if ([startDay, payDay, recordBonus, baseline, ssoRate, ssoFloor, ssoCeiling].some((v) => v === null)) {
      return { error: "ค่าตั้งค่าไม่ถูกต้อง ตรวจตัวเลขอีกครั้ง" };
    }
    if ((ssoCeiling as number) < (ssoFloor as number)) return { error: "ฐานประกันสังคมสูงสุดต้องไม่ต่ำกว่าฐานต่ำสุด" };

    const lateRaw = String(formData.get("salesBonusLateMaxMinutes") ?? "").trim();
    const lateMax = lateRaw === "" ? null : num(lateRaw, 0, 600);
    if (lateRaw !== "" && lateMax === null) return { error: "เกณฑ์มาสายต้องเป็น 0–600 นาที (ว่าง = ไม่มีผล)" };

    const channels = formData
      .getAll("salesBonusChannels")
      .map(String)
      .filter((c): c is SalesChannel => (SALES_CHANNELS as string[]).includes(c));
    if ((switches.salesBonus || switches.monthlySalesBonus) && channels.length === 0) return { error: "เลือกช่องทางยอดขายอย่างน้อย 1 ช่องทาง" };

    const skillTiers = parseTiers(String(formData.get("skillTiers") ?? ""), "count", { maxKey: 50, maxAmount: 1_000_000 });
    const seniorityTiers = parseTiers(String(formData.get("seniorityTiers") ?? ""), "months", { maxKey: 600, maxAmount: 1_000_000 });
    const salesBonusTiers = parseTiers(String(formData.get("salesBonusTiers") ?? ""), "minSales", { maxKey: 100_000_000, maxAmount: 1_000_000 });
    if (switches.skillPay && skillTiers.length === 0) return { error: "ใส่ขั้นค่าทักษะอย่างน้อย 1 ขั้น เช่น 1=500, 2=1000" };
    if (switches.seniorityPay && seniorityTiers.length === 0) return { error: "ใส่ขั้นอายุงานอย่างน้อย 1 ขั้น เช่น 6=300, 12=600" };
    if (switches.salesBonus && salesBonusTiers.length === 0) return { error: "ใส่ขั้นโบนัสยอดขายอย่างน้อย 1 ขั้น เช่น 30000=100" };
    const monthlyBonusTiers = parseTiers(String(formData.get("monthlyBonusTiers") ?? ""), "minSales", { maxKey: 1_000_000_000, maxAmount: 10_000_000 });
    if (switches.monthlySalesBonus && monthlyBonusTiers.length === 0) return { error: "ใส่ขั้นโบนัสรายเดือนอย่างน้อย 1 ขั้น เช่น 900000=1000" };
    const salesBonusMode = formData.get("salesBonusMode") === "split" ? "split" : "per_person";
    const monthlyBonusMode = formData.get("monthlyBonusMode") === "split" ? "split" : "per_person";

    // รายชื่อผู้ร่วมโบนัส: เลือกเอง = ต้องเป็นพนักงานของสาขานี้เท่านั้น · ไม่เลือก = พนักงานประจำทุกคน (แบบเดิม)
    let salesBonusUserIds: string[] | null = null;
    if (formData.get("salesBonusPickEmployees") === "on") {
      const picked = [...new Set(formData.getAll("salesBonusUserIds").map(String))];
      const { data: storeMembers } = await listStoreMemberships(ctx.organizationId, ctx.storeId);
      const allowed = new Set((storeMembers ?? []).filter((m) => m.role !== "super_admin").map((m) => m.userId));
      salesBonusUserIds = picked.filter((id) => allowed.has(id));
      if ((switches.salesBonus || switches.monthlySalesBonus) && salesBonusUserIds.length === 0) {
        return { error: "เลือกพนักงานที่ร่วมโบนัสยอดขายอย่างน้อย 1 คน (หรือเอาติ๊ก \"เลือกพนักงานเอง\" ออก)" };
      }
      // โบนัสปิดอยู่และไม่ได้เลือกใคร = กลับไปใช้ค่าเริ่มต้น (พนักงานประจำ) ไม่เก็บรายชื่อว่าง
      if (salesBonusUserIds.length === 0) salesBonusUserIds = null;
    }

    const settings: AdvancedPayrollSettings = {
      switches,
      payCycleStartDay: startDay as number,
      payDay: payDay as number,
      skillTiers,
      seniorityTiers,
      salesBonusTiers,
      salesBonusChannels: channels.length ? channels : access.stored.salesBonusChannels,
      salesBonusLateMaxMinutes: lateMax,
      salesRecordBonus: recordBonus as number,
      salesRecordMode: formData.get("salesRecordMode") === "stack" ? "stack" : "replace",
      salesRecordBaseline: baseline as number,
      salesBonusMode,
      salesBonusUserIds,
      monthlyBonusTiers: monthlyBonusTiers.length ? monthlyBonusTiers : access.stored.monthlyBonusTiers,
      monthlyBonusMode,
      ssoRate: ssoRate as number,
      ssoWageFloor: ssoFloor as number,
      ssoWageCeiling: ssoCeiling as number,
      whtMode: formData.get("whtMode") === "percent" ? "percent" : "manual",
      // เปิดรอบเงินเดือนครั้งใหม่ = นับจากวันนี้ (cron ไม่ย้อนปิดงวดที่จบก่อนเปิดใช้)
      payCycleEnabledAt: switches.payCycle
        ? access.stored.switches.payCycle && access.stored.payCycleEnabledAt
          ? access.stored.payCycleEnabledAt
          : getStoreLocalDate(ctx.storeTimezone)
        : null,
    };
    const result = await saveAdvancedPayrollSettings(ctx.storeId, ctx.organizationId, settings);
    if (result.error) return { error: result.error.userMessage };

    const changed = PAYROLL_FEATURE_KEYS.filter((k) => access.stored.switches[k] !== switches[k]);
    await logSystemEvent({
      level: "info",
      source: "hr.advanced-payroll",
      action: "saveAdvancedPayrollSettingsAction",
      message: changed.length
        ? `เปลี่ยนสวิตช์เงินเดือน: ${changed.map((k) => `${PAYROLL_FEATURE_LABEL[k]} ${switches[k] ? "เปิด" : "ปิด"}`).join(", ")}`
        : "บันทึกตั้งค่าเงินเดือนขั้นสูง",
      organizationId: ctx.organizationId,
      storeId: ctx.storeId,
      actorUserId: user.id,
      context: {
        switches,
        payCycleStartDay: settings.payCycleStartDay,
        payDay: settings.payDay,
        whtMode: settings.whtMode,
        salesBonusMode,
        monthlyBonusMode,
        salesBonusSelectedCount: salesBonusUserIds?.length ?? null,
      },
    });
    done();
    return { error: null };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}

export async function addStoreSkillAction(formData: FormData): Promise<{ error: string | null }> {
  try {
    const { user, ctx, access } = await context();
    if (!access.entitled) return { error: LOCKED };
    const name = String(formData.get("name") ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
    if (!name) return { error: "ใส่ชื่อทักษะ" };
    const existing = await listStoreSkills(ctx.storeId);
    if (existing.some((s) => s.name === name)) return { error: "มีทักษะนี้แล้ว" };
    const r = await addStoreSkill(ctx.storeId, ctx.organizationId, name, existing.length);
    if (r.error) return { error: r.error.userMessage };
    await logSystemEvent({
      level: "info",
      source: "hr.advanced-payroll",
      action: "addStoreSkillAction",
      message: `เพิ่มทักษะ "${name}"`,
      organizationId: ctx.organizationId,
      storeId: ctx.storeId,
      actorUserId: user.id,
    });
    done();
    return { error: null };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}

export async function archiveStoreSkillAction(skillId: string): Promise<{ error: string | null }> {
  try {
    const { user, ctx, access } = await context();
    if (!access.entitled) return { error: LOCKED };
    if (!UUID_RE.test(skillId)) return { error: "ทักษะไม่ถูกต้อง" };
    const r = await archiveStoreSkill(ctx.storeId, skillId, getStoreLocalDate(ctx.storeTimezone));
    if (r.error) return { error: r.error.userMessage };
    await logSystemEvent({
      level: "info",
      source: "hr.advanced-payroll",
      action: "archiveStoreSkillAction",
      message: "เลิกใช้ทักษะ (ถอนจากพนักงานทุกคน ณ วันนี้ มีผลงวดถัดไป)",
      organizationId: ctx.organizationId,
      storeId: ctx.storeId,
      actorUserId: user.id,
      context: { skillId },
    });
    done();
    return { error: null };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}

/** ปิดงวดเอง (งวดที่จบแล้ว ยังไม่ปิด หรือปิดซ้ำหลังเปิดงวดแก้) */
export async function closePayrollPeriodAction(periodStart: string): Promise<{ error: string | null }> {
  try {
    const { user, ctx, access } = await context();
    if (!access.entitled || !access.settings.switches.payCycle) return { error: "ต้องเปิด \"รอบเงินเดือน + ปิดงวดอัตโนมัติ\" ก่อน" };
    if (!DATE_RE.test(periodStart)) return { error: "งวดไม่ถูกต้อง" };
    const s = access.settings;
    const period = periodContaining(periodStart, s.payCycleStartDay, s.payDay);
    if (period.start !== periodStart) return { error: "วันเริ่มงวดไม่ตรงกับรอบที่ตั้งไว้" };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- อ่านเวลาปิดร้าน
    const db: any = await createSupabaseServiceClient();
    const { data: store } = await db.from("stores").select("timezone, closing_time").eq("id", ctx.storeId).maybeSingle();
    const today = businessDate(new Date(), store?.timezone ?? ctx.storeTimezone, store?.closing_time ?? null);
    if (!isPeriodDue(period, today)) return { error: "งวดนี้ยังไม่จบ ปิดได้หลังเวลาปิดร้านของวันสุดท้ายในงวด" };
    const existing = await getPayrollPeriod(ctx.storeId, period.start);
    if (existing?.status === "closed") return { error: "งวดนี้ปิดแล้ว — ต้องกด \"เปิดงวดแก้ไข\" ก่อน" };

    const r = await closePayrollPeriodForStore({
      organizationId: ctx.organizationId,
      storeId: ctx.storeId,
      period,
      today,
      closedBy: user.id,
    });
    if (!r.ok) return { error: r.error ?? "ปิดงวดไม่สำเร็จ" };
    done();
    return { error: null };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}

/** เปิดงวดแก้ไข (R24) — สลิปเดิมยังอยู่จนปิดใหม่ แล้วจึงถูกแทน (เก็บประวัติ) · แจ้งเจ้าของเสมอ */
export async function reopenPayrollPeriodAction(periodId: string): Promise<{ error: string | null }> {
  try {
    const { user, ctx, access } = await context();
    if (!access.entitled) return { error: LOCKED };
    if (!UUID_RE.test(periodId)) return { error: "งวดไม่ถูกต้อง" };
    const r = await reopenPayrollPeriod(ctx.storeId, periodId, user.id);
    if (r.error) return { error: r.error.userMessage };
    await logSystemEvent({
      level: "warn",
      source: "hr.payroll-period",
      action: "reopenPayrollPeriodAction",
      message: "เปิดงวดเงินเดือนเพื่อแก้ไข",
      organizationId: ctx.organizationId,
      storeId: ctx.storeId,
      actorUserId: user.id,
      context: { periodId },
    });
    if (access.settings.switches.payrollNotifications) {
      await pushPayrollNotification({
        organizationId: ctx.organizationId,
        storeId: ctx.storeId,
        userIds: await listStoreManagerUserIds(ctx.organizationId, ctx.storeId),
        kind: "period_reopened",
        dedupeKey: `${periodId}:${Date.now()}`,
        title: "มีการเปิดงวดเงินเดือนเพื่อแก้ไข",
        message: `${user.email ?? "ผู้จัดการ"} เปิดงวดเพื่อแก้ไข — สลิปจะถูกแทนเมื่อปิดงวดใหม่`,
      });
    }
    done();
    return { error: null };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}
