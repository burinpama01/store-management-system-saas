import type { Json } from "@/server/integrations/supabase/database.types";
import { createSupabaseServerClient, createSupabaseServiceClient } from "@/server/integrations/supabase/server";
import { logSystemEvent } from "@/modules/system/event-log";
import { createBeamQrCharge, getBeamCharge, pingBeamCredentials } from "./beam-client";
import { isPlausibleBeamHmacKey } from "./beam-signature";
import {
  decodeBeamCredentials,
  encodeBeamCredentials,
  maskSecret,
  OPEN_API_CREDENTIAL_KEY_VERSION,
} from "./credentials";
import { amountsEqualMajor, majorToSatang, roundMajorThb } from "./money";
import type {
  BeamCredentials,
  BeamQrForPos,
  BeamTestResult,
  GatewayPaymentStatus,
  PaymentEnvironment,
  PaymentProviderConfigPublic,
} from "./types";

/**
 * Beam (BYO) — Phase C1: QR PromptPay charges on the POS, verified by Beam itself
 * (webhook, with a GET /charges lookup as fallback). Staff never confirm by hand:
 * the order is closed only once the server has seen the charge SUCCEEDED.
 *
 * Settings/POS paths run as the signed-in user (RLS: manager+ config, cashier+
 * gateway rows). The webhook path lives in webhook-beam.ts on the service client.
 */

const QR_TTL_MS = 10 * 60 * 1000;
/** Give the webhook a head start before asking Beam directly. */
const LOOKUP_AFTER_MS = 6_000;
const OPEN_STATUSES: GatewayPaymentStatus[] = ["CREATED", "PENDING", "REQUIRES_ACTION", "PROCESSING"];

/**
 * client ของ Supabase ที่ใช้ — ค่าเริ่มต้นคือ session ของพนักงาน (RLS) ; หน้าลูกค้า (ขอเพลง)
 * ไม่มี session จึงส่ง service client เข้ามา (ใช้เฉพาะเส้นทางที่ตรวจสิทธิ์ของร้านแล้ว)
 */
type BeamDb =
  | Awaited<ReturnType<typeof createSupabaseServerClient>>
  | Awaited<ReturnType<typeof createSupabaseServiceClient>>;

const CONFIG_COLUMNS =
  "id, organization_id, store_id, environment, display_name, is_enabled, is_default, disabled_at, credentials_encrypted, public_config, updated_at";

const GATEWAY_COLUMNS =
  "id, organization_id, store_id, order_id, provider_config_id, amount, status, storeos_reference, provider_payment_id, injected_emv_payload, pos_payment_id, paid_at, metadata, created_at";

type BeamConfigRow = {
  id: string;
  organization_id: string;
  store_id: string;
  environment: string;
  display_name: string | null;
  is_enabled: boolean;
  is_default: boolean;
  disabled_at: string | null;
  credentials_encrypted: string | null;
  public_config: Record<string, unknown> | null;
  updated_at: string;
};

type BeamGatewayRow = {
  id: string;
  organization_id: string;
  store_id: string;
  order_id: string | null;
  provider_config_id: string;
  amount: number | string;
  status: string;
  storeos_reference: string;
  provider_payment_id: string | null;
  injected_emv_payload: string | null;
  pos_payment_id: string | null;
  paid_at: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
};

export interface BeamConfig {
  id: string;
  organizationId: string;
  storeId: string;
  environment: PaymentEnvironment;
  isEnabled: boolean;
  creds: BeamCredentials | null;
  /** Store chose Beam as its only QR: hide the slip-checked PromptPay QR at the POS. */
  hidePromptPayQr: boolean;
}

function toEnvironment(v: string | null | undefined): PaymentEnvironment {
  return v === "test" ? "test" : "live";
}

function rowAmount(row: BeamGatewayRow): number {
  return typeof row.amount === "string" ? Number(row.amount) : row.amount;
}

