"use server";

import { revalidatePath } from "next/cache";
import { getResolvedCurrentPermissions } from "@/modules/auth/guards";
import { listEmployeeProfiles } from "@/modules/hr/repository";
import { lockedFields, parseSelfInfoForm, splitSelfInfoPatch } from "@/modules/hr/self-info";
import { cancelSelfInfoRequest, getMySelfInfo, saveMySelfInfo, submitSelfInfoRequest } from "@/modules/hr/self-info-repository";
import { getStoreLocalDate } from "@/modules/attendance/date";
import { logSystemEvent } from "@/modules/system/event-log";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SaveMySelfInfoResult {
  error: string | null;
  /** จำนวนช่องที่บันทึกทันที (กรอกครั้งแรก) */
  savedCount: number;
  /** จำนวนช่องที่ส่งคำขอรออนุมัติ */
  requestedCount: number;
}

/**
 * พนักงานบันทึกข้อมูลตัวเอง
 * - ช่องที่เจ้าของตั้งแล้ว: ไม่ถูกส่งไป (DB ล้างซ้ำอีกชั้น)
 * - ช่องที่ยังว่าง: บันทึกทันที · ช่องที่มีค่าแล้วและเปลี่ยน: ส่งคำขอรออนุมัติ (DB ปฏิเสธการแก้ตรง)
 */
export async function saveMySelfInfoAction(formData: FormData): Promise<SaveMySelfInfoResult> {
  const { user, ctx, resolved } = await getResolvedCurrentPermissions();
  if (!resolved.can("attendance.clock")) {
    return { error: "บัญชีนี้ยังไม่มีสิทธิ์ลงเวลา จึงยังแก้ข้อมูลของตัวเองไม่ได้", savedCount: 0, requestedCount: 0 };
  }

  const [profiles, before] = await Promise.all([listEmployeeProfiles(ctx.storeId), getMySelfInfo(ctx.storeId, user.id)]);
  // อ่านค่าปัจจุบันไม่ได้ ห้ามเดาว่าช่องว่าง (จะพยายามบันทึกทับแล้วโดน trigger ปฏิเสธ)
  if (before.error) return { error: before.error, savedCount: 0, requestedCount: 0 };
  // อ่านสถานะล็อกไม่ได้ ห้ามถือว่าไม่ล็อก
  if (profiles.error) return { error: "โหลดข้อมูลพนักงานไม่สำเร็จ กรุณาลองใหม่", savedCount: 0, requestedCount: 0 };
  const own = profiles.data?.find((p) => p.userId === user.id);
  const locked = lockedFields(own);
  const parsed = parseSelfInfoForm((key) => formData.get(key), { locked, today: getStoreLocalDate(ctx.storeTimezone) });

  const log = (ok: boolean, message: string, context: Record<string, unknown>) =>
    logSystemEvent({
      level: ok ? "info" : "warn",
      source: "hr.self-info",
      action: "saveMySelfInfo",
      message,
      organizationId: ctx.organizationId,
      storeId: ctx.storeId,
      actorUserId: user.id,
      // เก็บแค่ชื่อช่อง ไม่เก็บค่าจริง (เลขบัญชี/เบอร์/ที่อยู่)
      context,
    }).catch(() => undefined);

  if (parsed.value === null) {
    await log(false, `กรอกข้อมูลไม่ถูกต้อง: ${parsed.error}`, { locked: [...locked] });
    return { error: parsed.error, savedCount: 0, requestedCount: 0 };
  }

  const { direct, needsApproval } = splitSelfInfoPatch(before.data, parsed.value);
  const directFields = Object.keys(direct);
  const requestFields = Object.keys(needsApproval);
  const context = { savedFields: directFields, requestedFields: requestFields, locked: [...locked] };

  if (directFields.length > 0) {
    const saved = await saveMySelfInfo({ organizationId: ctx.organizationId, storeId: ctx.storeId, userId: user.id }, direct);
    if (saved.error) {
      await log(false, `บันทึกข้อมูลตัวเองไม่สำเร็จ: ${saved.error}`, context);
      return { error: saved.error, savedCount: 0, requestedCount: 0 };
    }
  }
  if (requestFields.length > 0) {
    const requested = await submitSelfInfoRequest(ctx.storeId, needsApproval);
    if (requested.error) {
      await log(false, `ส่งคำขอแก้ข้อมูลไม่สำเร็จ: ${requested.error}`, context);
      revalidatePath("/my-profile");
      return {
        error: directFields.length > 0 ? `บันทึกช่องใหม่แล้ว แต่ส่งคำขอแก้ไม่สำเร็จ: ${requested.error} — กดบันทึกอีกครั้งเพื่อส่งคำขอช่องที่เหลือ` : requested.error,
        savedCount: directFields.length,
        requestedCount: 0,
      };
    }
  }

  await log(true, requestFields.length > 0 ? "พนักงานส่งคำขอแก้ข้อมูลตัวเอง" : "พนักงานกรอกข้อมูลตัวเอง", context);
  revalidatePath("/my-profile");
  revalidatePath("/staff");
  return { error: null, savedCount: directFields.length, requestedCount: requestFields.length };
}

export async function cancelMySelfInfoRequestAction(requestId: string): Promise<{ error: string | null }> {
  const { user, ctx, resolved } = await getResolvedCurrentPermissions();
  if (!resolved.can("attendance.clock")) return { error: "ไม่มีสิทธิ์" };
  if (!UUID_RE.test(requestId)) return { error: "ข้อมูลคำขอไม่ถูกต้อง" };
  const result = await cancelSelfInfoRequest(requestId);
  await logSystemEvent({
    level: result.error ? "warn" : "info",
    source: "hr.self-info",
    action: "cancelMySelfInfoRequest",
    message: result.error ? `ยกเลิกคำขอไม่สำเร็จ: ${result.error}` : "พนักงานยกเลิกคำขอแก้ข้อมูล",
    organizationId: ctx.organizationId,
    storeId: ctx.storeId,
    actorUserId: user.id,
    context: { requestId },
  }).catch(() => undefined);
  if (result.error) return result;
  revalidatePath("/my-profile");
  revalidatePath("/staff");
  return { error: null };
}
