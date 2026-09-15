import type { Json } from "@/server/integrations/supabase/database.types";
import { createSupabaseServerClient } from "@/server/integrations/supabase/server";
import { mapError } from "@/shared/utils/error";
import {
  decodeTrueMoneyManualCredentials,
  decodeTrueMoneyOpenApiCredentials,
  encodeTrueMoneyManualCredentials,
  encodeTrueMoneyOpenApiCredentials,
  maskSecret,
  OPEN_API_CREDENTIAL_KEY_VERSION,
} from "./credentials";
import { maskEmvPayload } from "./emv-qr";
import type {
  GatewayPayment,
  GatewayPaymentStatus,
  PaymentProviderConfig,
  PaymentProviderConfigPublic,
  PaymentProviderKey,
  PaymentProviderMode,
  VerificationSource,
} from "./types";

type ConfigRow = {
  id: string;
  organization_id: string;
  store_id: string;
  provider_key: string;
  mode: string;
  environment: string;
  display_name: string | null;
  is_enabled: boolean;
  is_default: boolean;
  disabled_at: string | null;
  credentials_encrypted: string | null;
  public_config: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
};

type GatewayRow = {
  id: string;
  organization_id: string;
  store_id: string;
  order_id: string | null;
  provider_config_id: string;
  provider_key: string;
  mode: string;
  amount: number | string;
  currency: string;
  status: string;
  storeos_reference: string;
  injected_emv_payload: string | null;
  verification_source: string | null;
  confirmed_by: string | null;
  confirmed_at: string | null;
  confirm_reason: string | null;
  pos_payment_id: string | null;
  paid_at: string | null;
  failure_message: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
};

