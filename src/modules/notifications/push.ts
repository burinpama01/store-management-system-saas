import { createSign } from "node:crypto";
import type { NotificationPayload } from "./types";

/**
 * FCM HTTP v1 client — เซ็น JWT ด้วย service account (env FIREBASE_SERVICE_ACCOUNT)
 * แล้วแลก OAuth access token เอง เพื่อไม่ต้องลาก firebase-admin ทั้งก้อนเข้า bundle
 */

export interface FirebaseServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
}

const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const TOKEN_SAFETY_WINDOW_SECONDS = 60;
const PUSH_DELIVERY_TIMEOUT_MS = 5_000;

let cachedAccessToken: { token: string; expiresAt: number } | null = null;

export function parseServiceAccount(raw: string | undefined): FirebaseServiceAccount | null {
  if (!raw) return null;
  try {
    const json = JSON.parse(raw) as Partial<FirebaseServiceAccount>;
    if (!json.project_id || !json.client_email || !json.private_key) return null;
    return {
      project_id: json.project_id,
      client_email: json.client_email,
      // env หลายระบบ escape newline ใน private key มาเป็น \n ตัวอักษร
      private_key: json.private_key.replace(/\\n/g, "\n"),
    };
  } catch {
    return null;
  }
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=+$/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

export function buildServiceAccountJwt(
  account: FirebaseServiceAccount,
  nowSeconds = Math.floor(Date.now() / 1000),
): string {
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(
    JSON.stringify({
      iss: account.client_email,
      scope: FCM_SCOPE,
      aud: OAUTH_TOKEN_URL,
      iat: nowSeconds,
      exp: nowSeconds + 3600,
    }),
  );
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  const signature = base64url(signer.sign(account.private_key));
  return `${header}.${claims}.${signature}`;
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), PUSH_DELIVERY_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function getAccessToken(account: FirebaseServiceAccount): Promise<string | null> {
  const now = Math.floor(Date.now() / 1000);
  if (cachedAccessToken && cachedAccessToken.expiresAt - TOKEN_SAFETY_WINDOW_SECONDS > now) {
    return cachedAccessToken.token;
  }

  const jwt = buildServiceAccountJwt(account, now);
  let response: Response;
  try {
    response = await fetchWithTimeout(OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: jwt,
      }).toString(),
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;

  const json = (await response.json()) as { access_token?: string; expires_in?: number };
  if (!json.access_token) return null;
  cachedAccessToken = {
    token: json.access_token,
    expiresAt: now + (json.expires_in ?? 3600),
  };
  return json.access_token;
}

export interface FcmMessageBody {
  message: {
    token: string;
    notification: { title: string; body: string };
    android: { priority: "high" | "normal" };
    apns: { payload: { aps: { sound: string } } };
    data?: Record<string, string>;
  };
}

export function buildFcmMessage(deviceToken: string, input: NotificationPayload): FcmMessageBody {
  return {
    message: {
      token: deviceToken,
      notification: {
        title: input.title?.trim() || "StoreOS",
        body: input.message.trim(),
      },
      android: { priority: "high" },
      apns: { payload: { aps: { sound: "default" } } },
      data: {
        type: input.type,
        ...(input.storeId ? { storeId: input.storeId } : {}),
      },
    },
  };
}

export type PushSendOutcome = "sent" | "unregistered" | "failed";

/** ส่งหา 1 device; "unregistered" = token ตายแล้ว ผู้เรียกควรลบทิ้ง */
export async function sendFcmToDevice(
  account: FirebaseServiceAccount,
  deviceToken: string,
  input: NotificationPayload,
): Promise<PushSendOutcome> {
  const accessToken = await getAccessToken(account);
  if (!accessToken) return "failed";

  let response: Response;
  try {
    response = await fetchWithTimeout(
      `https://fcm.googleapis.com/v1/projects/${account.project_id}/messages:send`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(buildFcmMessage(deviceToken, input)),
      },
    );
  } catch {
    return "failed";
  }

  if (response.ok) return "sent";
  // 404 UNREGISTERED / 400 invalid token → ลบ token ออกจากระบบ
  if (response.status === 404 || response.status === 400) return "unregistered";
  return "failed";
}

/** สำหรับ unit test เท่านั้น */
export function resetPushTokenCacheForTests() {
  cachedAccessToken = null;
}
