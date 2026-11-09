"use server";

import { revalidatePath } from "next/cache";
import { getResolvedCurrentPermissions } from "@/modules/auth/guards";
import { listEmployeeProfiles } from "@/modules/hr/repository";
import { changedFields, lockedFields, parseSelfInfoForm } from "@/modules/hr/self-info";
import { getMySelfInfo, saveMySelfInfo } from "@/modules/hr/self-info-repository";
import { getStoreLocalDate } from "@/modules/attendance/date";
import { logSystemEvent } from "@/modules/system/event-log";

/** พนักงานบันทึกข้อมูลตัวเอง — ช่องที่เจ้าของตั้งแล้วไม่ถูกส่งไป (DB ล้างซ้ำอีกชั้น) */
export async function saveMySelfInfoAction(formData: FormData): Promise<{ error: string | null }> {
  const { user, ctx, resolved } = await getResolvedCurrentPermissions();
  if (!resolved.can("attendance.clock")) return { error: "บัญชีนี้ยังไม่มีสิทธิ์ลงเวลา จึงยังแก้ข้อมูลของตัวเองไม่ได้" };

  const [profiles, before] = await Promise.all([listEmployeeProfiles(ctx.storeId), getMySelfInfo(ctx.storeId, user.id)]);
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
    return { error: parsed.error };
  }

  const fields = changedFields(before.data, parsed.value);
  const result = await saveMySelfInfo({ organizationId: ctx.organizationId, storeId: ctx.storeId, userId: user.id }, parsed.value);
  await log(!result.error, result.error ? `บันทึกข้อมูลตัวเองไม่สำเร็จ: ${result.error}` : "พนักงานแก้ข้อมูลตัวเอง", {
    changedFields: fields,
    locked: [...locked],
  });
  if (result.error) return { error: result.error };
  revalidatePath("/my-profile");
  revalidatePath("/staff");
  return { error: null };
}