function configPublic(row: BeamConfigRow): PaymentProviderConfigPublic {
  const pub = (row.public_config ?? {}) as {
    merchantIdMasked?: string | null;
    hasApiKey?: boolean;
    webhookSecretMasked?: string | null;
    hasWebhookSecret?: boolean;
    hidePromptPayQr?: boolean;
  };
  return {
    id: row.id,
    providerKey: "beam",
    mode: "open_api",
    environment: toEnvironment(row.environment),
    displayName: row.display_name,
    isEnabled: row.is_enabled,
    isDefault: row.is_default,
    disabledAt: row.disabled_at,
    staticEmvPayloadMasked: null,
    hasStaticEmvPayload: false,
    webhookSecretMasked: pub.webhookSecretMasked ?? null,
    hasWebhookSecret: Boolean(pub.hasWebhookSecret),
    merchantIdMasked: pub.merchantIdMasked ?? null,
    hasApiKey: Boolean(pub.hasApiKey),
    hidePromptPayQr: Boolean(pub.hidePromptPayQr),
    updatedAt: row.updated_at,
  };
}

export function buildBeamWebhookUrl(storeId: string): string {
  const base =
    process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ||
    process.env.APP_URL?.replace(/\/$/, "") ||
    "https://www.store-os.online";
  return `${base}/api/payments/webhooks/beam?storeId=${encodeURIComponent(storeId)}`;
}

export async function getBeamConfig(storeId: string, client?: BeamDb): Promise<BeamConfig | null> {
  const supabase = client ?? (await createSupabaseServerClient());
  const { data } = await supabase
    .from("payment_provider_configs")
    .select(CONFIG_COLUMNS)
    .eq("store_id", storeId)
    .eq("provider_key", "beam")
    .eq("mode", "open_api")
    .maybeSingle();
  if (!data) return null;
  const row = data as BeamConfigRow;
  return {
    id: row.id,
    organizationId: row.organization_id,
    storeId: row.store_id,
    environment: toEnvironment(row.environment),
    isEnabled: row.is_enabled && !row.disabled_at,
    creds: decodeBeamCredentials(row.credentials_encrypted),
    hidePromptPayQr: row.public_config?.hidePromptPayQr === true,
  };
}

/** Ready = enabled and holding a merchant id + API key (the webhook key is optional; lookup covers it). */
export async function isBeamReadyForStore(storeId: string, client?: BeamDb): Promise<boolean> {
  const config = await getBeamConfig(storeId, client);
  return Boolean(config?.isEnabled && config.creds);
}

/**
 * What the POS payment panel offers. PromptPay is only ever hidden while Beam is
 * actually usable — switching Beam off brings the plain PromptPay QR back.
 */
export async function getBeamPosOptions(
  storeId: string,
): Promise<{ beamEnabled: boolean; hidePromptPayQr: boolean }> {
  const config = await getBeamConfig(storeId);
  const beamEnabled = Boolean(config?.isEnabled && config.creds);
  return { beamEnabled, hidePromptPayQr: beamEnabled && Boolean(config?.hidePromptPayQr) };
}

/**
 * Saves the store's Beam keys. Blank API key / HMAC key = keep the stored one,
 * so the owner can flip environment or enable without re-pasting secrets.
 */
