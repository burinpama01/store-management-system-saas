import { redirect } from "next/navigation";
import { getOrganizationBillingState } from "@/modules/billing/billing-service";
import {
  DEFAULT_BILLING_STATE,
  getPlanFeatures,
  PLAN_LABELS,
} from "@/modules/billing/types";
import { getResolvedCurrentPermissions } from "@/modules/auth/guards";
import {
  NOTIFICATION_CHANNELS,
  NOTIFICATION_TYPES,
  type NotificationChannel,
  type NotificationType,
} from "@/modules/notifications/types";
import { listNotificationSettings } from "@/modules/notifications/repository";
import { toggleNotificationSettingAction } from "./actions";

export const dynamic = "force-dynamic";

const TYPE_LABELS: Record<NotificationType, string> = {
  payment: "ชำระเงิน POS",
  new_table: "เปิดโต๊ะใหม่",
  new_qr_order: "ออร์เดอร์ QR",
  kitchen_order: "ออร์เดอร์ครัว",
  buffet_expiring: "บุฟเฟต์ใกล้หมดเวลา",
  stock_alert: "แจ้งเตือนสต็อก",
  test: "ข้อความทดสอบ",
};

const CHANNEL_LABELS: Record<NotificationChannel, string> = {
  line: "LINE",
  telegram: "Telegram",
};

export default async function NotificationSettingsPage() {
  const { ctx, resolved } = await getResolvedCurrentPermissions();
  if (!resolved.can("settings.view")) redirect("/dashboard");

  const billingState =
    (await getOrganizationBillingState(ctx.organizationId)) ??
    DEFAULT_BILLING_STATE;
  const features = getPlanFeatures(billingState);
  const canManage = resolved.can("notifications.manage");
  const providerReady = {
    line: Boolean(process.env.LINE_CHANNEL_ACCESS_TOKEN),
    telegram: Boolean(process.env.TELEGRAM_BOT_TOKEN),
  } satisfies Record<NotificationChannel, boolean>;
  const settingsResult = await listNotificationSettings(ctx.storeId, ctx.organizationId);
  const settingsLoadFailed = Boolean(settingsResult.error);
  const settingsByKey = new Map(
    (settingsResult.data ?? []).map((setting) => [
      `${setting.type}:${setting.channel}`,
      setting,
    ]),
  );

  return (
    <section className="space-y-5">
      <header>
        <p className="text-xs font-bold uppercase tracking-wide text-[var(--color-text-muted)]">
          Notification Matrix
        </p>
        <h1 className="text-2xl font-bold text-[var(--color-text-primary)]">
          ตั้งค่า Notifications
        </h1>
        <p className="mt-1 text-sm text-[var(--color-text-secondary)]">
          ไม่แสดง token หรือ secret บนหน้า UI แสดงเฉพาะสถานะพร้อมใช้งานของ provider
        </p>
      </header>

      {!features.lineNotify && (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
          LINE/Telegram notifications ถูกจำกัดในแพ็กเกจ {PLAN_LABELS[billingState.plan]}
        </div>
      )}

      {settingsLoadFailed && (
        <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          โหลดการตั้งค่า notification ไม่สำเร็จ
        </div>
      )}

      {!canManage && (
        <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-muted)] p-4 text-sm text-[var(--color-text-secondary)]">
          role นี้ดูสถานะได้ แต่ยังไม่มีสิทธิ์แก้การแจ้งเตือน
        </div>
      )}

      <div className="overflow-x-auto rounded-md border border-[var(--color-border)] bg-white">
        <table className="min-w-[720px] w-full text-sm">
          <thead className="bg-[var(--color-surface-muted)] text-xs font-bold uppercase tracking-wide text-[var(--color-text-muted)]">
            <tr>
              <th className="px-4 py-3 text-left">Event</th>
              {NOTIFICATION_CHANNELS.map((channel) => (
                <th key={channel} className="px-4 py-3 text-left">
                  {CHANNEL_LABELS[channel]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--color-border)]">
            {NOTIFICATION_TYPES.map((type) => (
              <tr key={type}>
                <td className="px-4 py-3 font-semibold text-[var(--color-text-primary)]">
                  {TYPE_LABELS[type]}
                </td>
                {NOTIFICATION_CHANNELS.map((channel) => {
                  const setting = settingsByKey.get(`${type}:${channel}`);
                  const configured = settingsLoadFailed ? false : setting?.enabled ?? true;
                  const enabled = features.lineNotify && providerReady[channel] && configured;
                  return (
                    <td key={channel} className="px-4 py-3">
                      <form action={toggleNotificationSettingAction} className="flex items-center gap-3">
                        <input type="hidden" name="type" value={type} />
                        <input type="hidden" name="channel" value={channel} />
                        <label className="flex min-h-11 items-center gap-2">
                          <input
                            type="checkbox"
                            name="enabled"
                            defaultChecked={configured}
                            disabled={!canManage || settingsLoadFailed}
                            className="h-4 w-4 accent-teal-700 disabled:cursor-not-allowed"
                          />
                          <span
                            className={
                              enabled
                                ? "rounded-md bg-emerald-50 px-2 py-1 text-xs font-bold text-emerald-700"
                                : configured
                                  ? "rounded-md bg-slate-100 px-2 py-1 text-xs font-bold text-slate-500"
                                  : "rounded-md bg-amber-50 px-2 py-1 text-xs font-bold text-amber-700"
                            }
                          >
                            {enabled ? "พร้อมส่ง" : configured ? "ยังไม่พร้อม" : "ปิดไว้"}
                          </span>
                        </label>
                        {canManage && !settingsLoadFailed && (
                          <button
                            type="submit"
                            className="min-h-11 rounded-md border border-[var(--color-border)] px-3 text-xs font-bold text-[var(--color-text-primary)] hover:bg-[var(--color-surface-muted)]"
                          >
                            บันทึก
                          </button>
                        )}
                      </form>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
