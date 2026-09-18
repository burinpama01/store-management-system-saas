import type { Json } from "@/server/integrations/supabase/database.types";
import { createSupabaseServiceClient } from "@/server/integrations/supabase/server";
import { logSystemEvent } from "@/modules/system/event-log";
import { parseBeamCharge } from "./beam-client";
import { verifyBeamSignature } from "./beam-signature";
import { decodeBeamCredentials } from "./credentials";
import { majorToSatang } from "./money";

/**
 * Beam webhook (charge.succeeded / charge.failed).
 *
 * Runs WITHOUT a user session, so every read/write goes through the service
 * client — the RLS-scoped server client would silently update 0 rows here.
 * Authenticity comes from the per-store HMAC key instead.
 */

const OPEN_STATUSES = ["CREATED", "PENDING", "REQUIRES_ACTION", "PROCESSING"];
const HANDLED_EVENTS = new Set(["charge.succeeded", "charge.failed"]);

type Result = { status: number; body: Record<string, unknown> };

export async function processBeamWebhook(input: {
  storeId: string | null;
  rawBody: string;
  signature: string | null;
  eventName: string | null;
}): Promise<Result> {
  const storeId = input.storeId?.trim() || null;
  if (!storeId || !/^[0-9a-f-]{36}$/i.test(storeId)) {
    return { status: 400, body: { error: "missing_store_id" } };
  }

  const supabase = await createSupabaseServiceClient();
  const { data: config } = await supabase
    .from("payment_provider_configs")
    .select("id, organization_id, credentials_encrypted, is_enabled, disabled_at")
    .eq("store_id", storeId)
    .eq("provider_key", "beam")
    .eq("mode", "open_api")
    .maybeSingle();
  if (!config) return { status: 404, body: { error: "config_missing" } };
  const organizationId = config.organization_id as string;

  const creds = decodeBeamCredentials(config.credentials_encrypted as string | null);
  if (!creds?.webhookHmacKey) {
    await logSystemEvent({
      level: "warn",
      source: "payments.webhook",
      action: "BEAM_WEBHOOK_NO_KEY",
      message: "Beam ส่ง webhook มา แต่ร้านยังไม่ได้ใส่ HMAC key",
      organizationId,
      storeId,
      context: { event: input.eventName },
    });
    return { status: 500, body: { error: "hmac_key_missing" } };
  }

  if (!verifyBeamSignature(input.rawBody, input.signature, creds.webhookHmacKey)) {
    await logSystemEvent({
      level: "warn",
      source: "payments.webhook",
      action: "BEAM_WEBHOOK_BAD_SIGNATURE",
      message: "ลายเซ็น webhook ของ Beam ไม่ถูกต้อง (HMAC key ผิดหรือถูกปลอม)",
      organizationId,
      storeId,
      context: { event: input.eventName, hasSignature: Boolean(input.signature) },
    });
    return { status: 401, body: { error: "invalid_signature" } };
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(input.rawBody) as Record<string, unknown>;
  } catch {
    return { status: 400, body: { error: "invalid_json" } };
  }

  const eventName = input.eventName?.trim() || "";
  if (!HANDLED_EVENTS.has(eventName)) {
    return { status: 200, body: { ok: true, ignored: eventName || "unknown_event" } };
  }

  const charge = parseBeamCharge(payload);
  if (!charge) return { status: 400, body: { error: "missing_charge_id" } };

  const payloadMerchant = typeof payload.merchantId === "string" ? payload.merchantId : null;
  if (payloadMerchant && payloadMerchant !== creds.merchantId) {
    await logSystemEvent({
      level: "warn",
      source: "payments.webhook",
      action: "BEAM_WEBHOOK_MERCHANT_MISMATCH",
      message: "webhook ของ Beam มาจาก Merchant ID ที่ไม่ใช่ของร้านนี้",
      organizationId,
      storeId,
      context: { chargeId: charge.chargeId },
    });
    return { status: 403, body: { error: "merchant_mismatch" } };
  }

  // Beam sends no event id — one outcome per charge per event type is the natural key.
  const providerEventId = `${eventName}:${charge.chargeId}`;
  const { data: eventRow, error: claimErr } = await supabase
    .from("gateway_payment_webhook_events")
    .insert({
      provider_key: "beam",
      provider_event_id: providerEventId,
      event_type: eventName,
      store_id: storeId,
      organization_id: organizationId,
      amount_major: charge.amountSatang !== null ? charge.amountSatang / 100 : null,
      payload_redacted: {
        chargeId: charge.chargeId,
        referenceId: charge.referenceId,
        status: charge.status,
        amount: charge.amountSatang,
        source: typeof payload.source === "string" ? payload.source : null,
        failureCode: charge.failureCode,
      } as Json,
      processing_status: "processing",
    })
    .select("id")
    .maybeSingle();
  if (claimErr) {
    if (String((claimErr as { code?: string }).code) === "23505") {
      return { status: 200, body: { ok: true, duplicate: true } };
    }
    return { status: 500, body: { error: "event_log_failed" } };
  }
  const eventRowId = (eventRow as { id: string } | null)?.id ?? null;

  const finish = async (
    processing: "processed" | "ignored" | "failed",
    gatewayPaymentId: string | null,
    note: string | null,
  ) => {
    if (!eventRowId) return;
    await supabase
      .from("gateway_payment_webhook_events")
      .update({
        processing_status: processing,
        gateway_payment_id: gatewayPaymentId,
        failure_message: note,
        processed_at: new Date().toISOString(),
      })
      .eq("id", eventRowId);
  };

  const columns = "id, amount, status, metadata";
  let { data: payment } = await supabase
    .from("gateway_payments")
    .select(columns)
    .eq("store_id", storeId)
    .eq("provider_key", "beam")
    .eq("provider_payment_id", charge.chargeId)
    .maybeSingle();
  if (!payment && charge.referenceId && /^[0-9a-f-]{36}$/i.test(charge.referenceId)) {
    // The charge-create response may not have been saved yet (webhook raced it).
    ({ data: payment } = await supabase
      .from("gateway_payments")
      .select(columns)
      .eq("store_id", storeId)
      .eq("provider_key", "beam")
      .eq("id", charge.referenceId)
      .maybeSingle());
  }
  if (!payment) {
    // e.g. a payment link or Bolt standalone sale — not a StoreOS POS charge.
    await finish("ignored", null, "ไม่ใช่รายการที่สร้างจาก StoreOS");
    return { status: 200, body: { ok: true, ignored: "unknown_charge" } };
  }

  const row = payment as { id: string; amount: number | string; status: string; metadata: Record<string, unknown> | null };
  const amountMajor = typeof row.amount === "string" ? Number(row.amount) : row.amount;
  const now = new Date().toISOString();
  const metadata = { ...(row.metadata ?? {}), chargeId: charge.chargeId, webhookAt: now };

  if (eventName === "charge.failed") {
    await supabase
      .from("gateway_payments")
      .update({
        status: "FAILED",
        verification_source: "PROVIDER_WEBHOOK",
        failure_message: charge.failureCode || "Beam แจ้งว่าชำระไม่สำเร็จ",
        metadata: metadata as Json,
        updated_at: now,
      })
      .eq("id", row.id)
      .in("status", OPEN_STATUSES);
    await finish("processed", row.id, null);
    await logSystemEvent({
      level: "warn",
      source: "payments.webhook",
      action: "BEAM_WEBHOOK_FAILED",
      message: "Beam แจ้งว่าชำระไม่สำเร็จ",
      organizationId,
      storeId,
      context: { gatewayPaymentId: row.id, failureCode: charge.failureCode },
    });
    return { status: 200, body: { ok: true } };
  }

  // charge.succeeded
  const amountOk = charge.amountSatang === null || charge.amountSatang === majorToSatang(amountMajor);
  let nextStatus: string;
  if (!amountOk) nextStatus = "REVIEW_REQUIRED";
  else if (OPEN_STATUSES.includes(row.status)) nextStatus = "PAID";
  else if (row.status === "CANCELLED" || row.status === "EXPIRED" || row.status === "FAILED") nextStatus = "LATE_PAID";
  else nextStatus = row.status; // already PAID (lookup got there first) — no-op

  if (nextStatus !== row.status) {
    await supabase
      .from("gateway_payments")
      .update({
        status: nextStatus,
        verification_source: "PROVIDER_WEBHOOK",
        paid_at: now,
        failure_message:
          nextStatus === "REVIEW_REQUIRED"
            ? "ยอดที่ Beam รับไม่ตรงกับยอดในระบบ"
            : nextStatus === "LATE_PAID"
              ? "เงินเข้าหลัง QR ถูกยกเลิก/หมดอายุ — ตรวจแล้วคืนเงินหรือผูกบิลเอง"
              : null,
        metadata: metadata as Json,
        updated_at: now,
      })
      .eq("id", row.id)
      .eq("status", row.status);
  }
  await finish("processed", row.id, null);
  await logSystemEvent({
    level: nextStatus === "PAID" || nextStatus === row.status ? "info" : "warn",
    source: "payments.webhook",
    action:
      nextStatus === "PAID"
        ? "BEAM_WEBHOOK_PAID"
        : nextStatus === "LATE_PAID"
          ? "BEAM_WEBHOOK_LATE_PAID"
          : nextStatus === "REVIEW_REQUIRED"
            ? "BEAM_AMOUNT_MISMATCH"
            : "BEAM_WEBHOOK_ALREADY_PAID",
    message:
      nextStatus === "PAID"
        ? "Beam ยืนยันรับเงินแล้ว (webhook)"
        : nextStatus === "LATE_PAID"
          ? "เงินเข้า Beam หลังยกเลิก QR — ต้องตรวจสอบ"
          : nextStatus === "REVIEW_REQUIRED"
            ? "ยอดที่ Beam รับไม่ตรงกับยอดในระบบ"
            : "webhook มาหลังระบบยืนยันแล้ว",
    organizationId,
    storeId,
    context: {
      gatewayPaymentId: row.id,
      chargeId: charge.chargeId,
      from: row.status,
      to: nextStatus,
      expectedSatang: majorToSatang(amountMajor),
      beamSatang: charge.amountSatang,
    },
  });
  return { status: 200, body: { ok: true } };
}