function mapConfig(row: ConfigRow): PaymentProviderConfig {
  const creds = decodeTrueMoneyManualCredentials(row.credentials_encrypted);
  return {
    id: row.id,
    organizationId: row.organization_id,
    storeId: row.store_id,
    providerKey: row.provider_key as PaymentProviderKey,
    mode: row.mode as PaymentProviderMode,
    environment: row.environment as "test" | "live",
    displayName: row.display_name,
    isEnabled: row.is_enabled,
    isDefault: row.is_default,
    disabledAt: row.disabled_at,
    staticEmvPayload: creds?.staticEmvPayload ?? null,
    publicConfig: row.public_config ?? {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toPublic(
  config: PaymentProviderConfig,
  opts?: { webhookSecretMasked?: string | null; hasWebhookSecret?: boolean },
): PaymentProviderConfigPublic {
  const fromPublic =
    config.publicConfig && typeof config.publicConfig === "object"
      ? (config.publicConfig as {
          webhookSecretMasked?: string | null;
          hasWebhookSecret?: boolean;
        })
      : {};
  return {
    id: config.id,
    providerKey: config.providerKey,
    mode: config.mode,
    environment: config.environment,
    displayName: config.displayName,
    isEnabled: config.isEnabled,
    isDefault: config.isDefault,
    disabledAt: config.disabledAt,
    staticEmvPayloadMasked: config.staticEmvPayload
      ? maskEmvPayload(config.staticEmvPayload)
      : null,
    hasStaticEmvPayload: Boolean(config.staticEmvPayload),
    webhookSecretMasked:
      opts?.webhookSecretMasked ?? fromPublic.webhookSecretMasked ?? null,
    hasWebhookSecret: Boolean(
      opts?.hasWebhookSecret ?? fromPublic.hasWebhookSecret ?? false,
    ),
    updatedAt: config.updatedAt,
  };
}

function mapGateway(row: GatewayRow): GatewayPayment {
  return {
    id: row.id,
    organizationId: row.organization_id,
    storeId: row.store_id,
    orderId: row.order_id,
    providerConfigId: row.provider_config_id,
    providerKey: row.provider_key as PaymentProviderKey,
    mode: row.mode as PaymentProviderMode,
    amount: typeof row.amount === "string" ? Number(row.amount) : row.amount,
    currency: row.currency,
    status: row.status as GatewayPaymentStatus,
    storeosReference: row.storeos_reference,
    injectedEmvPayload: row.injected_emv_payload,
    verificationSource: row.verification_source as VerificationSource | null,
    confirmedBy: row.confirmed_by,
    confirmedAt: row.confirmed_at,
    confirmReason: row.confirm_reason,
    posPaymentId: row.pos_payment_id,
    paidAt: row.paid_at,
    failureMessage: row.failure_message ?? null,
    metadata: row.metadata ?? {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const GATEWAY_SELECT =
  "id, organization_id, store_id, order_id, provider_config_id, provider_key, mode, amount, currency, status, storeos_reference, injected_emv_payload, verification_source, confirmed_by, confirmed_at, confirm_reason, pos_payment_id, paid_at, failure_message, metadata, created_at, updated_at";

/** List select omits injected EMV (settings UI does not need it). */
const GATEWAY_LIST_SELECT =
  "id, organization_id, store_id, order_id, provider_config_id, provider_key, mode, amount, currency, status, storeos_reference, verification_source, confirmed_by, confirmed_at, confirm_reason, pos_payment_id, paid_at, failure_message, metadata, created_at, updated_at";

export async function listProviderConfigsPublic(storeId: string) {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("payment_provider_configs")
    .select(
      "id, organization_id, store_id, provider_key, mode, environment, display_name, is_enabled, is_default, disabled_at, credentials_encrypted, public_config, created_at, updated_at",
    )
    .eq("store_id", storeId)
    .order("provider_key");
  if (error) return { data: null as PaymentProviderConfigPublic[] | null, error: mapError(error) };
  return {
    data: ((data ?? []) as ConfigRow[]).map((row) => toPublic(mapConfig(row))),
    error: null,
  };
}

export async function getEnabledTrueMoneyManualConfig(storeId: string) {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("payment_provider_configs")
    .select(
      "id, organization_id, store_id, provider_key, mode, environment, display_name, is_enabled, is_default, disabled_at, credentials_encrypted, public_config, created_at, updated_at",
    )
    .eq("store_id", storeId)
    .eq("provider_key", "truemoney")
    .eq("mode", "manual")
    .eq("is_enabled", true)
    .is("disabled_at", null)
    .maybeSingle();
  if (error) return { data: null as PaymentProviderConfig | null, error: mapError(error) };
  if (!data) return { data: null, error: null };
  return { data: mapConfig(data as ConfigRow), error: null };
}

/** Load TrueMoney manual config whether enabled or soft-disabled (for Test Connection / keep-existing). */
export async function getTrueMoneyManualConfig(storeId: string) {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("payment_provider_configs")
    .select(
      "id, organization_id, store_id, provider_key, mode, environment, display_name, is_enabled, is_default, disabled_at, credentials_encrypted, public_config, created_at, updated_at",
    )
    .eq("store_id", storeId)
    .eq("provider_key", "truemoney")
    .eq("mode", "manual")
    .maybeSingle();
  if (error) return { data: null as PaymentProviderConfig | null, error: mapError(error) };
  if (!data) return { data: null, error: null };
  return { data: mapConfig(data as ConfigRow), error: null };
}

export async function upsertTrueMoneyManualConfig(input: {
  organizationId: string;
  storeId: string;
  staticEmvPayload: string;
  isEnabled: boolean;
  displayName?: string | null;
  actorUserId: string;
}) {
  const supabase = await createSupabaseServerClient();
  const encoded = encodeTrueMoneyManualCredentials({
    staticEmvPayload: input.staticEmvPayload,
  });
  const { data, error } = await supabase
    .from("payment_provider_configs")
    .upsert(
      {
        organization_id: input.organizationId,
        store_id: input.storeId,
        provider_key: "truemoney",
        mode: "manual",
        environment: "live",
        display_name: input.displayName ?? "TrueMoney Shop QR",
        is_enabled: input.isEnabled,
        is_default: true,
        disabled_at: input.isEnabled ? null : new Date().toISOString(),
        credentials_encrypted: encoded,
        encryption_key_version: 0,
        public_config: {},
        updated_by: input.actorUserId,
        created_by: input.actorUserId,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "store_id,provider_key,mode" },
    )
    .select(
      "id, organization_id, store_id, provider_key, mode, environment, display_name, is_enabled, is_default, disabled_at, credentials_encrypted, public_config, created_at, updated_at",
    )
    .single();
  if (error) return { data: null as PaymentProviderConfigPublic | null, error: mapError(error) };
  return { data: toPublic(mapConfig(data as ConfigRow)), error: null };
}

export async function softDisableTrueMoneyManualConfig(storeId: string, actorUserId: string) {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase
    .from("payment_provider_configs")
    .update({
      is_enabled: false,
      disabled_at: new Date().toISOString(),
      updated_by: actorUserId,
      updated_at: new Date().toISOString(),
    })
    .eq("store_id", storeId)
    .eq("provider_key", "truemoney")
    .eq("mode", "manual");
  if (error) return { error: mapError(error) };
  return { error: null };
}

export async function insertGatewayPayment(input: {
  organizationId: string;
  storeId: string;
  orderId: string | null;
  providerConfigId: string;
  providerKey: PaymentProviderKey;
  mode: PaymentProviderMode;
  amount: number;
  storeosReference: string;
  injectedEmvPayload: string;
  status?: GatewayPaymentStatus;
  metadata?: Record<string, unknown>;
}) {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("gateway_payments")
    .insert({
      organization_id: input.organizationId,
      store_id: input.storeId,
      order_id: input.orderId,
      provider_config_id: input.providerConfigId,
      provider_key: input.providerKey,
      mode: input.mode,
      amount: input.amount,
      currency: "THB",
      status: input.status ?? "PENDING",
      storeos_reference: input.storeosReference,
      injected_emv_payload: input.injectedEmvPayload,
      metadata: (input.metadata ?? {}) as Json,
    })
    .select(
      GATEWAY_SELECT,
    )
    .single();
  if (error) return { data: null as GatewayPayment | null, error: mapError(error) };
  const payment = mapGateway(data as GatewayRow);
  await supabase.from("gateway_payment_attempts").insert({
    gateway_payment_id: payment.id,
    organization_id: input.organizationId,
    store_id: input.storeId,
    attempt_number: 1,
    status: payment.status,
    injected_emv_payload: input.injectedEmvPayload,
  });
  return { data: payment, error: null };
}

export async function findGatewayPaymentByReference(storeId: string, storeosReference: string) {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("gateway_payments")
    .select(
      GATEWAY_SELECT,
    )
    .eq("store_id", storeId)
    .eq("storeos_reference", storeosReference)
    .maybeSingle();
  if (error) return { data: null as GatewayPayment | null, error: mapError(error) };
  if (!data) return { data: null, error: null };
  return { data: mapGateway(data as GatewayRow), error: null };
}

export async function getGatewayPayment(id: string) {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("gateway_payments")
    .select(
      GATEWAY_SELECT,
    )
    .eq("id", id)
    .maybeSingle();
  if (error) return { data: null as GatewayPayment | null, error: mapError(error) };
  if (!data) return { data: null, error: null };
  return { data: mapGateway(data as GatewayRow), error: null };
}

export async function markGatewayPaymentPaidManual(input: {
  id: string;
  confirmedBy: string;
  confirmReason: string;
  posPaymentId: string | null;
  orderId: string | null;
}) {
  const supabase = await createSupabaseServerClient();
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from("gateway_payments")
    .update({
      status: "PAID",
      verification_source: "MANUAL_STAFF",
      confirmed_by: input.confirmedBy,
      confirmed_at: now,
      confirm_reason: input.confirmReason,
      pos_payment_id: input.posPaymentId,
      order_id: input.orderId,
      paid_at: now,
      updated_at: now,
    })
    .eq("id", input.id)
    .in("status", ["CREATED", "PENDING", "REQUIRES_ACTION", "PROCESSING"])
    .select(
      GATEWAY_SELECT,
    )
    .maybeSingle();
  if (error) return { data: null as GatewayPayment | null, error: mapError(error) };
  if (!data) {
    // Idempotent: already paid
    const existing = await getGatewayPayment(input.id);
    return existing;
  }
  return { data: mapGateway(data as GatewayRow), error: null };
}


export async function listGatewayPaymentsForStore(
  storeId: string,
  opts?: { limit?: number; status?: GatewayPaymentStatus | null },
) {
  const limit = Math.min(Math.max(opts?.limit ?? 50, 1), 200);
  const supabase = await createSupabaseServerClient();
  let query = supabase
    .from("gateway_payments")
    .select(GATEWAY_LIST_SELECT)
    .eq("store_id", storeId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (opts?.status) {
    query = query.eq("status", opts.status);
  }
  const { data, error } = await query;
  if (error) return { data: null as GatewayPayment[] | null, error: mapError(error) };
  const mapped = ((data ?? []) as Omit<GatewayRow, "injected_emv_payload">[]).map((row) =>
    mapGateway({ ...row, injected_emv_payload: null }),
  );
  return { data: mapped, error: null };
}

const CANCELABLE_STATUSES: GatewayPaymentStatus[] = [
  "CREATED",
  "PENDING",
  "REQUIRES_ACTION",
  "PROCESSING",
];

export async function cancelGatewayPayment(
  id: string,
  input: { reason: string; actorUserId: string },
) {
  const supabase = await createSupabaseServerClient();
  const loaded = await getGatewayPayment(id);
  if (loaded.error) return { data: null as GatewayPayment | null, error: loaded.error };
  if (!loaded.data) {
    return {
      data: null,
      error: { code: "not_found", message: "gateway payment not found", userMessage: "ไม่พบรายการชำระ" },
    };
  }
  const current = loaded.data;
  if (!CANCELABLE_STATUSES.includes(current.status)) {
    return {
      data: null,
      error: {
        code: "invalid_transition",
        message: `cannot cancel from ${current.status}`,
        userMessage: `สถานะ ${current.status} ยกเลิกไม่ได้`,
      },
    };
  }

  const now = new Date().toISOString();
  const metadata = {
    ...current.metadata,
    cancel: {
      reason: input.reason,
      at: now,
      by: input.actorUserId,
    },
  };

  const { data, error } = await supabase
    .from("gateway_payments")
    .update({
      status: "CANCELLED",
      failure_message: input.reason,
      metadata: metadata as Json,
      updated_at: now,
    })
    .eq("id", id)
    .in("status", CANCELABLE_STATUSES)
    .select(GATEWAY_SELECT)
    .maybeSingle();
  if (error) return { data: null as GatewayPayment | null, error: mapError(error) };
  if (!data) {
    const again = await getGatewayPayment(id);
    return again;
  }
  return { data: mapGateway(data as GatewayRow), error: null };
}

export async function markGatewayPaymentExternalRefund(
  id: string,
  input: { note: string; actorUserId: string },
) {
  const supabase = await createSupabaseServerClient();
  const loaded = await getGatewayPayment(id);
  if (loaded.error) return { data: null as GatewayPayment | null, error: loaded.error };
  if (!loaded.data) {
    return {
      data: null,
      error: { code: "not_found", message: "gateway payment not found", userMessage: "ไม่พบรายการชำระ" },
    };
  }
  const current = loaded.data;
  if (current.status !== "PAID") {
    return {
      data: null,
      error: {
        code: "invalid_transition",
        message: `cannot external-refund from ${current.status}`,
        userMessage: `สถานะ ${current.status} บันทึกคืนเงินภายนอกไม่ได้`,
      },
    };
  }

  const now = new Date().toISOString();
  const metadata = {
    ...current.metadata,
    externalRefund: {
      note: input.note,
      at: now,
      by: input.actorUserId,
    },
  };

  const { data, error } = await supabase
    .from("gateway_payments")
    .update({
      status: "REFUND_SUCCEEDED",
      metadata: metadata as Json,
      updated_at: now,
    })
    .eq("id", id)
    .eq("status", "PAID")
    .select(GATEWAY_SELECT)
    .maybeSingle();
  if (error) return { data: null as GatewayPayment | null, error: mapError(error) };
  if (!data) {
    const again = await getGatewayPayment(id);
    return again;
  }
  return { data: mapGateway(data as GatewayRow), error: null };
}


const CONFIG_SELECT =
  "id, organization_id, store_id, provider_key, mode, environment, display_name, is_enabled, is_default, disabled_at, credentials_encrypted, public_config, created_at, updated_at";

export async function getTrueMoneyOpenApiConfig(storeId: string) {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("payment_provider_configs")
    .select(CONFIG_SELECT)
    .eq("store_id", storeId)
    .eq("provider_key", "truemoney")
    .eq("mode", "open_api")
    .maybeSingle();
  if (error) return { data: null as PaymentProviderConfig | null, error: mapError(error), creds: null as ReturnType<typeof decodeTrueMoneyOpenApiCredentials> };
  if (!data) return { data: null, error: null, creds: null };
  const row = data as ConfigRow;
  const config = mapConfig(row);
  const creds = decodeTrueMoneyOpenApiCredentials(row.credentials_encrypted);
  return { data: config, error: null, creds };
}

export async function upsertTrueMoneyOpenApiConfig(input: {
  organizationId: string;
  storeId: string;
  webhookSecret: string;
  apiKey?: string | null;
  isEnabled: boolean;
  displayName?: string | null;
  actorUserId: string;
  keepExistingSecret?: boolean;
}) {
  const supabase = await createSupabaseServerClient();
  let encoded: string;
  let masked: string | null;

  if (input.keepExistingSecret) {
    const existing = await getTrueMoneyOpenApiConfig(input.storeId);
    if (!existing.creds?.webhookSecret) {
      return {
        data: null as PaymentProviderConfigPublic | null,
        error: {
          code: "missing",
          message: "no existing secret",
          userMessage: "ยังไม่มี Webhook Secret ที่บันทึกไว้ — กรุณาวาง Secret ใหม่",
        },
      };
    }
    encoded = encodeTrueMoneyOpenApiCredentials({
      webhookSecret: existing.creds.webhookSecret,
      apiKey: input.apiKey ?? existing.creds.apiKey ?? null,
    });
    masked = maskSecret(existing.creds.webhookSecret);
  } else {
    const secret = input.webhookSecret.trim();
    if (secret.length < 8) {
      return {
        data: null as PaymentProviderConfigPublic | null,
        error: {
          code: "invalid",
          message: "secret too short",
          userMessage: "Webhook Secret สั้นเกินไป",
        },
      };
    }
    encoded = encodeTrueMoneyOpenApiCredentials({
      webhookSecret: secret,
      apiKey: input.apiKey ?? null,
    });
    masked = maskSecret(secret);
  }

  const publicConfig = {
    hasWebhookSecret: true,
    webhookSecretMasked: masked,
  };

  const { data, error } = await supabase
    .from("payment_provider_configs")
    .upsert(
      {
        organization_id: input.organizationId,
        store_id: input.storeId,
        provider_key: "truemoney",
        mode: "open_api",
        environment: "live",
        display_name: input.displayName ?? "TrueMoney Open API",
        is_enabled: input.isEnabled,
        is_default: false,
        disabled_at: input.isEnabled ? null : new Date().toISOString(),
        credentials_encrypted: encoded,
        encryption_key_version: OPEN_API_CREDENTIAL_KEY_VERSION,
        public_config: publicConfig,
        updated_by: input.actorUserId,
        created_by: input.actorUserId,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "store_id,provider_key,mode" },
    )
    .select(CONFIG_SELECT)
    .single();
  if (error) return { data: null as PaymentProviderConfigPublic | null, error: mapError(error) };
  return {
    data: toPublic(mapConfig(data as ConfigRow), {
      webhookSecretMasked: masked,
      hasWebhookSecret: true,
    }),
    error: null,
  };
}

export async function softDisableTrueMoneyOpenApiConfig(storeId: string, actorUserId: string) {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase
    .from("payment_provider_configs")
    .update({
      is_enabled: false,
      disabled_at: new Date().toISOString(),
      updated_by: actorUserId,
      updated_at: new Date().toISOString(),
    })
    .eq("store_id", storeId)
    .eq("provider_key", "truemoney")
    .eq("mode", "open_api");
  if (error) return { error: mapError(error) };
  return { error: null };
}

export async function findPendingGatewayPaymentByAmount(input: {
  storeId: string;
  amountMajor: number;
  providerKey?: PaymentProviderKey;
}) {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("gateway_payments")
    .select(GATEWAY_SELECT)
    .eq("store_id", input.storeId)
    .eq("provider_key", input.providerKey ?? "truemoney")
    .eq("amount", input.amountMajor)
    .in("status", ["CREATED", "PENDING", "REQUIRES_ACTION", "PROCESSING"])
    .order("created_at", { ascending: false })
    .limit(2);
  if (error) return { data: null as GatewayPayment | null, ambiguous: false, error: mapError(error) };
  const rows = (data ?? []) as GatewayRow[];
  if (rows.length === 0) return { data: null, ambiguous: false, error: null };
  if (rows.length > 1) return { data: mapGateway(rows[0]!), ambiguous: true, error: null };
  return { data: mapGateway(rows[0]!), ambiguous: false, error: null };
}

export async function markGatewayPaymentPaidFromWebhook(input: {
  id: string;
  providerPaymentId?: string | null;
  metadataMerge?: Record<string, unknown>;
}) {
  const supabase = await createSupabaseServerClient();
  const loaded = await getGatewayPayment(input.id);
  if (loaded.error || !loaded.data) return loaded;
  const now = new Date().toISOString();
  const metadata = {
    ...loaded.data.metadata,
    ...(input.metadataMerge ?? {}),
  };
  const { data, error } = await supabase
    .from("gateway_payments")
    .update({
      status: "PAID",
      verification_source: "PROVIDER_WEBHOOK",
      provider_payment_id: input.providerPaymentId ?? null,
      paid_at: now,
      metadata: metadata as Json,
      updated_at: now,
    })
    .eq("id", input.id)
    .in("status", ["CREATED", "PENDING", "REQUIRES_ACTION", "PROCESSING"])
    .select(GATEWAY_SELECT)
    .maybeSingle();
  if (error) return { data: null as GatewayPayment | null, error: mapError(error) };
  if (!data) return getGatewayPayment(input.id);
  return { data: mapGateway(data as GatewayRow), error: null };
}

export async function markGatewayPaymentReviewFromWebhook(input: {
  id?: string | null;
  storeId: string;
  organizationId: string;
  providerConfigId: string;
  amountMajor: number;
  providerEventId: string;
  reason: string;
  metadata?: Record<string, unknown>;
}) {
  // If we have a payment id, move to REVIEW_REQUIRED / LATE_PAID; else insert LATE_PAID orphan.
  const supabase = await createSupabaseServerClient();
  const now = new Date().toISOString();
  if (input.id) {
    const loaded = await getGatewayPayment(input.id);
    if (loaded.data) {
      const toStatus =
        loaded.data.status === "CANCELLED" || loaded.data.status === "EXPIRED"
          ? "LATE_PAID"
          : "REVIEW_REQUIRED";
      const { data, error } = await supabase
        .from("gateway_payments")
        .update({
          status: toStatus,
          verification_source: "PROVIDER_WEBHOOK",
          failure_message: input.reason,
          metadata: { ...loaded.data.metadata, ...(input.metadata ?? {}) } as Json,
          updated_at: now,
        })
        .eq("id", input.id)
        .select(GATEWAY_SELECT)
        .maybeSingle();
      if (error) return { data: null as GatewayPayment | null, error: mapError(error) };
      if (data) return { data: mapGateway(data as GatewayRow), error: null };
    }
  }

  const reference = `tm_openapi_unmatched:${input.storeId}:${input.providerEventId}`;
  const { data, error } = await supabase
    .from("gateway_payments")
    .upsert(
      {
        organization_id: input.organizationId,
        store_id: input.storeId,
        order_id: null,
        provider_config_id: input.providerConfigId,
        provider_key: "truemoney",
        mode: "open_api",
        amount: input.amountMajor > 0 ? input.amountMajor : 0.01,
        currency: "THB",
        status: "LATE_PAID",
        storeos_reference: reference,
        verification_source: "PROVIDER_WEBHOOK",
        failure_message: input.reason,
        metadata: (input.metadata ?? {}) as Json,
        paid_at: now,
        updated_at: now,
      },
      { onConflict: "store_id,storeos_reference" },
    )
    .select(GATEWAY_SELECT)
    .maybeSingle();
  if (error) return { data: null as GatewayPayment | null, error: mapError(error) };
  if (!data) return { data: null, error: null };
  return { data: mapGateway(data as GatewayRow), error: null };
}

export async function claimWebhookEvent(input: {
  providerKey: string;
  providerEventId: string;
  eventType: string | null;
  storeId: string | null;
  organizationId: string | null;
  amountMajor: number | null;
  payloadRedacted: Record<string, unknown>;
}) {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("gateway_payment_webhook_events")
    .insert({
      provider_key: input.providerKey,
      provider_event_id: input.providerEventId,
      event_type: input.eventType,
      store_id: input.storeId,
      organization_id: input.organizationId,
      amount_major: input.amountMajor,
      payload_redacted: input.payloadRedacted as Json,
      processing_status: "processing",
    })
    .select("id, processing_status")
    .maybeSingle();
  if (error) {
    // Unique violation → already seen
    if (String((error as { code?: string }).code) === "23505") {
      return { decision: "skip" as const, eventRowId: null, error: null };
    }
    return { decision: "error" as const, eventRowId: null, error: mapError(error) };
  }
  return {
    decision: "process" as const,
    eventRowId: (data as { id: string } | null)?.id ?? null,
    error: null,
  };
}

export async function completeWebhookEvent(
  eventRowId: string,
  status: "processed" | "ignored" | "failed",
  opts?: { gatewayPaymentId?: string | null; failureMessage?: string | null },
) {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase
    .from("gateway_payment_webhook_events")
    .update({
      processing_status: status,
      gateway_payment_id: opts?.gatewayPaymentId ?? null,
      failure_message: opts?.failureMessage ?? null,
      processed_at: new Date().toISOString(),
    })
    .eq("id", eventRowId);
  if (error) return { error: mapError(error) };
  return { error: null };
}

