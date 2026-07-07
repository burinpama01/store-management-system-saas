import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
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
const readMigrationContaining = (needle: string) => {
  const migrationsDir = join(root, "supabase/migrations");
  const fileName = readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .find((name) => readFileSync(join(migrationsDir, name), "utf8").includes(needle));
  return fileName ? normalizeText(readFileSync(join(migrationsDir, fileName), "utf8")) : "";
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
    expect(action).toContain("getCurrentUser");
    expect(action).toContain("getUserStores");
    expect(action).toContain("resolveCurrentStore");
    expect(action).toContain("dispatchNotification");
    expect(action).toContain("type: \"test\"");
    expect(action).toContain("organizationId: ctx.organizationId");
    expect(action).toContain("storeId: ctx.storeId");
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

  it("wires LINE notification test button to the account link panel", () => {
    const actions = read("src/app/(dashboard)/settings/notifications/actions.ts");
    const panel = read("src/app/(dashboard)/settings/notifications/LineAccountLinkPanel.tsx");
    const page = read("src/app/(dashboard)/settings/notifications/page.tsx");

    expect(actions).toContain("export async function runLineNotificationTestAction");
    expect(actions).toContain("requirePermission(\"notifications.manage\")");
    expect(actions).toContain("requireFeature(\"lineNotify\")");
    expect(actions).toContain("channel: \"line\"");
    expect(actions).toContain("title: \"StoreOS LINE test\"");
    expect(actions).toContain("message: \"[TEST] LINE notification พร้อมใช้งาน\"");
    expect(actions).toContain("organizationId: ctx.organizationId");
    expect(actions).toContain("storeId: ctx.storeId");

    expect(panel).toContain("runLineNotificationTestAction");
    expect(panel).toContain("canTestLine");
    expect(panel).toContain("const canRenderLineTest = canManage");
    expect(panel).toContain("{canRenderLineTest && (");
    expect(panel).toContain("setPending(true)");
    expect(panel).toContain("finally");
    expect(panel).toContain("ทดสอบ LINE");
    expect(panel).toContain("LINE test");
    expect(panel).toContain("NotificationFeedbackDialog");
    expect(page).toContain("canTestLine=");
    expect(page).toContain("getLineNotificationTarget");
    expect(page).toContain("getLineNotificationTarget(ctx.organizationId, { useServiceRole: true })");
    expect(page).toContain("lineDeliveryTargetReady");
    expect(page).toContain("canTestLine={canManage && features.lineNotify && providerReady.line && lineDeliveryTargetReady}");
    expect(page).not.toContain("canTestLine={canManage && features.lineNotify && providerReady.line && (linked || groupLinked)}");
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

  it("fans out owner notification delivery to all channels unless the caller pins one", async () => {
    const oldLineToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
    const oldTelegramToken = process.env.TELEGRAM_BOT_TOKEN;
    const afterTasks: Promise<unknown>[] = [];
    const getNotificationSetting = vi.fn().mockResolvedValue({ data: { enabled: true }, error: null });
    const getTelegramNotificationTarget = vi.fn().mockResolvedValue({
      data: { telegramChatId: "-1001234567890" },
      error: null,
    });
    const getLineNotificationTarget = vi.fn().mockResolvedValue({
      data: { targetId: "line-group-id", targetType: "group" },
      error: null,
    });
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(new Response("{}", { status: 200 })),
    );

    process.env.LINE_CHANNEL_ACCESS_TOKEN = "line-token";
    process.env.TELEGRAM_BOT_TOKEN = "telegram-token";
    vi.resetModules();
    vi.stubGlobal("fetch", fetchMock);
    vi.doMock("next/server", () => ({
      after: (callback: () => unknown) => {
        afterTasks.push(Promise.resolve(callback()));
      },
    }));
    vi.doMock("@/modules/billing/billing-service", () => ({
      getOrganizationBillingState: vi.fn().mockResolvedValue({ plan: "premium", status: "active" }),
    }));
    vi.doMock("@/modules/billing/types", () => ({
      DEFAULT_BILLING_STATE: { plan: "premium", status: "active" },
      getPlanFeatures: vi.fn(() => ({ lineNotify: true })),
    }));
    vi.doMock("@/modules/notifications/repository", () => ({
      getLineNotificationTarget,
      getNotificationSetting,
      getTelegramNotificationTarget,
    }));

    try {
      const { notifyOwnerSafely } = await import("@/modules/notifications/dispatcher");
      notifyOwnerSafely({
        type: "payment",
        organizationId: "org-1",
        storeId: "store-1",
        message: "paid",
      });
      await Promise.all(afterTasks);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
        "https://api.line.me/v2/bot/message/push",
        "https://api.telegram.org/bottelegram-token/sendMessage",
      ]);
      expect(getNotificationSetting).toHaveBeenCalledWith(
        "store-1",
        "org-1",
        "payment",
        "line",
        { useServiceRole: true },
      );
      expect(getNotificationSetting).toHaveBeenCalledWith(
        "store-1",
        "org-1",
        "payment",
        "telegram",
        { useServiceRole: true },
      );

      afterTasks.length = 0;
      fetchMock.mockClear();
      getNotificationSetting.mockClear();
      notifyOwnerSafely({
        type: "payment",
        channel: "telegram",
        organizationId: "org-1",
        storeId: "store-1",
        message: "paid",
      });
      await Promise.all(afterTasks);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(String(fetchMock.mock.calls[0][0])).toBe("https://api.telegram.org/bottelegram-token/sendMessage");
      expect(getNotificationSetting).toHaveBeenCalledWith(
        "store-1",
        "org-1",
        "payment",
        "telegram",
        { useServiceRole: true },
      );
      expect(getNotificationSetting).not.toHaveBeenCalledWith(
        "store-1",
        "org-1",
        "payment",
        "line",
        { useServiceRole: true },
      );
    } finally {
      if (oldLineToken === undefined) {
        delete process.env.LINE_CHANNEL_ACCESS_TOKEN;
      } else {
        process.env.LINE_CHANNEL_ACCESS_TOKEN = oldLineToken;
      }
      if (oldTelegramToken === undefined) {
        delete process.env.TELEGRAM_BOT_TOKEN;
      } else {
        process.env.TELEGRAM_BOT_TOKEN = oldTelegramToken;
      }
      vi.doUnmock("next/server");
      vi.doUnmock("@/modules/billing/billing-service");
      vi.doUnmock("@/modules/billing/types");
      vi.doUnmock("@/modules/notifications/repository");
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  });

  it("starts Telegram owner delivery even when LINE delivery is still pending", async () => {
    const oldLineToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
    const oldTelegramToken = process.env.TELEGRAM_BOT_TOKEN;
    const afterTasks: Promise<unknown>[] = [];
    let resolveLineFetch: (response: Response) => void = () => {};
    const pendingLineFetch = new Promise<Response>((resolve) => {
      resolveLineFetch = resolve;
    });
    const getNotificationSetting = vi.fn().mockResolvedValue({ data: { enabled: true }, error: null });
    const getTelegramNotificationTarget = vi.fn().mockResolvedValue({
      data: { telegramChatId: "-1001234567890" },
      error: null,
    });
    const getLineNotificationTarget = vi.fn().mockResolvedValue({
      data: { targetId: "line-group-id", targetType: "group" },
      error: null,
    });
    const fetchMock = vi.fn().mockImplementation((url: string | URL | Request) => {
      if (String(url).includes("api.line.me")) {
        return pendingLineFetch;
      }
      return Promise.resolve(new Response("{}", { status: 200 }));
    });

    process.env.LINE_CHANNEL_ACCESS_TOKEN = "line-token";
    process.env.TELEGRAM_BOT_TOKEN = "telegram-token";
    vi.resetModules();
    vi.stubGlobal("fetch", fetchMock);
    vi.doMock("next/server", () => ({
      after: (callback: () => unknown) => {
        afterTasks.push(Promise.resolve(callback()));
      },
    }));
    vi.doMock("@/modules/billing/billing-service", () => ({
      getOrganizationBillingState: vi.fn().mockResolvedValue({ plan: "premium", status: "active" }),
    }));
    vi.doMock("@/modules/billing/types", () => ({
      DEFAULT_BILLING_STATE: { plan: "premium", status: "active" },
      getPlanFeatures: vi.fn(() => ({ lineNotify: true })),
    }));
    vi.doMock("@/modules/notifications/repository", () => ({
      getLineNotificationTarget,
      getNotificationSetting,
      getTelegramNotificationTarget,
    }));

    try {
      const { notifyOwnerSafely } = await import("@/modules/notifications/dispatcher");
      notifyOwnerSafely({
        type: "payment",
        organizationId: "org-1",
        storeId: "store-1",
        message: "paid",
      });

      // ปล่อย microtask ให้ครบทั้งขั้นเตรียมข้อความ (ชื่อร้าน/template) + การส่งแต่ละช่องทาง
      // ทั้งสองช่องทางถูก fan-out พร้อมกัน LINE ที่ค้างจึงไม่บล็อก Telegram
      for (let attempt = 0; attempt < 30; attempt += 1) {
        await Promise.resolve();
      }

      expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual(
        expect.arrayContaining([
          "https://api.line.me/v2/bot/message/push",
          "https://api.telegram.org/bottelegram-token/sendMessage",
        ]),
      );
    } finally {
      resolveLineFetch(new Response("{}", { status: 200 }));
      await Promise.allSettled(afterTasks);
      if (oldLineToken === undefined) {
        delete process.env.LINE_CHANNEL_ACCESS_TOKEN;
      } else {
        process.env.LINE_CHANNEL_ACCESS_TOKEN = oldLineToken;
      }
      if (oldTelegramToken === undefined) {
        delete process.env.TELEGRAM_BOT_TOKEN;
      } else {
        process.env.TELEGRAM_BOT_TOKEN = oldTelegramToken;
      }
      vi.doUnmock("next/server");
      vi.doUnmock("@/modules/billing/billing-service");
      vi.doUnmock("@/modules/billing/types");
      vi.doUnmock("@/modules/notifications/repository");
      vi.unstubAllGlobals();
      vi.resetModules();
    }
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
    expect(dispatcher).toContain("const channels = input.channel ? [input.channel] : NOTIFICATION_CHANNELS");
    expect(dispatcher).toContain("Promise.allSettled");
    expect(dispatcher).toContain("runOwnerNotificationDelivery({");
    expect(dispatcher).toContain("channel,");
    expect(dispatcher).not.toContain('channel: input.channel ?? "line"');
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
    const attendanceActions = read("src/app/(dashboard)/attendance/actions.ts");
    const buffetRepository = read("src/modules/buffet/repository.ts");
    const dispatcher = read("src/modules/notifications/dispatcher.ts");
    const settingsPage = read("src/app/(dashboard)/settings/notifications/page.tsx");
    const settingsActions = read("src/app/(dashboard)/settings/notifications/actions.ts");
    const telegramMigration = read("supabase/migrations/20260613000001_telegram_notification_targets.sql");

    expect(types).toContain("| \"new_pos_order\"");
    expect(types).toContain("| \"new_buffet_order\"");
    expect(types).toContain("| \"order_cancelled\"");
    expect(types).toContain("| \"service_request\"");
    expect(types).toContain("| \"attendance_clock_in\"");
    expect(types).toContain("| \"attendance_clock_out\"");
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
    expect(attendanceActions).toContain("notifyOwnerSafely");
    expect(attendanceActions).toContain("type: \"attendance_clock_in\"");
    expect(attendanceActions).toContain("type: \"attendance_clock_out\"");
    expect(settingsPage).toContain("พนักงานเข้างาน");
    expect(settingsPage).toContain("พนักงานออกงาน");
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

  it("adds LINE account binding schema, provider helpers, and webhook routes", () => {
    const migration = readIfExists("supabase/migrations/20260620000001_line_account_binding.sql");
    const types = read("src/server/integrations/supabase/database.types.ts");
    const repository = read("src/modules/notifications/repository.ts");
    const line = readIfExists("src/modules/notifications/line.ts");
    const dispatcher = read("src/modules/notifications/dispatcher.ts");
    const webhook = readIfExists("src/app/api/line/webhook/route.ts");
    const accountLink = readIfExists("src/app/api/line/account-link/start/route.ts");
    const middleware = read("src/server/integrations/supabase/middleware.ts");
    const envExample = read(".env.example");

    expect(envExample).toContain("LINE_CHANNEL_ACCESS_TOKEN=");
    expect(envExample).toContain("LINE_CHANNEL_SECRET=");
    expect(envExample).toContain("LINE_OFFICIAL_ACCOUNT_ID=");
    expect(envExample).toContain("LINE_ADD_FRIEND_URL=");
    expect(envExample).toContain("LINE_ACCOUNT_LINK_BASE_URL=");
    expect(envExample).not.toContain("LINE Notify");

    expect(migration).toContain("create table if not exists line_account_links");
    expect(migration).toContain("create table if not exists line_account_link_sessions");
    expect(migration).toContain("line_user_id text not null");
    expect(migration).toContain("nonce_hash text not null");
    expect(migration).toContain("expires_at timestamptz not null");
    expect(migration).toContain("consumed_at timestamptz");
    expect(migration).toContain("unique (organization_id, user_id)");
    expect(migration).toContain("line_account_links_active_line_user_id_uidx");
    expect(migration).toContain("where status = 'active'");
    expect(migration).toContain("auth_user_role_in_org(organization_id, 'owner')");
    expect(types).toContain("line_account_links:");
    expect(types).toContain("line_account_link_sessions:");

    expect(repository).toContain("getLineAccountLink");
    expect(repository).toContain("createLineAccountLinkSession");
    expect(repository).toContain("consumeLineAccountLinkSession");
    expect(repository).toContain("upsertLineAccountLink");
    expect(repository).toContain("unlinkLineAccount");
    expect(repository).toContain(".from(\"memberships\")");
    expect(repository).toContain(".eq(\"role\", \"owner\")");
    expect(repository).not.toContain(".limit(1)\n    .maybeSingle()");

    expect(line).toContain("verifyLineSignature");
    expect(line).toContain("createHmac(\"sha256\"");
    expect(line).toContain("timingSafeEqual");
    expect(line).toContain("buildLinePushMessageRequest");
    expect(line).toContain("buildLineReplyMessageRequest");
    expect(line).toContain("buildLineIssueLinkTokenRequest");
    expect(line).toContain("https://api.line.me/v2/bot/message/push");
    expect(line).toContain("https://api.line.me/v2/bot/message/reply");
    expect(line).toContain("https://api.line.me/v2/bot/user/");

    expect(dispatcher).toContain("resolveLineNotificationTarget");
    expect(dispatcher).toContain("sendLinePushMessage");
    expect(dispatcher).toContain("LINE_CHANNEL_ACCESS_TOKEN");

    expect(webhook).toContain("request.text()");
    expect(webhook).toContain("x-line-signature");
    expect(webhook).toContain("verifyLineSignature");
    expect(webhook).toContain("accountLink");
    expect(webhook).toContain("parseLineWebhookBody");
    expect(webhook).toContain("return null");
    expect(webhook).toContain("buildLineIssueLinkTokenRequest");
    expect(webhook).toContain("return NextResponse.json({ ok: true })");
    expect(webhook).not.toContain("console.log");
    expect(middleware).toContain('request.nextUrl.pathname === "/api/line/webhook"');

    expect(accountLink).toContain("getCurrentUser");
    expect(accountLink).toContain("getResolvedCurrentPermissions");
    expect(accountLink).toContain('ctx.role !== "owner"');
    expect(accountLink).toContain('settingsRedirect(request, "owner")');
    expect(accountLink).toContain("createLineAccountLinkSession");
    expect(accountLink).toContain("https://access.line.me/dialog/bot/accountLink");
    expect(accountLink).toContain("LINE_ACCOUNT_LINK_BASE_URL");
  });

  it("adds LINE binding UI after signup and in notification settings", () => {
    const page = read("src/app/(dashboard)/settings/notifications/page.tsx");
    const panel = readIfExists("src/app/(dashboard)/settings/notifications/LineAccountLinkPanel.tsx");
    const actions = read("src/app/(dashboard)/settings/notifications/actions.ts");
    const register = read("src/app/(auth)/register/actions.ts");
    const onboarding = read("src/app/onboarding/page.tsx");
    const dialog = readIfExists("src/app/onboarding/LineAddDialog.tsx");

    expect(page).toContain("LineAccountLinkPanel");
    expect(page).toContain("getLineAccountLink");
    expect(panel).toContain("ยังไม่ได้ผูก LINE");
    expect(panel).toContain("ผูก LINE แล้ว");
    expect(panel).toContain("LINE_ADD_FRIEND_URL");
    expect(panel).toContain("LINE_OFFICIAL_ACCOUNT_ID");
    expect(panel).not.toContain("/settings/notifications?lineLink=1");
    expect(panel).not.toContain("LINE_CHANNEL_ACCESS_TOKEN");
    expect(panel).not.toContain("LINE_CHANNEL_SECRET");
    expect(actions).toContain("unlinkLineAccountAction");
    expect(actions).toContain("unlinkLineAccount");

    expect(register).toContain('redirect("/onboarding?linePrompt=1")');
    expect(onboarding).toContain("LineAddDialog");
    expect(onboarding).toContain("linePrompt");
    expect(dialog).toContain("Add LINE");
    expect(dialog).toContain("ไปตั้งค่าแจ้งเตือน");
    expect(dialog).toContain("/settings/notifications?lineLink=1");
    expect(dialog).not.toContain("LINE_CHANNEL_ACCESS_TOKEN");
    expect(dialog).not.toContain("LINE_CHANNEL_SECRET");
  });

  it("adds LINE group and multi-person chat notification targets", () => {
    const migration = readMigrationContaining("line_notification_targets");
    const hardeningMigration = readIfExists("supabase/migrations/20260620150128_line_notification_rls_hardening.sql");
    const types = read("src/server/integrations/supabase/database.types.ts");
    const repository = read("src/modules/notifications/repository.ts");
    const dispatcher = read("src/modules/notifications/dispatcher.ts");
    const webhook = readIfExists("src/app/api/line/webhook/route.ts");
    const page = read("src/app/(dashboard)/settings/notifications/page.tsx");
    const panel = readIfExists("src/app/(dashboard)/settings/notifications/LineAccountLinkPanel.tsx");
    const actions = read("src/app/(dashboard)/settings/notifications/actions.ts");

    expect(migration).toContain("create table if not exists line_notification_targets");
    expect(migration).toContain("target_type text not null");
    expect(migration).toContain("target_id text not null");
    expect(migration).toContain("target_type in ('group', 'room')");
    expect(migration).toContain("unique (organization_id, target_type)");
    expect(migration).toContain("line_notification_targets_active_target_id_uidx");
    expect(migration).toContain("line_notification_targets_active_organization_id_uidx");
    expect(migration).toContain("on line_notification_targets(organization_id)");
    expect(migration).toContain("where status = 'active'");
    expect(migration).toContain("create or replace function upsert_line_notification_target");
    expect(migration).toContain("for update");
    expect(migration).toContain("from memberships");
    expect(migration).toContain("user_id = p_linked_by");
    expect(migration).toContain("role = 'owner'");
    expect(migration).toContain("raise exception 'LINE_TARGET_ALREADY_LINKED'");
    expect(migration).toContain("update line_notification_targets");
    expect(migration).toContain("revoke all on function upsert_line_notification_target(uuid, uuid, text, text) from public, anon, authenticated");
    expect(migration).toContain("grant execute on function upsert_line_notification_target(uuid, uuid, text, text) to service_role");
    expect(migration).toContain("auth_user_role_in_org(organization_id, 'owner')");
    expect(migration).not.toContain("line_notification_targets: owner can update");
    expect(hardeningMigration).toContain('drop policy if exists "line_account_links: owner can update" on line_account_links');
    expect(hardeningMigration).toContain('drop policy if exists "line_notification_targets: owner can update" on line_notification_targets');
    expect(hardeningMigration).toContain("revoke update on table line_account_links from anon, authenticated");
    expect(hardeningMigration).toContain("revoke update on table line_notification_targets from anon, authenticated");
    expect(types).toContain("line_notification_targets:");

    expect(repository).toContain("getLineGroupNotificationTarget");
    expect(repository).toContain("getLineOwnerAccountLinkByLineUserId");
    expect(repository).toContain(".eq(\"role\", \"owner\")");
    expect(repository).toContain(".not(\"joined_at\", \"is\", null)");
    expect(repository).toContain("upsertLineNotificationTarget");
    expect(repository).toContain('supabase.rpc("upsert_line_notification_target"');
    const upsertFunction = repository.slice(
      repository.indexOf("export async function upsertLineNotificationTarget"),
      repository.indexOf("export async function unlinkLineAccount"),
    );
    expect(upsertFunction).not.toContain('.from("line_notification_targets")');
    expect(upsertFunction).not.toContain(".update(");
    expect(repository).toContain(".update({");
    expect(repository).toContain("status: \"unlinked\"");
    expect(repository).toContain("unlinkLineNotificationTarget");
    expect(repository).toContain(".from(\"line_notification_targets\")");
    expect(repository).toContain(".order(\"linked_at\", { ascending: false })");

    expect(dispatcher).toContain("targetId");
    expect(dispatcher).toContain("targetType");
    expect(dispatcher).toContain("getLineNotificationTarget");
    expect(dispatcher).toContain("sendLinePushMessage(token, target.targetId");

    expect(webhook).toContain("groupId?: string");
    expect(webhook).toContain("roomId?: string");
    expect(webhook).toContain("shouldBindGroup");
    expect(webhook).toContain("ผูกกลุ่ม");
    expect(webhook).toContain("getLineOwnerAccountLinkByLineUserId");
    expect(webhook).toContain("ต้องเป็น owner");
    expect(webhook).toContain("upsertLineNotificationTarget");
    expect(webhook).toContain("LINE group");
    expect(webhook).toContain("multi-person");

    expect(page).toContain("getLineGroupNotificationTarget");
    expect(page).toContain("lineNotificationTarget=");
    expect(panel).toContain("LINE group / multi-person chat");
    expect(panel).toContain("ผูกกลุ่ม");
    expect(panel).toContain("ยกเลิกการผูก LINE กลุ่ม");
    expect(actions).toContain("unlinkLineNotificationTargetAction");
    expect(actions).toContain("unlinkLineNotificationTarget");
    expect(actions).toContain("ต้องเป็น owner จึงจะจัดการ LINE group ได้");
  });
});