export async function saveBeamConfigForStore(input: {
  organizationId: string;
  storeId: string;
  merchantId: string;
  apiKey?: string | null;
  webhookHmacKey?: string | null;
  environment: PaymentEnvironment;
  isEnabled: boolean;
  hidePromptPayQr?: boolean;
  actorUserId: string;
}): Promise<{ data: PaymentProviderConfigPublic | null; error: string | null }> {
  const existing = await getBeamConfig(input.storeId);
  // Blank = keep the stored merchant id (the form never echoes it back in full).
  const merchantId = input.merchantId.trim() || existing?.creds?.merchantId || "";
  if (!/^[A-Za-z0-9_-]{4,64}$/.test(merchantId)) {
    return { data: null, error: "Merchant ID ไม่ถูกต้อง (ดูได้ที่ Lighthouse → Developers)" };
  }
  const apiKey = input.apiKey?.trim() || existing?.creds?.apiKey || "";
  if (!apiKey) return { data: null, error: "กรุณาวาง API key ของ Beam" };
  const hmacInput = input.webhookHmacKey?.trim() || "";
  if (hmacInput && !isPlausibleBeamHmacKey(hmacInput)) {
    return { data: null, error: "HMAC key ต้องเป็นค่า base64 ที่คัดลอกจากหน้า Webhooks ของ Lighthouse" };
  }
  const webhookHmacKey = hmacInput || existing?.creds?.webhookHmacKey || null;

  let encoded: string;
  try {
    encoded = encodeBeamCredentials({ merchantId, apiKey, webhookHmacKey });
  } catch (e) {
    return { data: null, error: e instanceof Error ? e.message : "เข้ารหัสข้อมูลไม่สำเร็จ" };
  }

  const now = new Date().toISOString();
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("payment_provider_configs")
    .upsert(
      {
        organization_id: input.organizationId,
        store_id: input.storeId,
        provider_key: "beam",
        mode: "open_api",
        environment: input.environment,
        display_name: "Beam",
        is_enabled: input.isEnabled,
        is_default: false,
        disabled_at: input.isEnabled ? null : now,
        credentials_encrypted: encoded,
        encryption_key_version: OPEN_API_CREDENTIAL_KEY_VERSION,
        public_config: {
          merchantIdMasked: maskSecret(merchantId, 6),
          hasApiKey: true,
          hasWebhookSecret: Boolean(webhookHmacKey),
          webhookSecretMasked: maskSecret(webhookHmacKey),
          hidePromptPayQr: Boolean(input.hidePromptPayQr),
        },
        updated_by: input.actorUserId,
        created_by: input.actorUserId,
        updated_at: now,
      },
      { onConflict: "store_id,provider_key,mode" },
    )
    .select(CONFIG_COLUMNS)
    .single();
  if (error || !data) {
    await logSystemEvent({
      level: "error",
      source: "payments.config",
      action: "BEAM_CONFIG_SAVE_FAILED",
      message: "บันทึกการตั้งค่า Beam ไม่สำเร็จ",
      organizationId: input.organizationId,
      storeId: input.storeId,
      actorUserId: input.actorUserId,
      context: { error: error?.message ?? "no row" },
    });
    return { data: null, error: "บันทึกการตั้งค่า Beam ไม่สำเร็จ (ต้องเป็นผู้จัดการขึ้นไป)" };
  }

  await logSystemEvent({
    level: "info",
    source: "payments.config",
    action: "PAYMENT_PROVIDER_UPSERT",
    message: input.isEnabled ? "บันทึกและเปิดใช้ Beam" : "บันทึก Beam (ปิดใช้งาน)",
    organizationId: input.organizationId,
    storeId: input.storeId,
    actorUserId: input.actorUserId,
    context: {
      providerKey: "beam",
      mode: "open_api",
      environment: input.environment,
      isEnabled: input.isEnabled,
      hasWebhookKey: Boolean(webhookHmacKey),
      hidePromptPayQr: Boolean(input.hidePromptPayQr),
      configId: (data as BeamConfigRow).id,
    },
  });
  return { data: configPublic(data as BeamConfigRow), error: null };
}

export async function disableBeamConfigForStore(input: {
  organizationId: string;
  storeId: string;
  actorUserId: string;
}): Promise<{ error: string | null }> {
  const now = new Date().toISOString();
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase
    .from("payment_provider_configs")
    .update({ is_enabled: false, disabled_at: now, updated_by: input.actorUserId, updated_at: now })
    .eq("store_id", input.storeId)
    .eq("provider_key", "beam")
    .eq("mode", "open_api");
  if (error) return { error: "ปิดใช้ Beam ไม่สำเร็จ" };
  await logSystemEvent({
    level: "info",
    source: "payments.config",
    action: "PAYMENT_PROVIDER_DISABLE",
    message: "ปิดใช้ Beam",
    organizationId: input.organizationId,
    storeId: input.storeId,
    actorUserId: input.actorUserId,
    context: { providerKey: "beam", mode: "open_api" },
  });
  return { error: null };
}

