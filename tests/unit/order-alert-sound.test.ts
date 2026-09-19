import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ORDER_ALERT_ANDROID_CHANNEL,
  ORDER_ALERT_ANDROID_SOUND,
  buildFcmMessage,
} from "@/modules/notifications/push";
import { NOTIFICATION_TYPES } from "@/modules/notifications/types";
import { NOTIFICATION_TEMPLATE_VARS, renderNotificationTemplate } from "@/modules/notifications/templates";
import {
  ORDER_ALERT_SOUND_URL,
  alertPatternForTypes,
} from "@/shared/notifications/alert-sound";

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");

describe("order alert push (Android channel + sound)", () => {
  it.each(["new_qr_order", "new_buffet_order", "new_delivery_order"] as const)(
    "%s uses the order channel with the AlertNewOrder sound",
    (type) => {
      const body = buildFcmMessage("tok", { type, message: "ออเดอร์ใหม่" });
      expect(body.message.android).toEqual({
        priority: "high",
        notification: {
          channel_id: ORDER_ALERT_ANDROID_CHANNEL,
          sound: ORDER_ALERT_ANDROID_SOUND,
          default_vibrate_timings: true,
        },
      });
    },
  );

  it("other notifications keep the default channel/sound", () => {
    const body = buildFcmMessage("tok", { type: "stock_alert", message: "ของใกล้หมด" });
    expect(body.message.android).toEqual({ priority: "high" });
  });

  it("the Android app ships the sound and creates the same channel id", () => {
    expect(existsSync(join(root, "mobile/android/app/src/main/res/raw/alert_new_order.mp3"))).toBe(true);
    const activity = read("mobile/android/app/src/main/java/com/storeos/app/MainActivity.java");
    expect(activity).toContain(`ORDER_CHANNEL_ID = "${ORDER_ALERT_ANDROID_CHANNEL}"`);
    expect(activity).toContain(`R.raw.${ORDER_ALERT_ANDROID_SOUND}`);
    expect(activity).toContain("IMPORTANCE_HIGH");
    const gradle = read("mobile/android/app/build.gradle");
    expect(gradle).toContain("versionCode 3");
    expect(gradle).toContain('versionName "1.0.2"');
  });
});

describe("in-app order alert sound", () => {
  it("serves the AlertNewOrder file publicly (middleware must not redirect .mp3)", () => {
    expect(existsSync(join(root, "public", ORDER_ALERT_SOUND_URL))).toBe(true);
    expect(read("src/proxy.ts")).toContain("webp|zip|mp3)$");
  });

  it("uses the order sound only for new-order notifications", () => {
    expect(alertPatternForTypes(["new_qr_order"])).toBe("order");
    expect(alertPatternForTypes(["stock_alert", "new_delivery_order"])).toBe("order");
    expect(alertPatternForTypes(["stock_alert"])).toBe("connect");
    expect(alertPatternForTypes([])).toBe("connect");
  });

  it("QR and delivery dialogs ring with the order sound", () => {
    expect(read("src/app/(dashboard)/QrOrderGlobalNotifier.tsx")).toContain(
      'useRepeatingAlert(Boolean(currentOrder), "order", {',
    );
    expect(read("src/app/(dashboard)/DeliveryGlobalNotifier.tsx")).toContain(
      'useRepeatingAlert(Boolean(current), "order", {',
    );
    const toasts = read("src/app/(dashboard)/NotificationGlobalNotifier.tsx");
    expect(toasts).toContain('"new_delivery_order"]);');
    expect(toasts).toContain("alertPatternForTypes(fresh.map((item) => item.type))");
  });
});

describe("new_delivery_order notification type", () => {
  it("is registered in the notification matrix and has a template", () => {
    expect(NOTIFICATION_TYPES).toContain("new_delivery_order");
    expect(NOTIFICATION_TEMPLATE_VARS.new_delivery_order).toEqual(["store", "platform", "orderNumber", "total"]);
  });

  it("migration allows the new type on settings and templates", () => {
    const sql = read("supabase/migrations/20260919010000_new_delivery_order_notification.sql");
    expect(sql.match(/^\s+'new_delivery_order',$/gm)).toHaveLength(2);
    expect(sql).toContain("notification_settings_notification_type_check");
    expect(sql).toContain("notification_templates_notification_type_check");
    // ต้องไม่ทำชนิดเดิมหาย
    for (const type of NOTIFICATION_TYPES) expect(sql).toContain(`'${type}'`);
  });

  it("delivery ingestion notifies once per new booking (after the duplicate check)", () => {
    const ingestion = read("src/modules/connect/order-ingestion.ts");
    const duplicateCheck = ingestion.indexOf("return { ok: true, duplicate: true");
    const notify = ingestion.indexOf('type: "new_delivery_order"');
    expect(duplicateCheck).toBeGreaterThan(-1);
    expect(notify).toBeGreaterThan(duplicateCheck);
    expect(ingestion).toContain("notifyOwnerSafely({");
  });

  it("renders the delivery template", () => {
    expect(
      renderNotificationTemplate("{platform} ออเดอร์ {orderNumber} ยอด {total}", {
        platform: "JDC",
        orderNumber: "JDC-ABC",
        total: 120,
      }),
    ).toBe("JDC ออเดอร์ JDC-ABC ยอด 120");
  });
});
