import { createSupabaseServerClient } from "@/server/integrations/supabase/server";
import { mapError } from "@/shared/utils/error";
import type { Database } from "@/server/integrations/supabase/database.types";
import type { CouponPolicy } from "./types";
import { normalizeCouponCode } from "./coupon-policy";

type CouponRow = Database["public"]["Tables"]["coupons"]["Row"];
type CouponDiscountType = Database["public"]["Tables"]["coupons"]["Insert"]["discount_type"];

export interface CouponSaveInput {
  id?: string | null;
  organizationId: string;
  storeId: string;
  code: string;
  name: string;
  discountType: CouponDiscountType;
  discountValue: number;
  minSubtotal?: number;
  startsAt?: string | null;
  endsAt?: string | null;
  maxRedemptions?: number | null;
  maxRedemptionsPerCustomer?: number | null;
  customerIds?: string[];
  stackableWithManualDiscount?: boolean;
  isActive?: boolean;
}

function mapCoupon(row: CouponRow, redeemedCount: number, customerRedeemedCount: number): CouponPolicy {
  return {
    id: row.id,
    storeId: row.store_id,
    code: row.code,
    name: row.name,
    discountType: row.discount_type,
    discountValue: row.discount_value,
    minSubtotal: row.min_subtotal,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    isActive: row.is_active,
    maxRedemptions: row.max_redemptions,
    redeemedCount,
    maxRedemptionsPerCustomer: row.max_redemptions_per_customer,
    customerRedeemedCount,
    customerIds: row.customer_ids,
    stackableWithManualDiscount: row.stackable_with_manual_discount,
  };
}

async function getCouponRedemptionCounts(storeId: string, couponId: string, customerId?: string | null) {
  const supabase = await createSupabaseServerClient();
  const [globalCountRes, customerCountRes] = await Promise.all([
    supabase
      .from("coupon_redemptions")
      .select("id", { count: "exact", head: true })
      .eq("store_id", storeId)
      .eq("coupon_id", couponId)
      .is("voided_at", null),
    customerId
      ? supabase
          .from("coupon_redemptions")
          .select("id", { count: "exact", head: true })
          .eq("store_id", storeId)
          .eq("coupon_id", couponId)
          .eq("customer_id", customerId)
          .is("voided_at", null)
      : Promise.resolve({ count: 0, error: null }),
  ]);

  if (globalCountRes.error) return { data: null, error: mapError(globalCountRes.error) };
  if (customerCountRes.error) return { data: null, error: mapError(customerCountRes.error) };
  return {
    data: {
      redeemedCount: globalCountRes.count ?? 0,
      customerRedeemedCount: customerCountRes.count ?? 0,
    },
    error: null,
  };
}

export async function listCouponsForStore(storeId: string, options: { includeInactive?: boolean } = {}) {
  const supabase = await createSupabaseServerClient();
  let query = supabase
    .from("coupons")
    .select("*")
    .eq("store_id", storeId)
    .order("updated_at", { ascending: false });

  if (!options.includeInactive) query = query.eq("is_active", true);

  const { data, error } = await query;
  if (error) return { data: null, error: mapError(error) };

  const mapped = await Promise.all(
    (data ?? []).map(async (coupon) => {
      const counts = await getCouponRedemptionCounts(storeId, coupon.id);
      if (counts.error) return { data: null, error: counts.error };
      return {
        data: mapCoupon(coupon, counts.data?.redeemedCount ?? 0, 0),
        error: null,
      };
    }),
  );
  const firstError = mapped.find((coupon) => coupon.error)?.error ?? null;
  if (firstError) return { data: null, error: firstError };
  return { data: mapped.map((coupon) => coupon.data).filter(Boolean) as CouponPolicy[], error: null };
}

export async function findCouponPolicyByCode(
  storeId: string,
  code: string,
  customerId?: string | null,
) {
  const normalizedCode = normalizeCouponCode(code);
  if (!normalizedCode) return { data: null, error: null };

  const supabase = await createSupabaseServerClient();
  const { data: coupon, error } = await supabase
    .from("coupons")
    .select("*")
    .eq("store_id", storeId)
    .eq("normalized_code", normalizedCode)
    .maybeSingle();
  if (error) return { data: null, error: mapError(error) };
  if (!coupon) return { data: null, error: null };

  const counts = await getCouponRedemptionCounts(storeId, coupon.id, customerId);
  if (counts.error) return { data: null, error: counts.error };

  return { data: mapCoupon(coupon, counts.data?.redeemedCount ?? 0, counts.data?.customerRedeemedCount ?? 0), error: null };
}

export async function saveCoupon(input: CouponSaveInput) {
  const supabase = await createSupabaseServerClient();
  const normalizedCode = normalizeCouponCode(input.code);
  let existingCoupon: CouponRow | null = null;

  if (input.id) {
    const existingRes = await supabase
      .from("coupons")
      .select("*")
      .eq("id", input.id)
      .eq("store_id", input.storeId)
      .single();
    if (existingRes.error) return { data: null, error: mapError(existingRes.error) };
    existingCoupon = existingRes.data;
  }

  const payload = {
    organization_id: input.organizationId,
    store_id: input.storeId,
    code: normalizedCode,
    normalized_code: normalizeCouponCode(input.code),
    name: input.name.trim(),
    discount_type: input.discountType,
    discount_value: input.discountValue,
    min_subtotal: input.minSubtotal ?? existingCoupon?.min_subtotal ?? 0,
    starts_at: input.startsAt !== undefined ? input.startsAt : existingCoupon?.starts_at ?? null,
    ends_at: input.endsAt !== undefined ? input.endsAt : existingCoupon?.ends_at ?? null,
    max_redemptions:
      input.maxRedemptions !== undefined ? input.maxRedemptions : existingCoupon?.max_redemptions ?? null,
    max_redemptions_per_customer:
      input.maxRedemptionsPerCustomer !== undefined
        ? input.maxRedemptionsPerCustomer
        : existingCoupon?.max_redemptions_per_customer ?? null,
    customer_ids: input.customerIds !== undefined ? input.customerIds : existingCoupon?.customer_ids ?? [],
    stackable_with_manual_discount:
      input.stackableWithManualDiscount ?? existingCoupon?.stackable_with_manual_discount ?? false,
    is_active: input.isActive ?? existingCoupon?.is_active ?? true,
    updated_at: new Date().toISOString(),
  };

  const result = input.id
    ? await supabase
        .from("coupons")
        .update(payload)
        .eq("id", input.id)
        .eq("store_id", input.storeId)
        .select("*")
        .single()
    : await supabase
        .from("coupons")
        .insert(payload)
        .select("*")
        .single();

  if (result.error) return { data: null, error: mapError(result.error) };
  const counts = await getCouponRedemptionCounts(input.storeId, result.data.id);
  if (counts.error) return { data: null, error: counts.error };
  return { data: mapCoupon(result.data, counts.data?.redeemedCount ?? 0, 0), error: null };
}

export async function deleteCoupon(id: string, storeId: string) {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase
    .from("coupons")
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("store_id", storeId)
    .select("id")
    .single();
  if (error) return { error: mapError(error) };
  return { error: null };
}