/** Calls Beam with the pasted (or stored) keys. Does not create any payment. */
export async function testBeamConnection(input: {
  storeId: string;
  merchantId?: string | null;
  apiKey?: string | null;
  environment: PaymentEnvironment;
}): Promise<BeamTestResult> {
  const existing = await getBeamConfig(input.storeId);
  const merchantId = input.merchantId?.trim() || existing?.creds?.merchantId || "";
  const apiKey = input.apiKey?.trim() || existing?.creds?.apiKey || "";
  if (!merchantId || !apiKey) return { ok: false, error: "กรุณาวาง Merchant ID และ API key ก่อนทดสอบ" };

  const res = await pingBeamCredentials({
    environment: input.environment,
    creds: { merchantId, apiKey, webhookHmacKey: null },
  });
  await logSystemEvent({
    level: res.ok ? "info" : "warn",
    source: "payments.config",
    action: "BEAM_TEST_CONNECTION",
    message: res.ok ? "ทดสอบเชื่อมต่อ Beam สำเร็จ" : "ทดสอบเชื่อมต่อ Beam ไม่สำเร็จ",
    storeId: input.storeId,
    context: { environment: input.environment, status: res.ok ? 200 : res.status },
  });
  if (!res.ok) return { ok: false, error: res.error };
  return {
    ok: true,
    providerKey: "beam",
    environment: input.environment,
    merchantIdMasked: maskSecret(merchantId, 6),
    hasWebhookKey: Boolean(existing?.creds?.webhookHmacKey),
    webhookUrl: buildBeamWebhookUrl(input.storeId),
    message:
      input.environment === "test"
        ? "เชื่อมต่อ Beam Playground ได้ — ทดลองจ่ายด้วยข้อมูลทดสอบได้เลย"
        : "เชื่อมต่อ Beam Production ได้ — พร้อมรับเงินจริง",
  };
}

function toPosView(row: BeamGatewayRow, qrImageBase64: string | null): BeamQrForPos {
  const meta = row.metadata ?? {};
  return {
    gatewayPaymentId: row.id,
    amount: rowAmount(row),
    status: row.status as GatewayPaymentStatus,
    qrPayload: row.injected_emv_payload,
    qrImageBase64,
    expiresAt: typeof meta.expiresAt === "string" ? meta.expiresAt : null,
  };
}

/**
 * Creates (or, for the same clientRequestId, reuses) a Beam QR charge for the
 * cart total. The order does not exist yet — it is created and closed only
 * after the charge is confirmed paid (see claimBeamPaymentForOrder).
 */
