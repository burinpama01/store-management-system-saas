import { createSupabaseServiceClient } from "@/server/integrations/supabase/server";
import { logSystemEvent } from "@/modules/system/event-log";
import type { Json } from "@/server/integrations/supabase/database.types";
import { decodeTrueMoneyOpenApiCredentials } from "./credentials";
import { amountsEqualMajor, roundMajorThb } from "./money";
import {
  parseTrueMoneyWebhookClaims,
  verifyTrueMoneyWebhookJwtHs256,
} from "./truemoney-jwt";
import { canTransitionGatewayStatus } from "./status";

/**
 * TrueMoney Open API webhook processor (Phase B scaffold).
 *
 * Provisional community shape — verify against official in-app docs when eligible:
 * POST body `{ "message": "<JWT>" }` HS256 with merchant webhook secret.
 * Events may include P2P, MONEY_LINK, DIRECT_TOPUP, PROMPTPAY_IN; amount often satang.
 *
 * storeId: required via query `?storeId=` until official merchant-id mapping is documented.
 */

type ConfigRow = {
  id: string;
  organization_id: string;
  store_id: string;
  credentials_encrypted: string | null;
  is_enabled: boolean;
  disabled_at: string | null;
};

export async function processTrueMoneyOpenApiWebhook(input: {
  rawBody: unknown;
  storeId: string | null;
}): Promise<{ status: number; body: Record<string, unknown> }> {
  const storeId = input.storeId?.trim() || null;
  if (!storeId) {
    return {
      status: 400,
      body: {
        error: "missing_store_id",
        message: "ระบุ storeId ใน query (?storeId=) — ชั่วคราวจนกว่าจะมี merchant id จากเอกสารทางการ",
      },
    };
  }

  const message =
    input.rawBody &&
    typeof input.rawBody === "object" &&
    typeof (input.rawBody as { message?: unknown }).message === "string"
      ? (input.rawBody as { message: string }).message.trim()
      : "";
  if (!message) {
    return { status: 400, body: { error: "missing_message", message: "body.message (JWT) จำเป็น" } };
  }

  const supabase = await createSupabaseServiceClient();
  const { data: configRow, error: configErr } = await supabase
    .from("payment_provider_configs")
    .select("id, organization_id, store_id, credentials_encrypted, is_enabled, disabled_at")
    .eq("store_id", storeId)
    .eq("provider_key", "truemoney")
    .eq("mode", "open_api")
    .maybeSingle();

  if (configErr || !configRow) {
    return { status: 404, body: { error: "config_missing" } };
  }
  const config = configRow as ConfigRow;
  if (!config.is_enabled || config.disabled_at) {
    return { status: 404, body: { error: "config_disabled" } };
  }

  const creds = decodeTrueMoneyOpenApiCredentials(config.credentials_encrypted);
  if (!creds?.webhookSecret) {
    return { status: 500, body: { error: "secret_missing" } };
  }

  let claims: Record<string, unknown>;
  try {
    claims = verifyTrueMoneyWebhookJwtHs256(message, creds.webhookSecret);
  } catch (e) {
    return {
      status: 401,
      body: { error: "invalid_jwt", message: e instanceof Error ? e.message : "verify failed" },
    };
  }

  let parsed: ReturnType<typeof parseTrueMoneyWebhookClaims>;
  try {
    parsed = parseTrueMoneyWebhookClaims(claims);
  } catch (e) {
    return {
      status: 400,
      body: { error: "invalid_claims", message: e instanceof Error ? e.message : "claims failed" },
    };
  }

  // Idempotent insert
  const { data: inserted, error: insertErr } = await supabase
    .from("gateway_payment_webhook_events")
    .insert({
      provider_key: "truemoney",
      provider_event_id: parsed.eventId,
      event_type: parsed.eventType,
      store_id: storeId,
      organization_id: config.organization_id,
      amount_major: parsed.amountMajor,
      payload_redacted: {
        eventType: parsed.eventType,
        amountMajor: parsed.amountMajor,
        amountSatang: parsed.amountSatang,
        // never store raw JWT
      } as Json,
      processing_status: "processing",
    })
    .select("id")
    .maybeSingle();

  if (insertErr) {
    if (String((insertErr as { code?: string }).code) === "23505") {
      return { status: 200, body: { received: true, duplicate: true } };
    }
    return { status: 500, body: { error: "event_insert_failed" } };
  }
  const eventRowId = (inserted as { id: string } | null)?.id;

  const amountMajor =
    parsed.amountMajor != null && parsed.amountMajor > 0
      ? roundMajorThb(parsed.amountMajor)
      : null;

  let gatewayPaymentId: string | null = null;
  let outcome: "paid" | "review" | "late" | "ignored" = "ignored";
  let failureMessage: string | null = null;

  try {
    if (amountMajor == null) {
      outcome = "ignored";
      failureMessage = "ไม่มียอดใน JWT — ต้องยืนยันชื่อฟิลด์จากเอกสารทางการ";
    } else {
      const { data: matches } = await supabase
        .from("gateway_payments")
        .select(
          "id, status, amount, store_id, organization_id, metadata, order_id",
        )
        .eq("store_id", storeId)
        .eq("provider_key", "truemoney")
        .in("status", ["CREATED", "PENDING", "REQUIRES_ACTION", "PROCESSING"])
        .order("created_at", { ascending: false })
        .limit(10);

      const pending = (matches ?? []).filter((row) =>
        amountsEqualMajor(Number(row.amount), amountMajor),
      );

      if (pending.length === 1) {
        const payment = pending[0]!;
        if (canTransitionGatewayStatus(payment.status as never, "PAID")) {
          const now = new Date().toISOString();
          const { data: updated } = await supabase
            .from("gateway_payments")
            .update({
              status: "PAID",
              verification_source: "PROVIDER_WEBHOOK",
              provider_payment_id: parsed.eventId,
              paid_at: now,
              updated_at: now,
              metadata: {
                ...((payment.metadata as Record<string, unknown>) ?? {}),
                webhookEventId: parsed.eventId,
                webhookEventType: parsed.eventType,
              } as Json,
            })
            .eq("id", payment.id)
            .in("status", ["CREATED", "PENDING", "REQUIRES_ACTION", "PROCESSING"])
            .select("id")
            .maybeSingle();
          gatewayPaymentId = (updated as { id: string } | null)?.id ?? payment.id;
          outcome = "paid";
        } else {
          outcome = "review";
          failureMessage = `สถานะ ${payment.status} รับ webhook PAID ไม่ได้`;
          gatewayPaymentId = payment.id;
        }
      } else if (pending.length > 1) {
        outcome = "review";
        failureMessage = "พบหลายรายการ pending ยอดเดียวกัน — ต้องกระทบยอดด้วยมือ";
        gatewayPaymentId = pending[0]!.id;
        await supabase
          .from("gateway_payments")
          .update({
            status: "REVIEW_REQUIRED",
            verification_source: "PROVIDER_WEBHOOK",
            failure_message: failureMessage,
            updated_at: new Date().toISOString(),
          })
          .eq("id", gatewayPaymentId);
      } else {
        // No match → LATE_PAID orphan for reconcile
        outcome = "late";
        failureMessage = "ไม่พบรายการ pending ที่ยอดตรงกัน";
        const reference = `tm_openapi_unmatched:${storeId}:${parsed.eventId}`;
        const now = new Date().toISOString();
        const { data: orphan } = await supabase
          .from("gateway_payments")
          .upsert(
            {
              organization_id: config.organization_id,
              store_id: storeId,
              order_id: null,
              provider_config_id: config.id,
              provider_key: "truemoney",
              mode: "open_api",
              amount: amountMajor,
              currency: "THB",
              status: "LATE_PAID",
              storeos_reference: reference,
              provider_payment_id: parsed.eventId,
              verification_source: "PROVIDER_WEBHOOK",
              failure_message: failureMessage,
              paid_at: now,
              metadata: {
                webhookEventId: parsed.eventId,
                webhookEventType: parsed.eventType,
              } as Json,
              updated_at: now,
            },
            { onConflict: "store_id,storeos_reference" },
          )
          .select("id")
          .maybeSingle();
        gatewayPaymentId = (orphan as { id: string } | null)?.id ?? null;
      }
    }

    if (eventRowId) {
      await supabase
        .from("gateway_payment_webhook_events")
        .update({
          processing_status:
            outcome === "paid" ? "processed" : outcome === "ignored" ? "ignored" : "processed",
          gateway_payment_id: gatewayPaymentId,
          failure_message: failureMessage,
          processed_at: new Date().toISOString(),
        })
        .eq("id", eventRowId);
    }

    await logSystemEvent({
      level: outcome === "paid" ? "info" : "warn",
      source: "payments.webhook.truemoney",
      action: "TRUEMONEY_WEBHOOK",
      message: `TrueMoney Open API webhook: ${outcome}`,
      organizationId: config.organization_id,
      storeId,
      context: {
        eventId: parsed.eventId,
        eventType: parsed.eventType,
        amountMajor,
        gatewayPaymentId,
        outcome,
      },
    });

    return {
      status: 200,
      body: { received: true, outcome, gatewayPaymentId },
    };
  } catch (e) {
    if (eventRowId) {
      await supabase
        .from("gateway_payment_webhook_events")
        .update({
          processing_status: "failed",
          failure_message: e instanceof Error ? e.message : "unknown",
          processed_at: new Date().toISOString(),
        })
        .eq("id", eventRowId);
    }
    return {
      status: 500,
      body: { error: "processing_failed", message: e instanceof Error ? e.message : "error" },
    };
  }
}
