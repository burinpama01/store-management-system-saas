"use server";

import { revalidatePath } from "next/cache";
import { getResolvedCurrentPermissions } from "@/modules/auth/guards";
import { getOrganizationBillingState } from "@/modules/billing/billing-service";
import { DEFAULT_BILLING_STATE, getPlanFeatures } from "@/modules/billing/types";
import { canUseMemberPrivileges } from "@/modules/members/access";
import { isOpsManagerRole } from "@/modules/operations/access";
import {
  MAX_HOURS_EXCEPTIONS,
  PAUSE_PRESETS,
  PAUSE_PRESET_LABEL,
  addDays,
  hoursForDate,
  localDateOf,
  orderingHoursSchema,
  pauseUntilFor,
  type OrderingHours,
  type PausePreset,
} from "@/modules/online-orders/hours";
import { getOrderingSchedule, saveOrderingHours, setOrderingPause } from "@/modules/online-orders/repository";
import { getStoreWebsite } from "@/modules/store-website/repository";
import { logSystemEvent } from "@/modules/system/event-log";

type ActionResult = { ok: boolean; error: string | null };

/**
 * mode "staff" = ปิด/เปิดด่วน (พนักงานที่จัดการออเดอร์ออนไลน์ได้ — ไฟดับต้องกดได้ทันทีไม่ต้องรอเจ้าของ)
 * mode "manager" = ตั้งเวลาทำการ/วันพิเศษ (เจ้าของ/แอดมิน)
 */
async function guard(mode: "staff" | "manager") {
  const { user, ctx, resolved } = await getResolvedCurrentPermissions();
  if (mode === "manager" ? !isOpsManagerRole(resolved.role) : !resolved.can("orders.manage_qr")) {
    return { error: mode === "manager" ? "เฉพาะเจ้าของหรือแอดมินที่ตั้งเวลารับออเดอร์ได้" : "ไม่มีสิทธิ์จัดการออเดอร์ออนไลน์" } as const;
  }
  const billing = (await getOrganizationBillingState(ctx.organizationId)) ?? DEFAULT_BILLING_STATE;
  if (!canUseMemberPrivileges(billing) || !getPlanFeatures(billing).byoPaymentGateway) {
    return { error: "สั่งออนไลน์ใช้ได้เฉพาะแพ็กเกจ Enterprise" } as const;
  }
  return { user, ctx, timeZone: ctx.storeTimezone || "Asia/Bangkok", error: null } as const;
}

function log(level: "info" | "error", action: string, message: string, g: { user: { id: string }; ctx: { organizationId: string; storeId: string } }, context?: Record<string, unknown>) {
  void logSystemEvent({
    level,
    source: "online-orders",
    action,
    message,
    organizationId: g.ctx.organizationId,
    storeId: g.ctx.storeId,
    actorUserId: g.user.id,
    context,
  });
}

async function revalidateOrdering(storeId: string) {
  const site = await getStoreWebsite(storeId).catch(() => null);
  if (site?.slug) revalidatePath(`/s/${site.slug}/order`);
  revalidatePath("/website/orders");
}

/** วันพิเศษที่ผ่านไปแล้ว (ก่อนเมื่อวาน) ตัดทิ้งอัตโนมัติ — กันรายการเต็ม 60 */
function pruneOldExceptions(hours: OrderingHours, today: string): OrderingHours {
  const keepFrom = addDays(today, -1);
  return { ...hours, exceptions: hours.exceptions.filter((e) => e.date >= keepFrom).sort((a, b) => a.date.localeCompare(b.date)) };
}

export async function saveOrderingHoursAction(raw: unknown): Promise<ActionResult> {
  try {
    const g = await guard("manager");
    if (g.error !== null) return { ok: false, error: g.error };
    const parsed = orderingHoursSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "เวลาไม่ถูกต้อง" };
    const hours = pruneOldExceptions(parsed.data, localDateOf(new Date(), g.timeZone));
    if (hours.enabled && hours.weekly.every((d) => d.closed) && !hours.exceptions.some((e) => !e.closed)) {
      return { ok: false, error: "ตั้งหยุดทุกวัน ลูกค้าจะสั่งไม่ได้เลย — ถ้าจะหยุดรับชั่วคราวให้กด “ปิดรับด่วน” หรือปิดสวิตช์สั่งออนไลน์แทน" };
    }
    const error = await saveOrderingHours({ storeId: g.ctx.storeId, organizationId: g.ctx.organizationId, hours, userId: g.user.id });
    log(error ? "error" : "info", "saveOrderingHours", error ? `บันทึกเวลารับออเดอร์ไม่สำเร็จ: ${error}` : `ตั้งเวลารับออเดอร์ (${hours.enabled ? "ใช้เวลาทำการ" : "เปิดตลอด"})`, g, {
      enabled: hours.enabled,
      closedDays: hours.weekly.map((d, i) => (d.closed ? i : null)).filter((i) => i !== null),
      exceptions: hours.exceptions.length,
    });
    if (error) return { ok: false, error: "บันทึกไม่สำเร็จ" };
    await revalidateOrdering(g.ctx.storeId);
    return { ok: true, error: null };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "บันทึกไม่สำเร็จ" };
  }
}

