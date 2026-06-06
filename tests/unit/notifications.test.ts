import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dispatchNotification, validateNotificationPayload } from "@/modules/notifications/dispatcher";

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");

describe("notification dispatcher", () => {
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
    expect(result.message).toContain("provider token is not configured");
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
    expect(page).toContain("toggleNotificationSettingAction");
    expect(page).toContain("name=\"enabled\"");
    expect(page).toContain("disabled={!canManage || settingsLoadFailed}");
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
});
