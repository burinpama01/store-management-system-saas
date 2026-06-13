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
import {
  getTelegramNotificationTarget,
  listNotificationSettings,
} from "@/modules/notifications/repository";
import { NotificationTest } from "./NotificationTest";
import { TelegramChatIdForm } from "./TelegramChatIdForm";
import { NotificationSettingToggle } from "./NotificationSettingToggle";

export const dynamic = "force-dynamic";

const TYPE_LABELS: Record<NotificationType, string> = {
  payment: "ชำระเงิน POS",
  new_table: "เปิดโต๊ะใหม่",
  new_pos_order: "ออร์เดอร์ POS ใหม่",
  new_qr_order: "ออร์เดอร์ QR",
  new_buffet_order: "ออร์เดอร์บุฟเฟต์",
  kitchen_order: "ออร์เดอร์ครัว",
  buffet_expiring: "บุฟเฟต์ใกล้หมดเวลา",
  stock_alert: "แจ้งเตือนสต็อก",
  order_cancelled: "ยกเลิก/void/refund",
  approval: "การอนุมัติ",
  service_request: "เรียกพนักงาน/ขอความช่วยเหลือ",
  test: "ข้อความทดสอบ",
};

const CHANNEL_LABELS: Record<NotificationChannel, string> = {
  line: "LINE",
  telegram: "Telegram",
};

export default async function NotificationSettingsPage() {
  const { ctx, resolved } = await getResolvedCurrentPermissions();
  if (!resolved.can("settings.view")) redirect("/dashboard");
  if (!resolved.can("notifications.manage")) redirect("/settings/store");

  const billingState =
    (await getOrganizationBillingState(ctx.organizationId)) ??
    DEFAULT_BILLING_STATE;
  const features = getPlanFeatures(billingState);
  const canManage = resolved.can("notifications.manage");
  const canManageTelegramTarget = canManage && ctx.role === "owner";
  const providerReady = {
    line: Boolean(process.env.LINE_CHANNEL_ACCESS_TOKEN),
    telegram: Boolean(process.env.TELEGRAM_BOT_TOKEN),
  } satisfies Record<NotificationChannel, boolean>;
  const settingsResult = await listNotificationSettings(ctx.storeId, ctx.organizationId);
  const telegramTargetResult = canManageTelegramTarget
    ? await getTelegramNotificationTarget(ctx.organizationId)
    : { data: null, error: null };
  const settingsLoadFailed = Boolean(settingsResult.error);
  const telegramTargetLoadFailed = Boolean(telegramTargetResult.error);
  const telegramChatId = telegramTargetResult.data?.telegramChatId ?? "";
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
          แสดงเฉพาะช่องทางที่พร้อมใช้งานและการตั้งค่าของร้านนี้
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

      <div className="rounded-md border border-[var(--color-border)] bg-white p-4">
        <div className="grid gap-4 lg:grid-cols-[1.1fr_0.9fr]">
          <div>
            <p className="text-xs font-bold uppercase tracking-wide text-[var(--color-text-muted)]">
              Telegram group setup
            </p>
            <h2 className="mt-1 text-lg font-bold text-[var(--color-text-primary)]">
              ตั้งค่า Telegram chat ID ของ tenant นี้
            </h2>
            <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm text-[var(--color-text-secondary)]">
              <li>โหลด Telegram แล้วสร้าง Telegram group สำหรับ owner ของร้าน</li>
              <li>เพิ่ม <span className="font-bold text-[var(--color-text-primary)]">@raw_data_bot</span> เข้ากลุ่มก่อน</li>
              <li>คัดลอก chat ID ที่ bot แจ้ง แล้วนำมากรอกในช่องด้านขวา</li>
              <li>
                เพิ่ม bot ที่ชื่อ <span className="font-bold text-[var(--color-text-primary)]">Store OS Bot</span>{" "}
                และ username <span className="font-bold text-[var(--color-text-primary)]">@store_os_bot</span>{" "}
                เข้ากลุ่มเพื่อรับการแจ้งเตือน
              </li>
            </ol>
            <p className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              ถ้า Telegram แสดงหลายตัวเลือก ให้เลือกเฉพาะ bot ที่ชื่อ Store OS Bot และ username @store_os_bot เท่านั้น
            </p>
            <p className="mt-3 text-xs text-[var(--color-text-muted)]">
              ระบบเก็บการเชื่อมต่อของ bot แยกจากข้อมูลของร้านนี้ และ chat ID นี้ใช้เฉพาะ tenant นี้เท่านั้น
            </p>
          </div>
          <TelegramChatIdForm
            telegramChatId={telegramChatId}
            canManageTelegramTarget={canManageTelegramTarget}
            telegramTargetLoadFailed={telegramTargetLoadFailed}
          />
        </div>
      </div>

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
                      <NotificationSettingToggle
                        type={type}
                        channel={channel}
                        configured={configured}
                        enabled={enabled}
                        canManage={canManage}
                        settingsLoadFailed={settingsLoadFailed}
                      />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <NotificationTest canRun={canManageTelegramTarget && features.lineNotify && providerReady.telegram && Boolean(telegramChatId)} />
    </section>
  );
}
