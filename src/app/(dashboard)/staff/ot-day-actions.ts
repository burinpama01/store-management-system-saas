"use server";

/**
 * วันให้ OT (โหมด "เฉพาะวันที่กำหนด") — เพิ่ม/แก้ (เพิ่มวันเดิมซ้ำ = แทนที่) / ลบ
 * กฎ: ผู้จัดการ (attendance.manage) · ย้อนหลังได้ไม่เกิน 7 วันตามเวลาร้าน · งวด/สัปดาห์ที่จ่ายเงินแล้วแตะไม่ได้
 * เขียนผ่าน service client หลังตรวจทุกข้อที่นี่ (RLS ของตารางเปิดแค่อ่าน)
 */
import { revalidatePath } from "next/cache";
import { requirePermission } from "@/modules/auth/guards";
import { getCurrentUser, getUserStores, resolveCurrentStore } from "@/modules/auth/session";
import { getStoreLocalDate } from "@/modules/attendance/date";
import { logSystemEvent } from "@/modules/system/event-log";
import { listStoreMemberships } from "@/modules/settings/repository";
import {
  deleteStoreOtDay,
  getStoreOtDay,
  listStoreOtDays,
  loadPaidLocks,
  upsertStoreOtDays,
} from "@/modules/hr/repository";
import { findPaidLock, validateOtDayInput } from "@/modules/hr/ot-days";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function getStoreContext() {
  const user = await getCurrentUser();
  if (!user) throw new Error("ไม่มีสิทธิ์เข้าถึง");
  const { organizations, stores, memberships } = await getUserStores();
  const ctx = await resolveCurrentStore(stores, organizations, memberships);
  if (!ctx) throw new Error("ไม่พบข้อมูลร้านค้า");
  return { user, ctx };
}

function revalidatePayroll() {
  revalidatePath("/staff", "page");
  revalidatePath("/payslip", "page");
  revalidatePath("/attendance", "page");
}

