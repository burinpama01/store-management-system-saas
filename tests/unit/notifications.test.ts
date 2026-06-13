import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  dispatchNotification,
  sendTelegramMessage,
  validateNotificationPayload,
} from "@/modules/notifications/dispatcher";

const root = process.cwd();
const normalizeText = (value: string) => value.replace(/\r\n/g, "\n");
const read = (path: string) => normalizeText(readFileSync(join(root, path), "utf8"));
const readIfExists = (path: string) => {
  const fullPath = join(root, path);
  return existsSync(fullPath) ? normalizeText(readFileSync(fullPath, "utf8")) : "";
};

describe("notification dispatcher", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("rejects unknown notification type", () => {
    const error = validateNotificationPayload({
      type: "unknown" as never,
      message: "test",
    });
    expect(error).toBe("Unknown notification type");
  });

  it("rejects empty message", () => {
    const error = validateNotificationPayload({
      type: "test",
      message: "",
    });
    expect(error).toBe("Notification message is required");
  });

  it("skips provider delivery when token is not configured", async () => {
    const old = process.env.LINE_CHANNEL_ACCESS_TOKEN;
    delete process.env.LINE_CHANNEL_ACCESS_TOKEN;
    const result = await dispatchNotification({
      type: "test",
      channel: "line",
      message: "[TEST] notification",
    });
    process.env.LINE_CHANNEL_ACCESS_TOKEN = old;

    expect(result.ok).toBe(true);
    expect(result.skipped).toBe(true);
    expect(result.message).toContain("ช่องทาง LINE ยังไม่พร้อมใช้งาน");
  });

  it("wires diagnostics notification test button to a gated server action", () => {
    const action = read("src/app/(dashboard)/settings/diagnostics/actions.ts");
    const panel = read("src/app/(dashboard)/settings/diagnostics/DiagnosticsPanel.tsx");
    const page = read("src/app/(dashboard)/settings/diagnostics/page.tsx");

    expect(action).toContain("\"use server\"");
    expect(action).toContain("requirePermission(\"notifications.manage\")");
    expect(action).toContain("requireFeature(\"lineNotify\")");
    expect(action).toContain("dispatchNotification");
    expect(action).toContain("type: \"test\"");
    expect(panel).toContain("runNotificationDiagnosticAction");
    expect(panel).toContain("await runNotificationDiagnosticAction()");
    expect(panel).toContain("canRunNotificationDiagnostic");
    expect(panel).toContain("type DiagnosticStatus");
    expect(panel).toContain("status: result.ok ? \"success\" : \"error\"");
    expect(panel).toContain("status === \"success\"");
    expect(panel).toContain("status === \"error\"");
    expect(page).toContain("getResolvedCurrentPermissions");
    expect(page).toContain("canRunNotificationDiagnostic={resolved.can(\"notifications.manage\")}");
    expect(page).not.toContain("resolvePermissions(ctx.role, []");
  });

  it("adds persisted notification settings repository and schema", () => {
    const repository = read("src/modules/notifications/repository.ts");
    const page = read("src/app/(dashboard)/settings/notifications/page.tsx");
    const toggle = read("src/app/(dashboard)/settings/notifications/NotificationSettingToggle.tsx");
    const actions = read("src/app/(dashboard)/settings/notifications/actions.ts");
    const migration = read("supabase/migrations/20260601000001_notification_settings.sql");
    const types = read("src/server/integrations/supabase/database.types.ts");

    expect(repository).toContain("listNotificationSettings");
    expect(repository).toContain("upsertNotificationSetting");
    expect(repository).toContain(".from(\"notification_settings\")");
    expect(actions).toContain("\"use server\"");
    expect(actions).toContain("requirePermission(\"notifications.manage\")");
    expect(actions).toContain("upsertNotificationSetting");
    expect(actions).toContain("revalidatePath(\"/settings/notifications\")");
    expect(page).toContain("NotificationSettingToggle");
    expect(toggle).toContain("toggleNotificationSettingAction");
    expect(toggle).toContain("name=\"enabled\"");
    expect(toggle).toContain("!canManage || settingsLoadFailed || pending");
    expect(page).toContain("listNotificationSettings(ctx.storeId");
    expect(page).toContain("settingsByKey");
    expect(migration).toContain("create table if not exists notification_settings");
    expect(migration).toContain("store_id in (select auth_user_store_ids())");
    expect(migration).toContain("exists (");
    expect(migration).toContain("select 1 from stores");
    expect(migration).toContain("and (\n      store_id in (select auth_user_store_ids())");
    expect(migration).toContain("unique (store_id, notification_type, channel)");
    expect(migration).toContain("create trigger set_updated_at before update on notification_settings");
    expect(page).toContain("settingsLoadFailed");
    expect(page).toContain("โหลดการตั้งค่า notification ไม่สำเร็จ");
    expect(types).toContain("notification_settings:");
  });

  it("surfaces Telegram API failure as user-facing copy with a Store OS Bot setup hint", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: false,
          description: "Bad Request: chat not found",
        }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    const result = await sendTelegramMessage("token", "-1001234567890", {
      type: "test",
      channel: "telegram",
      destination: "owner",
      title: "ทดสอบ",
      message: "hello",
      organizationId: "org",
      storeId: "store",
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("ส่ง Telegram ไม่สำเร็จ (400)");
    expect(result.message).toContain("ไม่พบ chat นี้");
    expect(result.message).toContain("Store OS Bot");
    expect(result.message).toContain("@store_os_bot");
    expect(result.message).not.toContain("provider delivery failed");
  });

  it("does not echo unexpected Telegram API details to user-facing feedback", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("provider token secret raw gateway failure", {
        status: 500,
        headers: { "Content-Type": "text/plain" },
      }),
    );

    const result = await sendTelegramMessage("token", "-1001234567890", {
      type: "test",
      channel: "telegram",
      destination: "owner",
      title: "ทดสอบ",
      message: "hello",
      organizationId: "org",
      storeId: "store",
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("ส่ง Telegram ไม่สำเร็จ (500)");
    expect(result.message).toContain("Telegram ยังส่งข้อความไม่ได้ในตอนนี้");
    expect(result.message).toContain("Store OS Bot");
    expect(result.message).not.toContain("provider");
    expect(result.message).not.toContain("token");
    expect(result.message).not.toContain("secret");
    expect(result.message).not.toContain("raw gateway failure");
  });

  it("times out Telegram delivery without waiting for a hanging provider", async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, "fetch").mockImplementation(
      () => new Promise<Response>(() => {}),
    );

    const pending = sendTelegramMessage("super-secret-telegram-token", "-1001234567890", {
      type: "test",
      channel: "telegram",
      destination: "owner",
      title: "ทดสอบ",
      message: "hello",
      organizationId: "org",
      storeId: "store",
    });

    await vi.advanceTimersByTimeAsync(6_000);
    const result = await Promise.race([pending, Promise.resolve("pending")]);
    if (typeof result === "string") {
      expect(result).not.toBe("pending");
      return;
    }

    expect(result.ok).toBe(false);
    expect(result.message).toContain("ส่ง Telegram ไม่สำเร็จ");
    expect(result.message).toContain("Telegram ยังส่งข้อความไม่ได้ในตอนนี้");
    expect(result.message).not.toContain("super-secret-telegram-token");
  });

  it("sanitizes rejected Telegram fetch errors before returning feedback", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("request failed https://api.telegram.org/botsuper-secret-telegram-token/sendMessage"),
    );

    const result = await sendTelegramMessage("super-secret-telegram-token", "-1001234567890", {
      type: "test",
      channel: "telegram",
      destination: "owner",
      title: "ทดสอบ",
      message: "hello",
      organizationId: "org",
      storeId: "store",
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("ส่ง Telegram ไม่สำเร็จ");
    expect(result.message).toContain("Telegram ยังส่งข้อความไม่ได้ในตอนนี้");
    expect(result.message).not.toContain("super-secret-telegram-token");
    expect(result.message).not.toContain("api.telegram.org");
    expect(result.message).not.toContain("request failed");
  });

  it("keeps owner notification delivery off order request paths", () => {
    const dispatcher = read("src/modules/notifications/dispatcher.ts");
    const posActions = read("src/app/pos/actions.ts");
    const qrActions = read("src/app/qr/[storeSlug]/[tableId]/actions.ts");

    expect(dispatcher).toContain("export function notifyOwnerSafely");
    expect(dispatcher).not.toContain("export async function notifyOwnerSafely");
    expect(dispatcher).toContain("after(");
    expect(dispatcher).toContain("async function runOwnerNotificationDelivery");
    expect(dispatcher).toContain("const result = await dispatchNotification");
    expect(dispatcher).not.toContain("void dispatchNotification");
    expect(posActions).not.toMatch(/await\s+notifyOwnerSafely/);
    expect(qrActions).not.toMatch(/await\s+notifyOwnerSafely/);
  });

  it("adds tenant-scoped Telegram target storage and delivery pipeline", () => {
    const repository = read("src/modules/notifications/repository.ts");
    const dispatcher = read("src/modules/notifications/dispatcher.ts");
    const apiRoute = read("src/app/api/notify/route.ts");
    const actions = read("src/app/(dashboard)/settings/notifications/actions.ts");
    const page = read("src/app/(dashboard)/settings/notifications/page.tsx");
    const migration = readIfExists("supabase/migrations/20260613000001_telegram_notification_targets.sql");
    const types = read("src/server/integrations/supabase/database.types.ts");

    expect(repository).toContain("getTelegramNotificationTarget");
    expect(repository).toContain("upsertTelegramNotificationTarget");
    expect(repository).toContain(".from(\"notification_targets\")");
    expect(dispatcher).toContain("resolveTelegramNotificationTarget");
    expect(dispatcher).toContain("sendTelegramMessage");
    expect(dispatcher).toContain("https://api.telegram.org/bot");
    expect(dispatcher).toContain("TELEGRAM_BOT_TOKEN");
    expect(dispatcher).toContain("ส่ง Telegram ไม่สำเร็จ");
    expect(apiRoute).toContain("getResolvedCurrentPermissions");
    expect(apiRoute).toContain("organizationId: ctx.organizationId");
    expect(apiRoute).toContain("storeId: ctx.storeId");
    expect(apiRoute).not.toContain("dispatchNotification(body)");
    expect(actions).toContain("saveTelegramChatIdAction");
    expect(actions).toContain("upsertTelegramNotificationTarget");
    expect(page).toContain("@raw_data_bot");
    expect(page).toContain("@store_os_bot");
    expect(page).toContain("Store OS Bot");
    expect(page).toContain("Telegram group");
    expect(page).toContain("chat ID");
    expect(migration).toContain("create table if not exists notification_targets");
    expect(migration).toContain("telegram_chat_id");
    expect(migration).toContain("unique (organization_id, channel)");
    expect(migration).toContain("auth_user_role_in_org(organization_id, 'owner')");
    expect(types).toContain("notification_targets:");
  });

  it("adds owner-only event coverage for POS, QR, buffet, payment, cancellation, and service requests", () => {
    const types = read("src/modules/notifications/types.ts");
    const posActions = read("src/app/pos/actions.ts");
    const qrActions = read("src/app/qr/[storeSlug]/[tableId]/actions.ts");
    const buffetRepository = read("src/modules/buffet/repository.ts");
    const dispatcher = read("src/modules/notifications/dispatcher.ts");
    const settingsPage = read("src/app/(dashboard)/settings/notifications/page.tsx");
    const settingsActions = read("src/app/(dashboard)/settings/notifications/actions.ts");
    const telegramMigration = read("supabase/migrations/20260613000001_telegram_notification_targets.sql");

    expect(types).toContain("| \"new_pos_order\"");
    expect(types).toContain("| \"new_buffet_order\"");
    expect(types).toContain("| \"order_cancelled\"");
    expect(types).toContain("| \"service_request\"");
    expect(posActions).toContain("notifyOwnerSafely");
    expect(posActions).toContain("getTable(opts.tableId");
    expect(posActions).toContain("currentSessionId");
    expect(posActions).toContain("type: \"new_pos_order\"");
    expect(posActions).toContain("type: \"new_buffet_order\"");
    expect(posActions).toContain("type: \"payment\"");
    expect(posActions).toContain("type: \"order_cancelled\"");
    expect(qrActions).toContain("notifyOwnerSafely");
    expect(qrActions).toContain("type: \"new_qr_order\"");
    expect(qrActions).toContain("type: \"new_buffet_order\"");
    expect(qrActions).toContain("type: \"service_request\"");
    expect(qrActions).not.toContain("message: `โต๊ะ ${tableId}");
    expect(qrActions).toContain("tableNumber: table.number");
    expect(buffetRepository).toContain('supabase.rpc("create_buffet_session_with_table"');
    expect(buffetRepository).toContain('supabase.rpc("close_buffet_session_with_table"');
    expect(buffetRepository).not.toMatch(/updateGuestCount[\\s\\S]*current_session_id: null/);
    expect(telegramMigration).toContain("create or replace function create_buffet_session_with_table");
    expect(telegramMigration).toContain("create or replace function close_buffet_session_with_table");
    expect(telegramMigration).toContain("set current_session_id = v_session.id");
    expect(telegramMigration).toContain("set current_session_id = null");
    expect(telegramMigration).toContain("auth_user_role_in_store(p_organization_id, p_store_id, 'cashier')");
    expect(dispatcher).toContain("getOrganizationBillingState");
    expect(dispatcher).toContain("getPlanFeatures");
    expect(dispatcher).toContain("lineNotify");
    expect(dispatcher).toContain("แพ็กเกจปัจจุบันยังไม่เปิดใช้การแจ้งเตือน");
    expect(settingsPage).toContain("canManageTelegramTarget");
    expect(settingsActions).toContain("requireTelegramOwnerContext");
    expect(settingsActions).toContain("ctx.role !== \"owner\"");
  });

  it("shows dialog feedback for notification save, toggle, and Telegram test actions", () => {
    const page = read("src/app/(dashboard)/settings/notifications/page.tsx");
    const chatForm = read("src/app/(dashboard)/settings/notifications/TelegramChatIdForm.tsx");
    const toggle = read("src/app/(dashboard)/settings/notifications/NotificationSettingToggle.tsx");
    const testButton = read("src/app/(dashboard)/settings/notifications/NotificationTest.tsx");
    const feedback = read("src/app/(dashboard)/settings/notifications/NotificationFeedbackDialog.tsx");
    const actions = read("src/app/(dashboard)/settings/notifications/actions.ts");

    expect(page).toContain("TelegramChatIdForm");
    expect(page).toContain("NotificationSettingToggle");
    expect(chatForm).toContain("useActionState");
    expect(chatForm).toContain("<NotificationFeedbackDialog");
    expect(toggle).toContain("useActionState");
    expect(toggle).toContain("<NotificationFeedbackDialog");
    expect(testButton).toContain("<NotificationFeedbackDialog");
    expect(feedback).toContain("<ModalDialog");
    expect(feedback).toContain("role=\"alert\"");
    expect(actions).toContain("ActionFeedbackState");
    expect(actions).toContain("บันทึก Telegram chat ID แล้ว");
    expect(actions).toContain("บันทึกการตั้งค่าแจ้งเตือนแล้ว");
    expect(actions).toContain("formatTelegramTestFeedback");
    expect(actions).not.toContain("message: result.message");
    expect(actions).not.toContain("return result.message");
    expect(actions).toContain("ส่ง Telegram test แล้ว");
    expect(actions).toContain("ยังไม่พร้อมสำหรับทดสอบ Telegram");
  });
});
