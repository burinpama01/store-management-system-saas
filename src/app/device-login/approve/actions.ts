"use server";

import { getOptionalResolvedCurrentPermissions } from "@/modules/auth/guards";
import { approveDeviceLoginRequest, cancelDeviceLoginRequest } from "@/modules/auth/device-login";
import { listResignedUserIds } from "@/modules/hr/employment-status";
import { logSystemEvent } from "@/modules/system/event-log";

export interface ApproveState {
  readonly error: string | null;
  readonly done: "approved" | "denied" | null;
}

export async function approveDeviceLoginAction(_prev: ApproveState, formData: FormData): Promise<ApproveState> {
  const perms = await getOptionalResolvedCurrentPermissions();
  if (!perms) return { error: "กรุณาล็อกอินบนมือถือก่อน", done: null };
  if (!perms.resolved.can("pos.use")) return { error: "บัญชีนี้ไม่มีสิทธิ์ใช้หน้าขาย (POS) ในสาขานี้", done: null };

  try {
    if ((await listResignedUserIds(perms.ctx.storeId)).has(perms.user.id)) {
      return { error: "บัญชีนี้ลาออกจากสาขานี้แล้ว อนุมัติเครื่องไม่ได้", done: null };
    }
  } catch {
    // อ่านสถานะลาออกไม่ได้ — สิทธิ์ POS ที่ตรวจแล้วด้านบนกรองคนลาออกอีกชั้นอยู่แล้ว
  }

  const requestId = String(formData.get("requestId") ?? "");
  const result = await approveDeviceLoginRequest({
    requestId,
    shortCode: String(formData.get("shortCode") ?? ""),
    employeeCode: String(formData.get("employeeCode") ?? ""),
    userId: perms.user.id,
    storeId: perms.ctx.storeId,
  });

  void logSystemEvent({
    level: result.ok ? "info" : "warn",
    source: "auth.device-login",
    action: result.ok ? "approve" : "approve_rejected",
    message: result.ok ? `อนุมัติเครื่อง "${result.deviceLabel ?? "ไม่ระบุชื่อ"}" ด้วย QR` : result.error,
    organizationId: perms.ctx.organizationId,
    storeId: perms.ctx.storeId,
    actorUserId: perms.user.id,
    context: { requestId },
  });

  if (!result.ok) {
    return { error: result.attemptsLeft ? `${result.error} (เหลืออีก ${result.attemptsLeft} ครั้ง)` : result.error, done: null };
  }
  return { error: null, done: "approved" };
}

export async function denyDeviceLoginAction(_prev: ApproveState, formData: FormData): Promise<ApproveState> {
  const perms = await getOptionalResolvedCurrentPermissions();
  if (!perms) return { error: "กรุณาล็อกอินบนมือถือก่อน", done: null };
  const requestId = String(formData.get("requestId") ?? "");
  await cancelDeviceLoginRequest(requestId);
  void logSystemEvent({
    level: "info",
    source: "auth.device-login",
    action: "deny",
    message: "ปฏิเสธคำขอเข้าใช้เครื่องด้วย QR",
    organizationId: perms.ctx.organizationId,
    storeId: perms.ctx.storeId,
    actorUserId: perms.user.id,
    context: { requestId },
  });
  return { error: null, done: "denied" };
}
