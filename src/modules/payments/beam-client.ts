import { looksLikeEmvPayload } from "./emv-qr";
import type { BeamCredentials, PaymentEnvironment } from "./types";

/**
 * Thin Beam Checkout API client (https://docs.beamcheckout.com).
 * Auth: HTTP Basic merchantId:apiKey. Playground and production keys are not
 * interchangeable, so the base URL follows the store's configured environment.
 */
export const BEAM_BASE_URLS: Record<PaymentEnvironment, string> = {
  test: "https://playground.api.beamcheckout.com",
  live: "https://api.beamcheckout.com",
};

const TIMEOUT_MS = 10_000;

export type BeamChargeStatus = "PENDING" | "SUCCEEDED" | "FAILED";

export interface BeamQrCharge {
  chargeId: string;
  /** EMV payload when Beam returns one in rawData — lets the POS/customer display render its own QR. */
  qrPayload: string | null;
  /** PNG, base64 (no data: prefix). */
  qrImageBase64: string | null;
  expiresAt: string | null;
}

export interface BeamCharge {
  chargeId: string;
  status: BeamChargeStatus | string;
  amountSatang: number | null;
  referenceId: string | null;
  failureCode: string | null;
}

export type BeamResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; error: string };

function authHeader(creds: BeamCredentials): string {
  return "Basic " + Buffer.from(`${creds.merchantId}:${creds.apiKey}`, "utf8").toString("base64");
}

function describeFailure(status: number, body: unknown): string {
  if (status === 401 || status === 403) {
    return "Beam ปฏิเสธ Merchant ID / API key (ตรวจว่าใช้ key ของ Playground หรือ Production ให้ตรงกับที่เลือก)";
  }
  if (status === 0) return "เชื่อมต่อ Beam ไม่ได้ (หมดเวลาหรือเครือข่ายขัดข้อง)";
  const message =
    body && typeof body === "object"
      ? ((body as { error?: { errorMessage?: unknown; message?: unknown }; message?: unknown }).error
          ?.errorMessage ??
        (body as { error?: { message?: unknown } }).error?.message ??
        (body as { message?: unknown }).message)
      : null;
  return typeof message === "string" && message.trim()
    ? `Beam ตอบกลับผิดพลาด (${status}): ${message.trim()}`
    : `Beam ตอบกลับผิดพลาด (${status})`;
}

async function beamRequest<T = unknown>(input: {
  environment: PaymentEnvironment;
  creds: BeamCredentials;
  method: "GET" | "POST";
  path: string;
  body?: unknown;
  idempotencyKey?: string;
}): Promise<BeamResult<T>> {
  const headers: Record<string, string> = {
    Authorization: authHeader(input.creds),
    Accept: "application/json",
  };
  if (input.body !== undefined) headers["Content-Type"] = "application/json";
  if (input.idempotencyKey) headers["x-beam-idempotency-key"] = input.idempotencyKey;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(BEAM_BASE_URLS[input.environment] + input.path, {
      method: input.method,
      headers,
      body: input.body === undefined ? undefined : JSON.stringify(input.body),
      signal: controller.signal,
      cache: "no-store",
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!res.ok) return { ok: false, status: res.status, error: describeFailure(res.status, json) };
    return { ok: true, data: json as T };
  } catch {
    return { ok: false, status: 0, error: describeFailure(0, null) };
  } finally {
    clearTimeout(timer);
  }
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

export function parseBeamQrChargeResponse(body: unknown): BeamQrCharge | null {
  if (!body || typeof body !== "object") return null;
  const b = body as { chargeId?: unknown; encodedImage?: Record<string, unknown> | null };
  const chargeId = str(b.chargeId);
  if (!chargeId) return null;
  const rawData = str(b.encodedImage?.rawData);
  return {
    chargeId,
    qrPayload: rawData && looksLikeEmvPayload(rawData) ? rawData : null,
    qrImageBase64: str(b.encodedImage?.imageBase64Encoded),
    expiresAt: str(b.encodedImage?.expiry),
  };
}

export function parseBeamCharge(body: unknown): BeamCharge | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const chargeId = str(b.chargeId);
  if (!chargeId) return null;
  return {
    chargeId,
    status: str(b.status) ?? "PENDING",
    amountSatang: typeof b.amount === "number" && Number.isFinite(b.amount) ? b.amount : null,
    referenceId: str(b.referenceId),
    failureCode: str(b.failureCode),
  };
}

export async function createBeamQrCharge(input: {
  environment: PaymentEnvironment;
  creds: BeamCredentials;
  amountSatang: number;
  referenceId: string;
  idempotencyKey: string;
  expiresAt: string;
}): Promise<BeamResult<BeamQrCharge>> {
  const res = await beamRequest({
    environment: input.environment,
    creds: input.creds,
    method: "POST",
    path: "/api/v1/charges",
    idempotencyKey: input.idempotencyKey,
    body: {
      amount: input.amountSatang,
      currency: "THB",
      referenceId: input.referenceId,
      paymentMethod: {
        paymentMethodType: "QR_PROMPT_PAY",
        qrPromptPay: { expiryTime: input.expiresAt },
      },
    },
  });
  if (!res.ok) return res;
  const parsed = parseBeamQrChargeResponse(res.data);
  if (!parsed || (!parsed.qrPayload && !parsed.qrImageBase64)) {
    return { ok: false, status: 502, error: "Beam ไม่ได้ส่ง QR กลับมา" };
  }
  return { ok: true, data: parsed };
}

export async function getBeamCharge(input: {
  environment: PaymentEnvironment;
  creds: BeamCredentials;
  chargeId: string;
}): Promise<BeamResult<BeamCharge>> {
  const res = await beamRequest({
    environment: input.environment,
    creds: input.creds,
    method: "GET",
    path: `/api/v1/charges/${encodeURIComponent(input.chargeId)}`,
  });
  if (!res.ok) return res;
  const parsed = parseBeamCharge(res.data);
  if (!parsed) return { ok: false, status: 502, error: "อ่านสถานะจาก Beam ไม่ได้" };
  return { ok: true, data: parsed };
}

/** Cheapest authenticated call — proves the merchant id / API key / environment pair. */
export async function pingBeamCredentials(input: {
  environment: PaymentEnvironment;
  creds: BeamCredentials;
}): Promise<BeamResult<true>> {
  const res = await beamRequest({
    environment: input.environment,
    creds: input.creds,
    method: "GET",
    path: "/api/v1/charges?limit=1",
  });
  if (res.ok) return { ok: true, data: true };
  // Authenticated but the list query itself was refused → the keys are still good.
  if (res.status === 400 || res.status === 404 || res.status === 422) return { ok: true, data: true };
  return res;
}