export async function createBeamQrPayment(input: {
  organizationId: string;
  storeId: string;
  amountMajor: number;
  clientRequestId: string;
  /** null = ลูกค้าเป็นผู้เริ่ม (ขอเพลง) */
  actorUserId: string | null;
  /** ผูกรายการชำระกับคำขอเพลง — PAID แล้ว trigger ยืนยันคำขอให้ */
  musicRequestId?: string | null;
  client?: BeamDb;
}): Promise<{ ok: true; qr: BeamQrForPos } | { ok: false; error: string }> {
  const amount = roundMajorThb(input.amountMajor);
  if (!(amount >= 1)) return { ok: false, error: "ยอดชำระผ่าน Beam ต้องอย่างน้อย 1 บาท" };

  const config = await getBeamConfig(input.storeId, input.client);
  if (!config?.isEnabled || !config.creds) {
    return { ok: false, error: "ร้านยังไม่ได้เปิดใช้ Beam (ตั้งค่าที่ ตั้งค่า → การชำระเงิน)" };
  }

  const supabase = input.client ?? (await createSupabaseServerClient());
  const reference = `beam:${input.clientRequestId}`;

  let row: BeamGatewayRow | null = null;
  const { data: existing } = await supabase
    .from("gateway_payments")
    .select(GATEWAY_COLUMNS)
    .eq("store_id", input.storeId)
    .eq("storeos_reference", reference)
    .maybeSingle();
  if (existing) {
    row = existing as BeamGatewayRow;
    if (!amountsEqualMajor(rowAmount(row), amount)) {
      return { ok: false, error: "ยอดเปลี่ยนไปจาก QR เดิม — กรุณาสร้าง QR ใหม่" };
    }
    if (!OPEN_STATUSES.includes(row.status as GatewayPaymentStatus)) {
      // จ่ายแล้ว = คืนสถานะ PAID · หมดอายุ/ล้ม/ยกเลิก = ไม่มี QR ที่ใช้ได้ ต้องเริ่มรายการใหม่
      if (row.status === "PAID") return { ok: true, qr: toPosView(row, null) };
      return { ok: false, error: "QR นี้หมดอายุหรือถูกยกเลิกแล้ว — กรุณาสร้างรายการใหม่" };
    }
  } else {
    const expiresAt = new Date(Date.now() + QR_TTL_MS).toISOString();
    const { data: inserted, error } = await supabase
      .from("gateway_payments")
      .insert({
        organization_id: input.organizationId,
        store_id: input.storeId,
        order_id: null,
        music_request_id: input.musicRequestId ?? null,
        provider_config_id: config.id,
        provider_key: "beam",
        mode: "open_api",
        amount,
        currency: "THB",
        status: "PENDING",
        storeos_reference: reference,
        metadata: {
          channel: "qr_promptpay",
          environment: config.environment,
          expiresAt,
          createdBy: input.actorUserId,
          ...(input.musicRequestId ? { purpose: "music_request" } : {}),
        } as Json,
      })
      .select(GATEWAY_COLUMNS)
      .single();
    if (error || !inserted) {
      return { ok: false, error: "สร้างรายการชำระ Beam ไม่สำเร็จ" };
    }
    row = inserted as BeamGatewayRow;
  }

  const expiresAt =
    typeof row.metadata?.expiresAt === "string"
      ? row.metadata.expiresAt
      : new Date(Date.now() + QR_TTL_MS).toISOString();
  // Same idempotency key on a retry → Beam returns the same charge (12 h window).
  const charge = await createBeamQrCharge({
    environment: config.environment,
    creds: config.creds,
    amountSatang: majorToSatang(amount),
    referenceId: row.id,
    idempotencyKey: row.id,
    expiresAt,
  });

  if (!charge.ok) {
    await supabase
      .from("gateway_payments")
      .update({ status: "FAILED", failure_message: charge.error, updated_at: new Date().toISOString() })
      .eq("id", row.id)
      .in("status", OPEN_STATUSES);
    await logSystemEvent({
      level: "error",
      source: "payments.create",
      action: "BEAM_CHARGE_CREATE_FAILED",
      message: "สร้าง QR ผ่าน Beam ไม่สำเร็จ",
      organizationId: input.organizationId,
      storeId: input.storeId,
      actorUserId: input.actorUserId,
      context: { gatewayPaymentId: row.id, amount, httpStatus: charge.status, error: charge.error },
    });
    return { ok: false, error: charge.error };
  }

  const metadata = {
    ...(row.metadata ?? {}),
    chargeId: charge.data.chargeId,
    expiresAt: charge.data.expiresAt ?? expiresAt,
    qrFormat: charge.data.qrPayload ? "emv" : "image",
  };
  const { data: updated } = await supabase
    .from("gateway_payments")
    .update({
      provider_payment_id: charge.data.chargeId,
      injected_emv_payload: charge.data.qrPayload,
      metadata: metadata as Json,
      updated_at: new Date().toISOString(),
    })
    .eq("id", row.id)
    .select(GATEWAY_COLUMNS)
    .single();
  const finalRow = (updated as BeamGatewayRow | null) ?? {
    ...row,
    provider_payment_id: charge.data.chargeId,
    injected_emv_payload: charge.data.qrPayload,
    metadata,
  };

  await logSystemEvent({
    level: "info",
    source: "payments.create",
    action: "GATEWAY_PAYMENT_CREATE",
    message: existing ? "ใช้ QR Beam เดิม (retry)" : "สร้าง QR Beam",
    organizationId: input.organizationId,
    storeId: input.storeId,
    actorUserId: input.actorUserId,
    context: {
      gatewayPaymentId: row.id,
      providerKey: "beam",
      chargeId: charge.data.chargeId,
      amount,
      environment: config.environment,
      qrFormat: metadata.qrFormat,
    },
  });

  return { ok: true, qr: toPosView(finalRow, charge.data.qrImageBase64) };
}

/**
 * Current status for the POS poll. Reads the row (the webhook keeps it fresh);
 * if it is still open after a few seconds, asks Beam directly so a missing or
 * late webhook never strands the cashier.
 */
