import { describe, expect, it } from "vitest";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { dispatchNotification } from "@/modules/notifications/dispatcher";
import {
  buildFcmMessage,
  buildServiceAccountJwt,
  parseServiceAccount,
} from "@/modules/notifications/push";
import { NOTIFICATION_CHANNELS } from "@/modules/notifications/types";

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
    expect(body.message.notification.title).toBe("StoreOS");
    expect(body.message.notification.body).toBe("ออเดอร์ใหม่โต๊ะ 5");
    expect(body.message.android.priority).toBe("high");
    expect(body.message.data).toMatchObject({ type: "new_qr_order", storeId: "store-1" });
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
});
