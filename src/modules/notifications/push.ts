import { createSign } from "node:crypto";
import { isOutdated } from "@/modules/mobile/android-version";
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
    // ตัด BOM (U+FEFF) + ช่องว่างหัวท้าย: การตั้ง env ผ่าน PowerShell pipe / บาง CLI
    // มักแทรก BOM นำหน้า ทำให้ JSON.parse พัง แล้ว push แสดง "ยังไม่พร้อมใช้งาน"
    const cleaned = raw.trim();
    const json = JSON.parse(cleaned) as Partial<FirebaseServiceAccount>;
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

/**
 * ช่องแจ้งเตือน Android ของออเดอร์ใหม่ — สร้างใน MainActivity (แอป 1.0.2+) พร้อมเสียง
 * res/raw/alert_new_order.mp3; แอปเวอร์ชันเก่าที่ไม่มีช่องนี้ Android ใช้ช่องสำรองของ FCM เอง
 * (เปลี่ยนไฟล์เสียงในอนาคต = ต้องใช้ id ใหม่ เพราะ Android ล็อกเสียงของช่องไว้)
 */
export const ORDER_ALERT_ANDROID_CHANNEL = "storeos_orders";
export const ORDER_ALERT_ANDROID_SOUND = "alert_new_order";
const ORDER_PUSH_TYPES: ReadonlySet<NotificationPayload["type"]> = new Set([
  "new_qr_order",
  "new_buffet_order",
  "new_delivery_order",
]);

/**
 * แอป Android ตั้งแต่รุ่นนี้มี OrderAlertMessagingService: รับออเดอร์ใหม่แบบ data-only แล้วสร้าง
 * แจ้งเตือนเสียงดังวน (FLAG_INSISTENT) จนกว่าจะแตะ/เปิดแอป — แจ้งเตือนที่ระบบแสดงเองดังได้รอบเดียว
 * รุ่นเก่าต้องได้ notification block ตามเดิม ไม่งั้นข้อความ data-only จะหายเงียบตอนแอปอยู่เบื้องหลัง
 */
export const ANDROID_INSISTENT_ORDER_ALERT_MIN_VERSION = "1.0.3";
export const INSISTENT_ORDER_ALERT = "order_insistent";

export interface PushDeviceTarget {
  readonly token: string;
  readonly platform: "android" | "ios";
  readonly appVersion: string | null;
}

export function supportsInsistentOrderAlert(device: PushDeviceTarget): boolean {
  return (
    device.platform === "android" &&
    Boolean(device.appVersion) &&
    !isOutdated(device.appVersion!, ANDROID_INSISTENT_ORDER_ALERT_MIN_VERSION)
  );
}

export interface FcmMessageBody {
  message: {
    token: string;
    notification?: { title: string; body: string };
    android: {
      priority: "high" | "normal";
      notification?: { channel_id: string; sound: string; default_vibrate_timings: boolean };
    };
    apns: { payload: { aps: { sound: string } } };
    data?: Record<string, string>;
  };
}

export function buildFcmMessage(
  device: string | PushDeviceTarget,
  input: NotificationPayload,
): FcmMessageBody {
  const target: PushDeviceTarget =
    typeof device === "string" ? { token: device, platform: "android", appVersion: null } : device;
  const title = input.title?.trim() || "StoreOS";
  const body = input.message.trim();
  const data: Record<string, string> = {
    type: input.type,
    ...(input.storeId ? { storeId: input.storeId } : {}),
  };

  if (ORDER_PUSH_TYPES.has(input.type) && supportsInsistentOrderAlert(target)) {
    // data-only: ห้ามมี notification block ไม่งั้น Android แสดงเองและไม่ส่งเข้าแอป
    return {
      message: {
        token: target.token,
        android: { priority: "high" },
        apns: { payload: { aps: { sound: "default" } } },
        data: { ...data, alert: INSISTENT_ORDER_ALERT, title, body },
      },
    };
  }

  return {
    message: {
      token: target.token,
      notification: { title, body },
      android: ORDER_PUSH_TYPES.has(input.type)
        ? {
            priority: "high",
            notification: {
              channel_id: ORDER_ALERT_ANDROID_CHANNEL,
              sound: ORDER_ALERT_ANDROID_SOUND,
              default_vibrate_timings: true,
            },
          }
        : { priority: "high" },
      apns: { payload: { aps: { sound: "default" } } },
      data,
    },
  };
}

export type PushSendOutcome = "sent" | "unregistered" | "failed";

/** ส่งหา 1 device; "unregistered" = token ตายแล้ว ผู้เรียกควรลบทิ้ง */
export async function sendFcmToDevice(
  account: FirebaseServiceAccount,
  device: string | PushDeviceTarget,
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
        body: JSON.stringify(buildFcmMessage(device, input)),
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