export async function refreshBeamPayment(input: {
  storeId: string;
  gatewayPaymentId: string;
  client?: BeamDb;
  /**
   * ถาม Beam API ได้ไม่ถี่กว่านี้ (อิง metadata.lastLookupAt) — webhook คือทางหลัก
   * ช่วงที่ยังไม่ครบ = คืนสถานะจาก DB (หน้าลูกค้า poll ถี่ได้โดยไม่ยิง provider)
   */
  minLookupIntervalMs?: number;
}): Promise<{ ok: true; status: GatewayPaymentStatus; amount: number } | { ok: false; error: string }> {
  const supabase = input.client ?? (await createSupabaseServerClient());
  const { data } = await supabase
    .from("gateway_payments")
    .select(GATEWAY_COLUMNS)
    .eq("id", input.gatewayPaymentId)
    .eq("store_id", input.storeId)
    .eq("provider_key", "beam")
    .maybeSingle();
  if (!data) return { ok: false, error: "ไม่พบรายการชำระ Beam" };
  const row = data as BeamGatewayRow;
  const status = row.status as GatewayPaymentStatus;
  const amount = rowAmount(row);
  if (!OPEN_STATUSES.includes(status)) return { ok: true, status, amount };
  if (!row.provider_payment_id) return { ok: true, status, amount };
  if (Date.now() - new Date(row.created_at).getTime() < LOOKUP_AFTER_MS) {
    return { ok: true, status, amount };
  }
  if (input.minLookupIntervalMs) {
    const last = typeof row.metadata?.lastLookupAt === "string" ? Date.parse(row.metadata.lastLookupAt) : NaN;
    if (Number.isFinite(last) && Date.now() - last < input.minLookupIntervalMs) {
      return { ok: true, status, amount };
    }
  }

  const config = await getBeamConfig(input.storeId, input.client);
  if (!config?.creds) return { ok: true, status, amount };
  const charge = await getBeamCharge({
    environment: config.environment,
    creds: config.creds,
    chargeId: row.provider_payment_id,
  });
  if (!charge.ok) return { ok: true, status, amount };

  const now = new Date().toISOString();
  const metadata = { ...(row.metadata ?? {}), lastLookupAt: now, beamStatus: charge.data.status };

  if (charge.data.status === "SUCCEEDED") {
    const amountOk =
      charge.data.amountSatang === null || charge.data.amountSatang === majorToSatang(amount);
    const next: GatewayPaymentStatus = amountOk ? "PAID" : "REVIEW_REQUIRED";
    const { data: moved } = await supabase
      .from("gateway_payments")
      .update({
        status: next,
        verification_source: "PROVIDER_API",
        paid_at: now,
        failure_message: amountOk ? null : "ยอดที่ Beam รับไม่ตรงกับยอดในระบบ",
        metadata: metadata as Json,
        updated_at: now,
      })
      .eq("id", row.id)
      .in("status", OPEN_STATUSES)
      .select("status")
      .maybeSingle();
    await logSystemEvent({
      level: amountOk ? "info" : "warn",
      source: "payments.status",
      action: amountOk ? "BEAM_PAID_VIA_LOOKUP" : "BEAM_AMOUNT_MISMATCH",
      message: amountOk ? "Beam ยืนยันรับเงินแล้ว (ตรวจผ่าน API)" : "ยอดที่ Beam รับไม่ตรงกับยอดในระบบ",
      organizationId: row.organization_id,
      storeId: row.store_id,
      context: {
        gatewayPaymentId: row.id,
        chargeId: row.provider_payment_id,
        expectedSatang: majorToSatang(amount),
        beamSatang: charge.data.amountSatang,
      },
    });
    const resolved = (moved as { status?: string } | null)?.status as GatewayPaymentStatus | undefined;
    return { ok: true, status: resolved ?? next, amount };
  }

  if (charge.data.status === "FAILED") {
    await supabase
      .from("gateway_payments")
      .update({
        status: "FAILED",
        verification_source: "PROVIDER_API",
        failure_message: charge.data.failureCode ?? "Beam แจ้งว่าชำระไม่สำเร็จ",
        metadata: metadata as Json,
        updated_at: now,
      })
      .eq("id", row.id)
      .in("status", OPEN_STATUSES);
    await logSystemEvent({
      level: "warn",
      source: "payments.status",
      action: "BEAM_FAILED_VIA_LOOKUP",
      message: "Beam แจ้งว่าชำระไม่สำเร็จ",
      organizationId: row.organization_id,
      storeId: row.store_id,
      context: { gatewayPaymentId: row.id, failureCode: charge.data.failureCode },
    });
    return { ok: true, status: "FAILED", amount };
  }

  const expiresAt = typeof row.metadata?.expiresAt === "string" ? Date.parse(row.metadata.expiresAt) : NaN;
  if (!(Number.isFinite(expiresAt) && Date.now() > expiresAt + 60_000)) {
    // ยังรอจ่าย: จดเวลาที่ถาม Beam ล่าสุดไว้ให้ throttle
    await supabase
      .from("gateway_payments")
      .update({ metadata: metadata as Json, updated_at: now })
      .eq("id", row.id)
      .in("status", OPEN_STATUSES);
  }
  if (Number.isFinite(expiresAt) && Date.now() > expiresAt + 60_000) {
    await supabase
      .from("gateway_payments")
      .update({ status: "EXPIRED", metadata: metadata as Json, updated_at: now })
      .eq("id", row.id)
      .in("status", OPEN_STATUSES);
    return { ok: true, status: "EXPIRED", amount };
  }
  return { ok: true, status, amount };
}

