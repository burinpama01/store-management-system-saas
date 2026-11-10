/**
 * แจ้งเตือนเงินเดือน (R31) — ส่ง push ถึง "รายคน" (ระบบเดิมส่งตามร้าน+role)
 * ทุกจุดต้องผ่าน: แพ็กมีสิทธิ์ + สวิตช์ payrollNotifications เปิด (ผู้เรียกตรวจ) และกันซ้ำด้วย dedupe key
 * ข้อความห้ามมีเลขบัญชี/ข้อมูลอ่อนไหว
 */
import { createSupabaseServiceClient } from "@/server/integrations/supabase/server";
import { parseServiceAccount, sendFcmToDevice } from "@/modules/notifications/push";
import { deleteDevicePushTokens } from "@/modules/notifications/repository";
import { logSystemEvent } from "@/modules/system/event-log";
import { claimPayrollNotification } from "./repository";

export interface PayrollPushInput {
  organizationId: string;
  storeId: string;
  userIds: string[];
  title: string;
  message: string;
  /** ประเภทเหตุการณ์ เช่น "payslip_ready" */
  kind: string;
  /** กันส่งซ้ำ — เหตุการณ์เดียวกันต่อ key ส่งครั้งเดียว (null = ไม่กัน) */
  dedupeKey: string | null;
}

export async function pushPayrollNotification(input: PayrollPushInput): Promise<{ sent: number; devices: number; skipped?: string }> {
  const userIds = [...new Set(input.userIds)].filter(Boolean);
  if (userIds.length === 0) return { sent: 0, devices: 0, skipped: "no_recipients" };
  if (input.dedupeKey && !(await claimPayrollNotification(input.storeId, input.kind, input.dedupeKey))) {
    return { sent: 0, devices: 0, skipped: "duplicate" };
  }
  const account = parseServiceAccount(process.env.FIREBASE_SERVICE_ACCOUNT);
  if (!account) {
    await logSystemEvent({
      level: "warn",
      source: "hr.payroll-notify",
      action: input.kind,
      message: "ส่งแจ้งเตือนเงินเดือนไม่ได้: ยังไม่ตั้ง FIREBASE_SERVICE_ACCOUNT",
      organizationId: input.organizationId,
      storeId: input.storeId,
    });
    return { sent: 0, devices: 0, skipped: "no_push_account" };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- อ่านตาราง token แบบเดียวกับ repository เดิม
  const db: any = await createSupabaseServiceClient();
  const { data: tokens } = await db
    .from("device_push_tokens")
    .select("token, platform, app_version, user_id")
    .eq("organization_id", input.organizationId)
    .in("user_id", userIds);
  const devices = (tokens ?? []) as { token: string; platform: "android" | "ios"; app_version: string | null }[];

  const outcomes = await Promise.all(
    devices.map(async (d) => ({
      token: d.token,
      outcome: await sendFcmToDevice(
        account,
        { token: d.token, platform: d.platform, appVersion: d.app_version },
        {
          type: "daily_summary",
          title: input.title,
          message: input.message,
          organizationId: input.organizationId,
          storeId: input.storeId,
        },
      ),
    })),
  );
  const dead = outcomes.filter((o) => o.outcome === "unregistered").map((o) => o.token);
  if (dead.length) await deleteDevicePushTokens(dead);
  const sent = outcomes.filter((o) => o.outcome === "sent").length;

  await logSystemEvent({
    level: devices.length > 0 && sent === 0 ? "warn" : "info",
    source: "hr.payroll-notify",
    action: input.kind,
    message: `แจ้งเตือนเงินเดือน ${input.kind}: ${userIds.length} คน · ส่งถึง ${sent}/${devices.length} เครื่อง`,
    organizationId: input.organizationId,
    storeId: input.storeId,
    context: { kind: input.kind, recipients: userIds.length, devices: devices.length, sent, dedupeKey: input.dedupeKey },
  });
  return { sent, devices: devices.length };
}

/** ผู้จัดการ/เจ้าของของสาขา (membership ที่ครอบสาขานี้) */
export async function listStoreManagerUserIds(organizationId: string, storeId: string): Promise<string[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- memberships อ่านด้วย service client
  const db: any = await createSupabaseServiceClient();
  const { data } = await db
    .from("memberships")
    .select("user_id, role, store_id")
    .eq("organization_id", organizationId)
    .or(`store_id.eq.${storeId},store_id.is.null`)
    .in("role", ["owner", "admin", "manager"])
    .not("joined_at", "is", null);
  return [...new Set(((data ?? []) as { user_id: string }[]).map((m) => m.user_id))];
}

/** สมาชิกทุกคนของสาขา (ไม่รวม super_admin) */
export async function listStoreMemberUserIds(organizationId: string, storeId: string): Promise<string[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- memberships อ่านด้วย service client
  const db: any = await createSupabaseServiceClient();
  const { data } = await db
    .from("memberships")
    .select("user_id, role")
    .eq("organization_id", organizationId)
    .or(`store_id.eq.${storeId},store_id.is.null`)
    .neq("role", "super_admin")
    .not("joined_at", "is", null);
  return [...new Set(((data ?? []) as { user_id: string }[]).map((m) => m.user_id))];
}

export function formatBaht(n: number): string {
  return `฿${n.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
