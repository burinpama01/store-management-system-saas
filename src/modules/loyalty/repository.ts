import { randomUUID } from "node:crypto";
import { createSupabaseServerClient, createSupabaseServiceClient } from "@/server/integrations/supabase/server";
import type { Database } from "@/server/integrations/supabase/database.types";
import { mapError } from "@/shared/utils/error";
import { roundPoints } from "@/shared/utils/points";

type LoyaltySettingsRow = Database["public"]["Tables"]["loyalty_settings"]["Row"];
type LoyaltyRewardRow = Database["public"]["Tables"]["loyalty_rewards"]["Row"];

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

export type LoyaltyRewardType = "discount" | "product";
export type LoyaltyRewardDiscountKind = "amount" | "percentage";
export type LoyaltyRewardCodeMode = "auto" | "manual";

export interface LoyaltyReward {
  id: string;
  organizationId: string;
  storeId: string;
  name: string;
  description?: string;
  pointsCost: number;
  stockQuantity?: number | null;
  rewardType: LoyaltyRewardType;
  discountKind?: LoyaltyRewardDiscountKind | null;
  discountValue?: number | null;
  rewardProductId?: string | null;
  imageUrl?: string | null;
  codeMode: LoyaltyRewardCodeMode;
  manualCode?: string | null;
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
  rewardType: LoyaltyRewardType;
  discountKind?: LoyaltyRewardDiscountKind | null;
  discountValue?: number | null;
  rewardProductId?: string | null;
  imageUrl?: string | null;
  codeMode: LoyaltyRewardCodeMode;
  manualCode?: string | null;
  isActive?: boolean;
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
    rewardType: row.reward_type,
    discountKind: row.discount_kind,
    discountValue: row.discount_value,
    rewardProductId: row.reward_product_id,
    imageUrl: row.image_url,
    codeMode: row.code_mode,
    manualCode: row.manual_code,
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * ประวัติแต้มของลูกค้าหนึ่งราย (audit trail)
 *
 * เดิมระบบเขียน loyalty_ledger ทุกครั้งที่ได้/ใช้/ปรับแต้ม แต่ไม่มีที่ให้อ่านเลยสักที่
 * (audit ข้อ 7) เวลาลูกค้าทักว่า "แต้มหาย" พนักงานจึงตอบไม่ได้ว่าหายตอนไหน
 *
 * อ่านผ่าน user-scoped client — RLS "store member can read" คุมให้เห็นเฉพาะร้านตัวเอง
 */
export async function listLoyaltyLedgerForCustomer(
  storeId: string,
  customerId: string,
  options: { limit?: number } = {},
) {
  const supabase = await createSupabaseServerClient();
  const safeLimit = Math.min(Math.max(Math.floor(options.limit ?? 50), 1), 200);
  const { data, error } = await supabase
    .from("loyalty_ledger")
    .select("id, type, points_delta, reason, order_id, created_at")
    .eq("store_id", storeId)
    .eq("customer_id", customerId)
    .order("created_at", { ascending: false })
    .limit(safeLimit);

  if (error) return { data: null, error: mapError(error) };
  return {
    data: (data ?? []).map((row) => ({
      id: row.id,
      type: row.type,
      pointsDelta: row.points_delta,
      reason: row.reason,
      orderId: row.order_id,
      createdAt: row.created_at,
    })),
    error: null,
  };
}

export interface LoyaltyLedgerEntry {
  id: string;
  type: "earn" | "redeem" | "reversal" | "adjustment";
  pointsDelta: number;
  reason: string | null;
  orderId: string | null;
  createdAt: string;
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
        // ให้ตรงกับ default ของฐานข้อมูล (loyalty_settings.redeem_enabled default true)
        // ไม่งั้นร้านที่ยังไม่เคยตั้งค่าจะเห็น "ปิด" ทั้งที่จริงแลกได้
        redeemEnabled: true,
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
  const isDiscount = input.rewardType === "discount";
  const payload = {
    organization_id: input.organizationId,
    store_id: input.storeId,
    name: input.name.trim(),
    description: input.description?.trim() || null,
    points_cost: Math.floor(input.pointsCost),
    stock_quantity: input.stockQuantity ?? null,
    reward_type: input.rewardType,
    discount_kind: isDiscount ? (input.discountKind ?? "amount") : null,
    discount_value: isDiscount ? (input.discountValue ?? null) : null,
    reward_product_id: isDiscount ? null : (input.rewardProductId ?? null),
    image_url: input.imageUrl?.trim() || null,
    code_mode: input.codeMode,
    manual_code: input.codeMode === "manual" ? (input.manualCode?.trim() || null) : null,
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
    p_points_delta: roundPoints(input.pointsDelta),
    p_reason: input.reason ?? null,
    p_idempotency_key: `manual:${randomUUID()}`,
  });

  if (error) return { data: null, error: mapError(error) };
  return { data, error: null };
}

export interface RewardVoucherResult {
  redemptionId: string;
  voucherCode: string;
  rewardType: LoyaltyRewardType;
  rewardName: string;
  discountKind: LoyaltyRewardDiscountKind | null;
  discountValue: number | null;
  expiresAt: string;
}