/** "HH:00" ของชั่วโมงปัจจุบันตามเวลาร้าน — วันหยุดประจำที่มา OT ให้เริ่มรับตั้งแต่ตอนกด ไม่ย้อนไปเที่ยงคืน */
function currentHourIn(timeZone: string): string {
  const h = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", hourCycle: "h23" }).format(new Date());
  return `${h.padStart(2, "0")}:00`;
}

/** ปุ่มลัด: วันนี้เปิดถึงเวลา X (เช่น OT ถึงเที่ยงคืน) — เขียนเป็นวันพิเศษของวันนี้ และเปิดใช้เวลาทำการให้ถ้ายังไม่เปิด */
export async function extendTodayAction(closeTime: string): Promise<ActionResult> {
  try {
    const g = await guard("manager");
    if (g.error !== null) return { ok: false, error: g.error };
    if (!/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(closeTime)) return { ok: false, error: "เวลาไม่ถูกต้อง" };
    const today = localDateOf(new Date(), g.timeZone);
    const schedule = await getOrderingSchedule(g.ctx.storeId);
    const base = hoursForDate(schedule.hours, today);
    const hours = pruneOldExceptions(
      {
        ...schedule.hours,
        exceptions: [
          ...schedule.hours.exceptions.filter((e) => e.date !== today),
          { date: today, closed: false, open: base.closed ? currentHourIn(g.timeZone) : base.open, close: closeTime, note: closeTime === "00:00" ? "เปิดถึงเที่ยงคืน" : `เปิดถึง ${closeTime}` },
        ],
      },
      today,
    );
    if (hours.exceptions.length > MAX_HOURS_EXCEPTIONS) return { ok: false, error: "วันพิเศษเต็มแล้ว ลบรายการเก่าก่อน" };
    // ไม่ใช้เวลาทำการ = เปิดตลอดอยู่แล้ว ไม่ต้องเปิดเวลาทำการเพื่อขยายวันนี้ (จะทำให้วันอื่นปิดตามเวลาตั้งต้นโดยไม่ตั้งใจ)
    if (!schedule.hours.enabled) return { ok: false, error: "ตอนนี้เปิดรับตลอดอยู่แล้ว (ยังไม่ได้ตั้งเวลาทำการ)" };
    const error = await saveOrderingHours({ storeId: g.ctx.storeId, organizationId: g.ctx.organizationId, hours, userId: g.user.id });
    log(error ? "error" : "info", "extendTodayHours", error ? `ขยายเวลาวันนี้ไม่สำเร็จ: ${error}` : `ขยายเวลารับออเดอร์วันนี้ถึง ${closeTime}`, g, { date: today, closeTime });
    if (error) return { ok: false, error: "บันทึกไม่สำเร็จ" };
    await revalidateOrdering(g.ctx.storeId);
    return { ok: true, error: null };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "บันทึกไม่สำเร็จ" };
  }
}

export async function pauseOrderingAction(preset: PausePreset, rawReason: string): Promise<ActionResult> {
  try {
    const g = await guard("staff");
    if (g.error !== null) return { ok: false, error: g.error };
    if (!PAUSE_PRESETS.includes(preset)) return { ok: false, error: "เลือกระยะเวลาปิดรับ" };
    const reason = String(rawReason ?? "").trim().slice(0, 120) || null;
    const schedule = await getOrderingSchedule(g.ctx.storeId);
    const until = pauseUntilFor(preset, schedule, new Date(), g.timeZone);
    const error = await setOrderingPause({ storeId: g.ctx.storeId, organizationId: g.ctx.organizationId, until, reason, userId: g.user.id });
    log(error ? "error" : "info", "pauseOrdering", error ? `ปิดรับออเดอร์ด่วนไม่สำเร็จ: ${error}` : `ปิดรับออเดอร์ด่วน ${PAUSE_PRESET_LABEL[preset]}${reason ? ` (${reason})` : ""}`, g, {
      preset,
      until,
      reason,
    });
    if (error) return { ok: false, error: "บันทึกไม่สำเร็จ" };
    await revalidateOrdering(g.ctx.storeId);
    return { ok: true, error: null };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "บันทึกไม่สำเร็จ" };
  }
}

export async function resumeOrderingAction(): Promise<ActionResult> {
  try {
    const g = await guard("staff");
    if (g.error !== null) return { ok: false, error: g.error };
    const error = await setOrderingPause({ storeId: g.ctx.storeId, organizationId: g.ctx.organizationId, until: null, reason: null, userId: g.user.id });
    log(error ? "error" : "info", "resumeOrdering", error ? `เปิดรับออเดอร์กลับไม่สำเร็จ: ${error}` : "เปิดรับออเดอร์กลับ (ยกเลิกปิดด่วน)", g);
    if (error) return { ok: false, error: "บันทึกไม่สำเร็จ" };
    await revalidateOrdering(g.ctx.storeId);
    return { ok: true, error: null };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "บันทึกไม่สำเร็จ" };
  }
}