export async function saveOtDaysAction(formData: FormData): Promise<{ error: string | null; saved?: number }> {
  let storeId: string | null = null;
  let organizationId: string | null = null;
  try {
    await requirePermission("attendance.manage");
    const { user, ctx } = await getStoreContext();
    storeId = ctx.storeId;
    organizationId = ctx.organizationId;

    const today = getStoreLocalDate(ctx.storeTimezone);
    const membersRes = await listStoreMemberships(ctx.organizationId, ctx.storeId);
    const roster = new Set((membersRes.data ?? []).filter((m) => m.role !== "super_admin").map((m) => m.userId));
    const multiplierRaw = String(formData.get("multiplier") ?? "").trim();
    const parsed = validateOtDayInput({
      from: String(formData.get("dateFrom") ?? "").trim(),
      to: String(formData.get("dateTo") ?? "").trim(),
      capHours: parseFloat(String(formData.get("capHours") ?? "")),
      multiplier: multiplierRaw ? parseFloat(multiplierRaw) : null,
      userIds: formData.getAll("userIds").map(String).filter((id) => UUID_RE.test(id)),
      note: String(formData.get("note") ?? ""),
      today,
      rosterUserIds: roster,
    });
    if (!parsed.ok) return { error: parsed.error };
    const { draft } = parsed;
    const first = draft.dates[0];
    const last = draft.dates[draft.dates.length - 1];

    // วันที่มีอยู่แล้ว (จะถูกแทนที่) — รายชื่อเดิมก็ต้องผ่านล็อกด้วย ไม่งั้นแก้วันในสัปดาห์ที่จ่ายแล้วของคนเดิมได้
    const existing = await listStoreOtDays(ctx.storeId, first, last);
    const lockUsers = [...new Set([...draft.userIds, ...existing.flatMap((d) => d.userIds)])];
    const locks = await loadPaidLocks(ctx.storeId, first, last);
    const lock = findPaidLock(draft.dates, lockUsers, locks.periods, locks.weeks);
    if (lock) return { error: `${lock.date}: ${lock.reason}` };

    const result = await upsertStoreOtDays(
      draft.dates.map((date) => ({
        storeId: ctx.storeId,
        organizationId: ctx.organizationId,
        date,
        capHours: draft.capHours,
        multiplier: draft.multiplier,
        userIds: draft.userIds,
        note: draft.note,
        updatedByUserId: user.id,
      })),
    );
    if (result.error) {
      await logSystemEvent({
        level: "error",
        source: "hr.ot-days",
        action: "saveOtDays",
        message: `บันทึกวันให้ OT ไม่สำเร็จ: ${result.error}`,
        organizationId: ctx.organizationId,
        storeId: ctx.storeId,
        actorUserId: user.id,
        context: { dates: draft.dates },
      });
      return { error: result.error };
    }

    const backdated = draft.dates.filter((d) => d < today);
    await logSystemEvent({
      level: "info",
      source: "hr.ot-days",
      action: backdated.length > 0 ? "otDayBackdated" : "otDaysSaved",
      message:
        `ให้ OT ${draft.dates.length} วัน (${first}${last !== first ? ` ถึง ${last}` : ""}) สูงสุด ${draft.capHours} ชม./วัน` +
        (draft.multiplier ? ` ×${draft.multiplier}` : "") +
        ` · ${draft.userIds.length} คน` +
        (backdated.length > 0 ? ` · ย้อนหลัง ${backdated.length} วัน` : ""),
      organizationId: ctx.organizationId,
      storeId: ctx.storeId,
      actorUserId: user.id,
      context: {
        dates: draft.dates,
        backdatedDates: backdated,
        replacedDates: existing.map((d) => d.date),
        capHours: draft.capHours,
        multiplier: draft.multiplier,
        userIds: draft.userIds,
        today,
      },
    });
    revalidatePayroll();
    return { error: null, saved: draft.dates.length };
  } catch (e) {
    await logSystemEvent({
      level: "error",
      source: "hr.ot-days",
      action: "saveOtDays",
      message: e instanceof Error ? e.message : "บันทึกวันให้ OT ไม่สำเร็จ",
      organizationId,
      storeId,
    });
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}

export async function deleteOtDayAction(id: string): Promise<{ error: string | null }> {
  let storeId: string | null = null;
  let organizationId: string | null = null;
  try {
    await requirePermission("attendance.manage");
    const { user, ctx } = await getStoreContext();
    storeId = ctx.storeId;
    organizationId = ctx.organizationId;
    if (!UUID_RE.test(id)) return { error: "รายการไม่ถูกต้อง" };

    const day = await getStoreOtDay(ctx.storeId, id);
    if (!day) return { error: "ไม่พบวันให้ OT นี้" };
    const today = getStoreLocalDate(ctx.storeTimezone);
    // ลบ = เอา OT ออกจากเงินเดือน → ใช้กฎเดียวกับการเพิ่ม (ย้อนหลังไม่เกิน 7 วัน · งวดที่จ่ายแล้วแตะไม่ได้)
    const check = validateOtDayInput({
      from: day.date,
      to: day.date,
      capHours: day.capHours,
      multiplier: day.multiplier,
      userIds: day.userIds,
      today,
      rosterUserIds: new Set(day.userIds),
    });
    if (!check.ok) return { error: check.error.replace("ให้ OT ย้อนหลัง", "ลบวันให้ OT ย้อนหลัง") };
    const locks = await loadPaidLocks(ctx.storeId, day.date, day.date);
    const lock = findPaidLock([day.date], day.userIds, locks.periods, locks.weeks);
    if (lock) return { error: `${lock.date}: ${lock.reason.replace("ให้ OT เพิ่มไม่ได้", "ลบวันให้ OT ไม่ได้")}` };

    const result = await deleteStoreOtDay(ctx.storeId, id);
    if (result.error) return { error: result.error };
    await logSystemEvent({
      level: "info",
      source: "hr.ot-days",
      action: "otDayDeleted",
      message: `ลบวันให้ OT ${day.date} (สูงสุด ${day.capHours} ชม. · ${day.userIds.length} คน)`,
      organizationId: ctx.organizationId,
      storeId: ctx.storeId,
      actorUserId: user.id,
      context: { date: day.date, capHours: day.capHours, multiplier: day.multiplier, userIds: day.userIds, today },
    });
    revalidatePayroll();
    return { error: null };
  } catch (e) {
    await logSystemEvent({
      level: "error",
      source: "hr.ot-days",
      action: "deleteOtDay",
      message: e instanceof Error ? e.message : "ลบวันให้ OT ไม่สำเร็จ",
      organizationId,
      storeId,
    });
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}
