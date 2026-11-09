"use server";

import { revalidatePath } from "next/cache";
import { getResolvedCurrentPermissions } from "@/modules/auth/guards";
import { reviewSelfInfoRequest } from "@/modules/hr/self-info-repository";
import { logSystemEvent } from "@/modules/system/event-log";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** ผู้จัดการอนุมัติ/ปฏิเสธคำขอแก้ข้อมูล — RPC ตรวจสิทธิ์ attendance.manage ซ้ำในฐานข้อมูล */
export async function reviewSelfInfoRequestAction(requestId: string, approve: boolean, note: string | null): Promise<{ error: string | null }> {
  const { user, ctx, resolved } = await getResolvedCurrentPermissions();
  if (!resolved.can("attendance.manage")) return { error: "ไม่มีสิทธิ์อนุมัติคำขอนี้" };
  if (!UUID_RE.test(requestId)) return { error: "ข้อมูลคำขอไม่ถูกต้อง" };
  const reason = note?.trim().slice(0, 300) || null;
  const result = await reviewSelfInfoRequest(requestId, approve, reason);
  await logSystemEvent({
    level: result.error ? "warn" : "info",
    source: "hr.self-info",
    action: approve ? "approveSelfInfoRequest" : "rejectSelfInfoRequest",
    message: result.error ? `ดำเนินการคำขอไม่สำเร็จ: ${result.error}` : approve ? "อนุมัติคำขอแก้ข้อมูลพนักงาน" : "ปฏิเสธคำขอแก้ข้อมูลพนักงาน",
    organizationId: ctx.organizationId,
    storeId: ctx.storeId,
    actorUserId: user.id,
    context: { requestId },
  }).catch(() => undefined);
  if (result.error) return result;
  revalidatePath("/staff");
  revalidatePath("/my-profile");
  revalidatePath("/payslip");
  return { error: null };
}
