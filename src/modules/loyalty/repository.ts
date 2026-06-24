import { randomUUID } from "node:crypto";
import { createSupabaseServerClient, createSupabaseServiceClient } from "@/server/integrations/supabase/server";
import type { Database } from "@/server/integrations/supabase/database.types";
import { mapError } from "@/shared/utils/error";

type LoyaltyAccountRow = Database["public"]["Tables"]["loyalty_accounts"]["Row"];
type LoyaltySettingsRow = Database["public"]["Tables"]["loyalty_settings"]["Row"];
type LoyaltyRewardRow = Database["public"]["Tables"]["loyalty_rewards"]["Row"];

export interface LoyaltyAccountSummary {
  id: string;
  organizationId: string;
  storeId: string;
  customerId: string;
  pointsBalance: number;
}

export interface LoyaltySettingsSummary {
  id?: string;
  organizationId: string;
  storeId: string;
  pointsPerCurrency: number;
  earnEnabled: boolean;
  redeemEnabled: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface LoyaltyReward {
  id: string;
  organizationId: string;
  storeId: string;
  name: string;
  description?: string;
  pointsCost: number;
  stockQuantity?: number | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface LoyaltyRewardSaveInput {
  id?: string | null;
  organizationId: string;
  storeId: string;
  name: string;
  description?: string | null;
  pointsCost: number;
  stockQuantity?: number | null;
  isActive?: boolean;
}

function mapLoyaltyAccount(row: LoyaltyAccountRow): LoyaltyAccountSummary {
  return {
    id: row.id,
    organizationId: row.organization_id,
    storeId: row.store_id,
    customerId: row.customer_id,
    pointsBalance: row.points_balance,
  };
}

function mapLoyaltySettings(row: LoyaltySettingsRow): LoyaltySettingsSummary {
  return {
    id: row.id,
    organizationId: row.organization_id,
    storeId: row.store_id,
    pointsPerCurrency: row.points_per_currency,
    earnEnabled: row.earn_enabled,
    redeemEnabled: row.redeem_enabled,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapLoyaltyReward(row: LoyaltyRewardRow): LoyaltyReward {
  return {
    id: row.id,
    organizationId: row.organization_id,
    storeId: row.store_id,
    name: row.name,
    description: row.description ?? undefined,
    pointsCost: row.points_cost,
    stockQuantity: row.stock_quantity,
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function getLoyaltyAccountForCustomer(
  storeId: string,
  organizationId: string,
  customerId: string,
  options: { createIfMissing?: boolean } = {},
) {
  const supabase = await createSupabaseServerClient();
  const existing = await supabase
    .from("loyalty_accounts")
    .select("*")
    .eq("store_id", storeId)
    .eq("organization_id", organizationId)
    .eq("customer_id", customerId)
    .maybeSingle();

  if (existing.error) return { data: null, error: mapError(existing.error) };
  if (existing.data) return { data: mapLoyaltyAccount(existing.data), error: null };
  if (!options.createIfMissing) return { data: null, error: null };

  const created = await supabase
    .from("loyalty_accounts")
    .upsert(
      {
        organization_id: organizationId,
        store_id: storeId,
        customer_id: customerId,
      },
      { onConflict: "store_id,customer_id" },
    )
    .select("*")
    .single();

  if (created.error) return { data: null, error: mapError(created.error) };
  return { data: mapLoyaltyAccount(created.data), error: null };
}

export async function getLoyaltySettingsForStore(storeId: string, organizationId: string) {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("loyalty_settings")
    .select("*")
    .eq("store_id", storeId)
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (error) return { data: null, error: mapError(error) };
  if (!data) {
    return {
      data: {
        organizationId,
        storeId,
        pointsPerCurrency: 0.01,
        earnEnabled: true,
        redeemEnabled: false,
      },
      error: null,
    };
  }
  return { data: mapLoyaltySettings(data), error: null };
}

export async function listLoyaltyRewardsForStore(storeId: string, options: { includeInactive?: boolean } = {}) {
  const supabase = await createSupabaseServerClient();
  let query = supabase
    .from("loyalty_rewards")
    .select("*")
    .eq("store_id", storeId)
    .order("updated_at", { ascending: false });

  if (!options.includeInactive) query = query.eq("is_active", true);

  const { data, error } = await query;
  if (error) return { data: null, error: mapError(error) };
  return { data: (data ?? []).map(mapLoyaltyReward), error: null };
}

export async function saveLoyaltyReward(input: LoyaltyRewardSaveInput) {
  const supabase = await createSupabaseServerClient();
  const payload = {
    organization_id: input.organizationId,
    store_id: input.storeId,
    name: input.name.trim(),
    description: input.description?.trim() || null,
    points_cost: Math.floor(input.pointsCost),
    stock_quantity: input.stockQuantity ?? null,
    is_active: input.isActive ?? true,
    updated_at: new Date().toISOString(),
  };

  const result = input.id
    ? await supabase
        .from("loyalty_rewards")
        .update(payload)
        .eq("id", input.id)
        .eq("store_id", input.storeId)
        .select("*")
        .single()
    : await supabase
        .from("loyalty_rewards")
        .insert(payload)
        .select("*")
        .single();

  if (result.error) return { data: null, error: mapError(result.error) };
  return { data: mapLoyaltyReward(result.data), error: null };
}

export async function deleteLoyaltyReward(id: string, storeId: string) {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase
    .from("loyalty_rewards")
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("store_id", storeId)
    .select("id")
    .single();
  if (error) return { error: mapError(error) };
  return { error: null };
}

export async function adjustCustomerPoints(input: {
  organizationId: string;
  storeId: string;
  customerId: string;
  pointsDelta: number;
  reason?: string | null;
}) {
  const supabase = await createSupabaseServiceClient();
  const { data, error } = await supabase.rpc("adjust_customer_loyalty_points", {
    p_organization_id: input.organizationId,
    p_store_id: input.storeId,
    p_customer_id: input.customerId,
    p_points_delta: Math.trunc(input.pointsDelta),
    p_reason: input.reason ?? null,
    p_idempotency_key: `manual:${randomUUID()}`,
  });

  if (error) return { data: null, error: mapError(error) };
  return { data, error: null };
}

export async function redeemRewardForCurrentCustomer(input: {
  organizationId: string;
  storeId: string;
  customerId: string;
  rewardId: string;
  idempotencyKey?: string;
}) {
  const supabase = await createSupabaseServiceClient();
  const { data, error } = await supabase.rpc("redeem_loyalty_reward", {
    p_organization_id: input.organizationId,
    p_store_id: input.storeId,
    p_customer_id: input.customerId,
    p_reward_id: input.rewardId,
    p_idempotency_key: input.idempotencyKey ?? `reward:${randomUUID()}`,
  });

  if (error) return { data: null, error: mapError(error) };
  return { data, error: null };
}

export async function saveLoyaltySettings(input: {
  organizationId: string;
  storeId: string;
  pointsPerCurrency: number;
  earnEnabled: boolean;
  redeemEnabled: boolean;
}) {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("loyalty_settings")
    .upsert(
      {
        organization_id: input.organizationId,
        store_id: input.storeId,
        points_per_currency: input.pointsPerCurrency,
        earn_enabled: input.earnEnabled,
        redeem_enabled: input.redeemEnabled,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "store_id" },
    )
    .select("*")
    .single();

  if (error) return { data: null, error: mapError(error) };
  return { data: mapLoyaltySettings(data), error: null };
}
