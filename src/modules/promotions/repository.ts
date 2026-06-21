import { createSupabaseServerClient } from "@/server/integrations/supabase/server";
import { mapError } from "@/shared/utils/error";
import type { Database } from "@/server/integrations/supabase/database.types";
import type { CouponPolicy } from "./types";
import { normalizeCouponCode } from "./coupon-policy";

type CouponRow = Database["public"]["Tables"]["coupons"]["Row"];

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

  const [globalCountRes, customerCountRes] = await Promise.all([
    supabase
      .from("coupon_redemptions")
      .select("id", { count: "exact", head: true })
      .eq("store_id", storeId)
      .eq("coupon_id", coupon.id)
      .is("voided_at", null),
    customerId
      ? supabase
          .from("coupon_redemptions")
          .select("id", { count: "exact", head: true })
          .eq("store_id", storeId)
          .eq("coupon_id", coupon.id)
          .eq("customer_id", customerId)
          .is("voided_at", null)
      : Promise.resolve({ count: 0, error: null }),
  ]);

  if (globalCountRes.error) return { data: null, error: mapError(globalCountRes.error) };
  if (customerCountRes.error) return { data: null, error: mapError(customerCountRes.error) };

  return {
    data: mapCoupon(coupon, globalCountRes.count ?? 0, customerCountRes.count ?? 0),
    error: null,
  };
}