/** Staff abandoned the QR (cart changed / switched method). A payment that still lands becomes LATE_PAID. */
export async function cancelBeamQrPayment(input: {
  storeId: string;
  gatewayPaymentId: string;
  actorUserId: string | null;
  client?: BeamDb;
  reason?: string;
}): Promise<{ error: string | null }> {
  const supabase = input.client ?? (await createSupabaseServerClient());
  const now = new Date().toISOString();
  const { data } = await supabase
    .from("gateway_payments")
    .update({ status: "CANCELLED", failure_message: input.reason ?? "ยกเลิก QR ที่ POS", updated_at: now })
    .eq("id", input.gatewayPaymentId)
    .eq("store_id", input.storeId)
    .eq("provider_key", "beam")
    .in("status", OPEN_STATUSES)
    .select("id, organization_id")
    .maybeSingle();
  if (data) {
    await logSystemEvent({
      level: "info",
      source: "payments.cancel",
      action: "BEAM_QR_CANCELLED",
      message: input.reason ?? "ยกเลิก QR Beam ที่ POS",
      organizationId: (data as { organization_id: string }).organization_id,
      storeId: input.storeId,
      actorUserId: input.actorUserId,
      context: { gatewayPaymentId: input.gatewayPaymentId },
    });
  }
  return { error: null };
}

/**
 * Reserves a PAID Beam payment for one order before the order is closed.
 * Atomic (conditional update): two tabs racing the same payment → only one wins.
 */
export async function claimBeamPaymentForOrder(input: {
  storeId: string;
  gatewayPaymentId: string;
  orderId: string;
  expectedAmount: number;
}): Promise<{ ok: true; amount: number } | { ok: false; error: string }> {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase
    .from("gateway_payments")
    .select(GATEWAY_COLUMNS)
    .eq("id", input.gatewayPaymentId)
    .eq("store_id", input.storeId)
    .eq("provider_key", "beam")
    .maybeSingle();
  if (!data) return { ok: false, error: "ไม่พบรายการชำระ Beam" };
  const row = data as BeamGatewayRow;
  if (row.status !== "PAID") {
    return { ok: false, error: "Beam ยังไม่ยืนยันว่าได้รับเงิน — รอลูกค้าสแกนจ่ายก่อน" };
  }
  if (!amountsEqualMajor(rowAmount(row), input.expectedAmount)) {
    return { ok: false, error: "ยอดที่จ่ายผ่าน Beam ไม่ตรงกับยอดบิล" };
  }
  if (row.pos_payment_id || (row.order_id && row.order_id !== input.orderId)) {
    return { ok: false, error: "รายการชำระ Beam นี้ถูกใช้กับบิลอื่นแล้ว" };
  }
  const { data: claimed } = await supabase
    .from("gateway_payments")
    .update({ order_id: input.orderId, updated_at: new Date().toISOString() })
    .eq("id", row.id)
    .eq("status", "PAID")
    .is("pos_payment_id", null)
    .or(`order_id.is.null,order_id.eq.${input.orderId}`)
    .select("id")
    .maybeSingle();
  if (!claimed) return { ok: false, error: "รายการชำระ Beam นี้ถูกใช้กับบิลอื่นแล้ว" };
  return { ok: true, amount: rowAmount(row) };
}