function parseRewardVoucher(data: unknown): RewardVoucherResult | null {
  if (!data || typeof data !== "object") return null;
  const row = data as Record<string, unknown>;
  if (typeof row.voucher_code !== "string") return null;
  return {
    redemptionId: String(row.redemption_id ?? ""),
    voucherCode: row.voucher_code,
    rewardType: row.reward_type === "discount" ? "discount" : "product",
    rewardName: typeof row.reward_name === "string" ? row.reward_name : "",
    discountKind:
      row.discount_kind === "amount" || row.discount_kind === "percentage" ? row.discount_kind : null,
    discountValue: typeof row.discount_value === "number" ? row.discount_value : null,
    expiresAt: typeof row.expires_at === "string" ? row.expires_at : "",
  };
}

export async function redeemRewardForCurrentCustomer(input: {
  organizationId: string;
  storeId: string;
  customerId: string;
  rewardId: string;
  idempotencyKey?: string;
}) {
  // ด่านเดียวของการแลกของรางวัล — ร้านที่ปิด "เปิดแลกแต้ม" ต้องแลกไม่ได้จริง
  // (เดิมเก็บค่าไว้เฉย ๆ ไม่มีที่ไหน enforce เลย ปิดแล้วสมาชิกยังแลกได้)
  const settings = await getLoyaltySettingsForStore(input.storeId, input.organizationId);
  if (settings.error) return { data: null, error: settings.error };
  if (!settings.data?.redeemEnabled) {
    return {
      data: null,
      error: {
        code: "loyalty_redeem_disabled",
        message: "redeem disabled for store",
        userMessage: "ร้านปิดการแลกของรางวัลอยู่",
      },
    };
  }

  const supabase = await createSupabaseServiceClient();
  const { data, error } = await supabase.rpc("redeem_loyalty_reward", {
    p_organization_id: input.organizationId,
    p_store_id: input.storeId,
    p_customer_id: input.customerId,
    p_reward_id: input.rewardId,
    p_idempotency_key: input.idempotencyKey ?? `reward:${randomUUID()}`,
  });

  if (error) return { data: null, error: mapError(error) };
  return { data: parseRewardVoucher(data), error: null };
}

export interface ProductRewardVoucher {
  redemptionId: string;
  rewardId: string;
  productId: string;
  rewardName: string;
  voucherCode: string;
}

function normalizeVoucherCode(code: string) {
  return code.trim().replace(/\s+/g, "").toUpperCase();
}

/**
 * Resolve a *product* reward voucher (not a discount coupon) by its code.
 * Returns null when the code is unknown, already used, expired, or not a product reward.
 */
export async function findProductRewardVoucher(storeId: string, code: string) {
  const normalized = normalizeVoucherCode(code);
  if (!normalized) return { data: null, error: null };

  const supabase = await createSupabaseServiceClient();
  const { data: redemption, error } = await supabase
    .from("loyalty_reward_redemptions")
    .select("*")
    .eq("store_id", storeId)
    .eq("voucher_code", normalized)
    .maybeSingle();
  if (error) return { data: null, error: mapError(error) };
  if (!redemption) return { data: null, error: null };
  if (redemption.used_at || redemption.status !== "pending") return { data: null, error: null };
  if (redemption.expires_at && new Date(redemption.expires_at).getTime() < Date.now()) {
    return { data: null, error: null };
  }

  const { data: reward, error: rewardErr } = await supabase
    .from("loyalty_rewards")
    .select("id, name, reward_type, reward_product_id")
    .eq("id", redemption.reward_id)
    .eq("store_id", storeId)
    .maybeSingle();
  if (rewardErr) return { data: null, error: mapError(rewardErr) };
  if (!reward || reward.reward_type !== "product" || !reward.reward_product_id) {
    return { data: null, error: null };
  }

  return {
    data: {
      redemptionId: redemption.id,
      rewardId: reward.id,
      productId: reward.reward_product_id,
      rewardName: reward.name,
      voucherCode: redemption.voucher_code as string,
    } as ProductRewardVoucher,
    error: null,
  };
}

/**
 * Atomically reserve a product reward voucher BEFORE the order is created
 * (single-use guard via `used_at is null`). Returns reserved=false if another
 * checkout already used it. Pair with attachRewardVoucherOrder on success or
 * releaseProductRewardVoucher if the order ultimately fails.
 */
export async function reserveProductRewardVoucher(storeId: string, redemptionId: string) {
  const supabase = await createSupabaseServiceClient();
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from("loyalty_reward_redemptions")
    .update({ status: "fulfilled", used_at: now, fulfilled_at: now })
    .eq("store_id", storeId)
    .eq("id", redemptionId)
    .is("used_at", null)
    .select("id")
    .maybeSingle();
  if (error) return { reserved: false, error: mapError(error) };
  return { reserved: Boolean(data), error: null };
}

/** Link a reserved reward voucher to the order it was redeemed on (best-effort). */
export async function attachRewardVoucherOrder(storeId: string, redemptionId: string, orderId: string) {
  const supabase = await createSupabaseServiceClient();
  const { error } = await supabase
    .from("loyalty_reward_redemptions")
    .update({ used_order_id: orderId })
    .eq("store_id", storeId)
    .eq("id", redemptionId);
  return { error: error ? mapError(error) : null };
}

/** Revert a reserved reward voucher back to usable (compensating action on failure). */
export async function releaseProductRewardVoucher(storeId: string, redemptionId: string) {
  const supabase = await createSupabaseServiceClient();
  const { error } = await supabase
    .from("loyalty_reward_redemptions")
    .update({ status: "pending", used_at: null, used_order_id: null, fulfilled_at: null })
    .eq("store_id", storeId)
    .eq("id", redemptionId);
  return { error: error ? mapError(error) : null };
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
