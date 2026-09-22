import { describe, expect, it } from "vitest";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { dispatchNotification } from "@/modules/notifications/dispatcher";
import {
  INSISTENT_ORDER_ALERT,
  buildFcmMessage,
  buildServiceAccountJwt,
  parseServiceAccount,
} from "@/modules/notifications/push";
import { NOTIFICATION_CHANNELS, NOTIFICATION_TYPES, STAFF_PUSH_NOTIFICATION_TYPES, isPushRecipientRole } from "@/modules/notifications/types";
import { filterPushEligibleUserIds } from "@/modules/notifications/repository";

const root = process.cwd();
const readMigrationContaining = (needle: string) => {
  const migrationsDir = join(root, "supabase/migrations");
  const fileName = readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .find((name) => readFileSync(join(migrationsDir, name), "utf8").includes(needle));
  return fileName
    ? readFileSync(join(migrationsDir, fileName), "utf8").replace(/\r\n/g, "\n")
    : "";
};

describe("push notification channel", () => {
  it("registers push in notification channels", () => {
    expect(NOTIFICATION_CHANNELS).toContain("push");
  });

  it("parseServiceAccount rejects invalid input", () => {
    expect(parseServiceAccount(undefined)).toBeNull();
    expect(parseServiceAccount("not json")).toBeNull();
    expect(parseServiceAccount(JSON.stringify({ project_id: "p" }))).toBeNull();
  });

  it("parseServiceAccount tolerates a leading BOM + whitespace (PowerShell/CLI env pipe)", () => {
    const account = {
      project_id: "storeos-test",
      client_email: "svc@storeos-test.iam.gserviceaccount.com",
      private_key: "-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----\\n",
    };
    //  (BOM) นำหน้าคือสาเหตุที่ทำให้ push แสดง "ยังไม่พร้อมใช้งาน" บน prod
    const parsed = parseServiceAccount("\uFEFF" + JSON.stringify(account) + "\n");
    expect(parsed?.project_id).toBe("storeos-test");
    expect(parsed?.client_email).toBe(account.client_email);
  });

  it("parseServiceAccount unescapes newlines in private key", () => {
    const parsed = parseServiceAccount(
      JSON.stringify({
        project_id: "storeos-test",
        client_email: "svc@storeos-test.iam.gserviceaccount.com",
        private_key: "-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----\\n",
      }),
    );
    expect(parsed?.private_key).toContain("\n");
    expect(parsed?.private_key).not.toContain("\\n");
  });

  it("buildServiceAccountJwt produces a verifiable RS256 JWT", () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const now = 1_800_000_000;
    const jwt = buildServiceAccountJwt(
      {
        project_id: "storeos-test",
        client_email: "svc@storeos-test.iam.gserviceaccount.com",
        private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      },
      now,
    );

    const [header, claims, signature] = jwt.split(".");
    expect(header).toBeTruthy();
    expect(claims).toBeTruthy();
    expect(signature).toBeTruthy();

    const decodedClaims = JSON.parse(Buffer.from(claims, "base64url").toString());
    expect(decodedClaims.iss).toBe("svc@storeos-test.iam.gserviceaccount.com");
    expect(decodedClaims.scope).toContain("firebase.messaging");
    expect(decodedClaims.exp).toBe(now + 3600);

    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${header}.${claims}`);
    expect(
      verifier.verify(publicKey, Buffer.from(signature, "base64url")),
    ).toBe(true);
  });

  it("buildFcmMessage falls back to StoreOS title and carries metadata", () => {
    const body = buildFcmMessage("device-token-1", {
      type: "new_qr_order",
      message: "ออเดอร์ใหม่โต๊ะ 5",
      storeId: "store-1",
    });
    expect(body.message.token).toBe("device-token-1");
    expect(body.message.notification?.title).toBe("StoreOS");
    expect(body.message.notification?.body).toBe("ออเดอร์ใหม่โต๊ะ 5");
    expect(body.message.android.priority).toBe("high");
    expect(body.message.data).toMatchObject({ type: "new_qr_order", storeId: "store-1" });
  });

  it("Android 1.0.3+ gets new orders as data-only so the app can ring until opened", () => {
    const order = { type: "new_qr_order" as const, title: "ออเดอร์ใหม่", message: "โต๊ะ 5", storeId: "store-1" };
    const insistent = buildFcmMessage({ token: "t", platform: "android", appVersion: "1.0.3" }, order);
    expect(insistent.message.notification).toBeUndefined();
    expect(insistent.message.android).toEqual({ priority: "high" });
    expect(insistent.message.data).toMatchObject({
      type: "new_qr_order",
      alert: INSISTENT_ORDER_ALERT,
      title: "ออเดอร์ใหม่",
      body: "โต๊ะ 5",
    });

    // รุ่นเก่า / ไม่รู้รุ่น / iOS / แจ้งเตือนที่ไม่ใช่ออเดอร์ ต้องได้ notification block ตามเดิม
    for (const device of [
      { token: "t", platform: "android" as const, appVersion: "1.0.2" },
      { token: "t", platform: "android" as const, appVersion: "0" },
      { token: "t", platform: "android" as const, appVersion: null },
      { token: "t", platform: "ios" as const, appVersion: "1.0.3" },
    ]) {
      expect(buildFcmMessage(device, order).message.notification).toBeDefined();
    }
    const nonOrder = buildFcmMessage(
      { token: "t", platform: "android", appVersion: "1.0.3" },
      { type: "service_request", message: "เรียกพนักงาน" },
    );
    expect(nonOrder.message.notification).toBeDefined();
    expect(nonOrder.message.data?.alert).toBeUndefined();
  });

  it("skips push delivery when service account is not configured", async () => {
    const old = process.env.FIREBASE_SERVICE_ACCOUNT;
    delete process.env.FIREBASE_SERVICE_ACCOUNT;
    const result = await dispatchNotification({
      type: "test",
      channel: "push",
      message: "[TEST] push notification",
    });
    if (old !== undefined) process.env.FIREBASE_SERVICE_ACCOUNT = old;

    expect(result.ok).toBe(true);
    expect(result.skipped).toBe(true);
    expect(result.message).toContain("ช่องทาง Push ยังไม่พร้อมใช้งาน");
  });

  it("migration creates device_push_tokens with RLS and extends channel check", () => {
    const migration = readMigrationContaining("device_push_tokens");
    expect(migration).toContain("create table if not exists device_push_tokens");
    expect(migration).toContain("enable row level security");
    expect(migration).toContain("user_id = auth.uid()");
    expect(migration).toContain("check (channel in ('line', 'telegram', 'push'))");
  });

  it("pushes operational notifications to cashier/staff devices", () => {
    for (const type of STAFF_PUSH_NOTIFICATION_TYPES) {
      expect(isPushRecipientRole(type, "cashier")).toBe(true);
      expect(isPushRecipientRole(type, "staff")).toBe(true);
      expect(isPushRecipientRole(type, "owner")).toBe(true);
    }
  });

  it("keeps business/HR notifications off cashier/staff devices", () => {
    const managementOnly = NOTIFICATION_TYPES.filter((type) => !STAFF_PUSH_NOTIFICATION_TYPES.has(type));
    // ประเภทใหม่ที่ยังไม่ถูกจัดกลุ่มต้อง default เป็น "ผู้บริหารเท่านั้น" ไม่ใช่รั่วไปพนักงาน
    expect(managementOnly).toEqual([
      "payment",
      "new_table",
      "new_delivery_order",
      "stock_alert",
      "attendance_clock_in",
      "attendance_clock_out",
      "approval",
      "activation_nudge",
      "subscription_expiring",
      "daily_summary",
    ]);
    for (const type of managementOnly) {
      expect(isPushRecipientRole(type, "cashier")).toBe(false);
      expect(isPushRecipientRole(type, "staff")).toBe(false);
      expect(isPushRecipientRole(type, "manager")).toBe(true);
      expect(isPushRecipientRole(type, "admin")).toBe(true);
      expect(isPushRecipientRole(type, "owner")).toBe(true);
      expect(isPushRecipientRole(type, "super_admin")).toBe(true);
    }
  });

  it("wires role filter into store push token lookup", () => {
    const repository = readFileSync(join(root, "src/modules/notifications/repository.ts"), "utf8").replace(/\r\n/g, "\n");
    const dispatcher = readFileSync(join(root, "src/modules/notifications/dispatcher.ts"), "utf8").replace(/\r\n/g, "\n");

    expect(repository).toContain("filterPushEligibleUserIds(memsRes.data ?? [], storeId, type)");
    expect(dispatcher).toContain("listStorePushTokens(input.organizationId, input.storeId, input.type)");
  });

  it("combines store scope and role per membership row for push eligibility", () => {
    // user เดียวมี 2 membership: cashier ประจำสาขา A + manager ประจำสาขา B
    const rows = [
      { user_id: "dual", store_id: "store-a", role: "cashier" as const },
      { user_id: "dual", store_id: "store-b", role: "manager" as const },
      { user_id: "org-owner", store_id: null, role: "owner" as const },
      { user_id: "org-cashier", store_id: null, role: "cashier" as const },
      { user_id: "other-branch", store_id: "store-c", role: "owner" as const },
    ];

    // อีเวนต์ธุรกิจ (เช่น daily_summary) ที่สาขา A: dual ไม่ได้ (แถว cashier ไม่ผ่าน role),
    // ที่สาขา B: dual ได้ผ่านแถว manager — ไม่มีสิทธิ์รั่วข้ามแถว/ข้ามสาขา
    expect(filterPushEligibleUserIds(rows, "store-a", "daily_summary")).toEqual(new Set(["org-owner"]));
    expect(filterPushEligibleUserIds(rows, "store-b", "daily_summary")).toEqual(new Set(["dual", "org-owner"]));

    // อีเวนต์หน้าร้าน (เช่น new_qr_order) ถึงทุก role ที่ครอบสาขา รวม org-wide cashier
    expect(filterPushEligibleUserIds(rows, "store-a", "new_qr_order")).toEqual(
      new Set(["dual", "org-owner", "org-cashier"]),
    );
    // สาขา C ไม่เกี่ยวกับอีเวนต์ของสาขา A แม้เป็น owner ของอีกสาขา
    expect(filterPushEligibleUserIds(rows, "store-a", "new_qr_order").has("other-branch")).toBe(false);
  });
});