/** Closing the order failed after the claim — free the payment for a retry. */
export async function releaseBeamPaymentClaim(input: {
  storeId: string;
  gatewayPaymentId: string;
  orderId: string;
}): Promise<void> {
  const supabase = await createSupabaseServerClient();
  await supabase
    .from("gateway_payments")
    .update({ order_id: null, updated_at: new Date().toISOString() })
    .eq("id", input.gatewayPaymentId)
    .eq("store_id", input.storeId)
    .eq("order_id", input.orderId)
    .is("pos_payment_id", null);
}

export async function finalizeBeamPaymentForOrder(input: {
  organizationId: string;
  storeId: string;
  gatewayPaymentId: string;
  orderId: string;
  posPaymentId: string | null;
  actorUserId: string;
}): Promise<void> {
  const supabase = await createSupabaseServerClient();
  await supabase
    .from("gateway_payments")
    .update({ pos_payment_id: input.posPaymentId, updated_at: new Date().toISOString() })
    .eq("id", input.gatewayPaymentId)
    .eq("store_id", input.storeId)
    .eq("order_id", input.orderId);
  await logSystemEvent({
    level: "info",
    source: "payments.close",
    action: "BEAM_PAYMENT_ATTACHED",
    message: "ปิดบิลด้วยเงินที่ Beam ยืนยันแล้ว",
    organizationId: input.organizationId,
    storeId: input.storeId,
    actorUserId: input.actorUserId,
    context: {
      gatewayPaymentId: input.gatewayPaymentId,
      orderId: input.orderId,
      posPaymentId: input.posPaymentId,
    },
  });
}

export interface BeamPaymentHistoryItem {
  id: string;
  amount: number;
  status: GatewayPaymentStatus;
  orderId: string | null;
  /** ผูกกับบิล POS หรือคำขอเพลงแล้ว (ไม่ต้องตรวจเพิ่ม) */
  attached: boolean;
  /** รายการนี้เป็นค่าขอเพลง (ไม่ใช่บิลขาย) */
  musicRequestId: string | null;
  environment: PaymentEnvironment;
  failureMessage: string | null;
  createdAt: string;
  paidAt: string | null;
}

/** Recent Beam charges for the settings page — reconcile LATE_PAID / REVIEW_REQUIRED / unattached PAID. */
export async function listBeamPaymentsForStore(storeId: string, limit = 30): Promise<BeamPaymentHistoryItem[]> {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase
    .from("gateway_payments")
    .select("id, amount, status, order_id, pos_payment_id, music_request_id, failure_message, metadata, created_at, paid_at")
    .eq("store_id", storeId)
    .eq("provider_key", "beam")
    .order("created_at", { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 100));
  return ((data ?? []) as Array<{
    id: string;
    amount: number | string;
    status: string;
    order_id: string | null;
    pos_payment_id: string | null;
    music_request_id: string | null;
    failure_message: string | null;
    metadata: Record<string, unknown> | null;
    created_at: string;
    paid_at: string | null;
  }>).map((r) => ({
    id: r.id,
    amount: typeof r.amount === "string" ? Number(r.amount) : r.amount,
    status: r.status as GatewayPaymentStatus,
    orderId: r.order_id,
    attached: Boolean(r.pos_payment_id || r.music_request_id),
    musicRequestId: r.music_request_id,
    environment: toEnvironment(typeof r.metadata?.environment === "string" ? r.metadata.environment : "live"),
    failureMessage: r.failure_message,
    createdAt: r.created_at,
    paidAt: r.paid_at,
  }));
}
