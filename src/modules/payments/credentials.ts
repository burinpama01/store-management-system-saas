import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import type {
  BeamCredentials,
  TrueMoneyManualCredentials,
  TrueMoneyOpenApiCredentials,
} from "./types";

/**
 * Phase A credential codec.
 * encryption_key_version = 0 → JSON plaintext prefix `v0:` (static EMV is store-scoped receive identity).
 *
 * Phase B Open API secrets use AES-256-GCM (`v1:aesgcm:`).
 * KEK: env `PAYMENTS_CREDENTIALS_KEK` (base64 32 bytes) or derived fallback for local/dev/tests only.
 */

const V0_PREFIX = "v0:";
const V1_AES_PREFIX = "v1:aesgcm:";

export function encodeTrueMoneyManualCredentials(creds: TrueMoneyManualCredentials): string {
  return V0_PREFIX + JSON.stringify({ staticEmvPayload: creds.staticEmvPayload.trim() });
}

export function decodeTrueMoneyManualCredentials(
  encrypted: string | null | undefined,
): TrueMoneyManualCredentials | null {
  if (!encrypted) return null;
  if (!encrypted.startsWith(V0_PREFIX)) return null;
  try {
    const parsed = JSON.parse(encrypted.slice(V0_PREFIX.length)) as { staticEmvPayload?: unknown };
    if (typeof parsed.staticEmvPayload !== "string" || !parsed.staticEmvPayload.trim()) return null;
    return { staticEmvPayload: parsed.staticEmvPayload.trim() };
  } catch {
    return null;
  }
}

function resolvePaymentsKek(): Buffer {
  const raw = process.env.PAYMENTS_CREDENTIALS_KEK?.trim();
  if (raw) {
    const fromB64 = Buffer.from(raw, "base64");
    if (fromB64.length === 32) return fromB64;
    // Allow hex 64-char
    if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, "hex");
    throw new Error("PAYMENTS_CREDENTIALS_KEK ต้องเป็น base64 32 ไบต์ หรือ hex 64 ตัวอักษร");
  }
  // Dev/test fallback — NOT for production secret strength.
  if (process.env.NODE_ENV === "production" && process.env.VERCEL_ENV === "production") {
    throw new Error("ยังไม่ได้ตั้ง PAYMENTS_CREDENTIALS_KEK สำหรับเข้ารหัส webhook secret");
  }
  return scryptSync("storeos-payments-dev-kek", "storeos-byo-payments", 32);
}

export function maskSecret(secret: string | null | undefined, visible = 4): string | null {
  if (!secret) return null;
  const s = secret.trim();
  if (!s) return null;
  if (s.length <= visible) return "•".repeat(Math.max(s.length, 4));
  return `${"•".repeat(Math.min(12, s.length - visible))}${s.slice(-visible)}`;
}

function encryptJson(value: unknown): string {
  const key = resolvePaymentsKek();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return V1_AES_PREFIX + Buffer.concat([iv, tag, ciphertext]).toString("base64");
}

function decryptJson(encrypted: string | null | undefined): unknown {
  if (!encrypted || !encrypted.startsWith(V1_AES_PREFIX)) return null;
  try {
    const packed = Buffer.from(encrypted.slice(V1_AES_PREFIX.length), "base64");
    if (packed.length < 12 + 16 + 1) return null;
    const iv = packed.subarray(0, 12);
    const tag = packed.subarray(12, 28);
    const ciphertext = packed.subarray(28);
    const decipher = createDecipheriv("aes-256-gcm", resolvePaymentsKek(), iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    return JSON.parse(plain) as unknown;
  } catch {
    return null;
  }
}

export function encodeTrueMoneyOpenApiCredentials(creds: TrueMoneyOpenApiCredentials): string {
  const webhookSecret = creds.webhookSecret.trim();
  if (!webhookSecret) throw new Error("webhook secret ว่าง");
  return encryptJson({ webhookSecret, apiKey: creds.apiKey?.trim() || null });
}

export function decodeTrueMoneyOpenApiCredentials(
  encrypted: string | null | undefined,
): TrueMoneyOpenApiCredentials | null {
  const parsed = decryptJson(encrypted) as { webhookSecret?: unknown; apiKey?: unknown } | null;
  if (!parsed || typeof parsed.webhookSecret !== "string" || !parsed.webhookSecret.trim()) return null;
  return {
    webhookSecret: parsed.webhookSecret.trim(),
    apiKey: typeof parsed.apiKey === "string" && parsed.apiKey.trim() ? parsed.apiKey.trim() : null,
  };
}

export function encodeBeamCredentials(creds: BeamCredentials): string {
  const merchantId = creds.merchantId.trim();
  const apiKey = creds.apiKey.trim();
  if (!merchantId || !apiKey) throw new Error("Merchant ID / API key ว่าง");
  return encryptJson({ merchantId, apiKey, webhookHmacKey: creds.webhookHmacKey?.trim() || null });
}

export function decodeBeamCredentials(encrypted: string | null | undefined): BeamCredentials | null {
  const parsed = decryptJson(encrypted) as
    | { merchantId?: unknown; apiKey?: unknown; webhookHmacKey?: unknown }
    | null;
  if (!parsed) return null;
  if (typeof parsed.merchantId !== "string" || !parsed.merchantId.trim()) return null;
  if (typeof parsed.apiKey !== "string" || !parsed.apiKey.trim()) return null;
  return {
    merchantId: parsed.merchantId.trim(),
    apiKey: parsed.apiKey.trim(),
    webhookHmacKey:
      typeof parsed.webhookHmacKey === "string" && parsed.webhookHmacKey.trim()
        ? parsed.webhookHmacKey.trim()
        : null,
  };
}

/** encryption_key_version for Open API AES-GCM rows */
export const OPEN_API_CREDENTIAL_KEY_VERSION = 1;
