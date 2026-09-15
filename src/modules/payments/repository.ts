import type { Json } from "@/server/integrations/supabase/database.types";
import { createSupabaseServerClient } from "@/server/integrations/supabase/server";
import { mapError } from "@/shared/utils/error";
import {
  decodeTrueMoneyManualCredentials,
  encodeTrueMoneyManualCredentials,
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

function toPublic(config: PaymentProviderConfig): PaymentProviderConfigPublic {
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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

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
      "id, organization_id, store_id, order_id, provider_config_id, provider_key, mode, amount, currency, status, storeos_reference, injected_emv_payload, verification_source, confirmed_by, confirmed_at, confirm_reason, pos_payment_id, paid_at, created_at, updated_at",
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
      "id, organization_id, store_id, order_id, provider_config_id, provider_key, mode, amount, currency, status, storeos_reference, injected_emv_payload, verification_source, confirmed_by, confirmed_at, confirm_reason, pos_payment_id, paid_at, created_at, updated_at",
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
      "id, organization_id, store_id, order_id, provider_config_id, provider_key, mode, amount, currency, status, storeos_reference, injected_emv_payload, verification_source, confirmed_by, confirmed_at, confirm_reason, pos_payment_id, paid_at, created_at, updated_at",
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
      "id, organization_id, store_id, order_id, provider_config_id, provider_key, mode, amount, currency, status, storeos_reference, injected_emv_payload, verification_source, confirmed_by, confirmed_at, confirm_reason, pos_payment_id, paid_at, created_at, updated_at",
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
