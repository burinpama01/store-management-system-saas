import { createSupabaseServerClient } from "@/server/integrations/supabase/server";
import { mapError } from "@/shared/utils/error";
import { generateOrderNumber } from "@/modules/pos/order-number";
import { getOrder } from "@/modules/pos/order-repository";
import type { AddPaymentInput } from "@/modules/pos/order-repository";
import type { Cart } from "@/modules/pos/types";
import type { Json } from "@/server/integrations/supabase/database.types";

export interface CreateGroceryOrderWithRewardsInput {
  storeId: string;
  organizationId: string;
  cashierId: string;
  storeTimezone?: string;
  cart: Cart;
  customerId?: string | null;
  couponId?: string | null;
  couponDiscountAmount?: number;
  idempotencyKey: string;
  note?: string;
}

export async function createGroceryOrderWithRewards(input: CreateGroceryOrderWithRewardsInput) {
  const supabase = await createSupabaseServerClient();
  const orderNumber = generateOrderNumber({ timeZone: input.storeTimezone });
  const items = input.cart.items.map((item) => ({
    product_id: item.productId,
    product_name: item.productName,
    variant_id: item.variant?.id ?? null,
    variant_name: item.variant?.name ?? null,
    unit_id: item.unit?.id ?? null,
    unit_name: item.unit?.name ?? null,
    unit_quantity: item.unit?.quantity ?? 1,
    modifiers: item.modifiers,
    quantity: item.quantity,
    unit_price: item.unitPrice,
    total_price: item.totalPrice,
    discount_amount: item.discount ?? 0,
    discount_type: item.discountType ?? null,
    discount_value: item.discountValue ?? null,
    discount_note: item.discountNote ?? null,
    note: item.note ?? null,
  })) as unknown as Json;

  const { data: orderId, error } = await supabase.rpc("create_grocery_pos_order_with_rewards", {
    p_organization_id: input.organizationId,
    p_store_id: input.storeId,
    p_order_number: orderNumber,
    p_cashier_id: input.cashierId,
    p_customer_id: input.customerId ?? null,
    p_coupon_id: input.couponId ?? null,
    p_coupon_discount_amount: input.couponDiscountAmount ?? 0,
    p_subtotal: input.cart.subtotal,
    p_discount: input.cart.discount,
    p_discount_note: input.cart.discountNote ?? null,
    p_total: input.cart.total,
    p_note: input.note ?? null,
    p_items: items,
    p_idempotency_key: input.idempotencyKey,
  });

  if (error || !orderId) {
    return { data: null, error: mapError(error ?? new Error("ไม่สามารถสร้างออร์เดอร์ร้านของชำได้")) };
  }

  return getOrder(orderId);
}

export interface ReplayGroceryOrderWithSyncInput extends CreateGroceryOrderWithRewardsInput {
  deviceId: string;
  catalogVersion: string;
  operationPayload: Json;
}

export async function replayGroceryOrderWithSync(input: ReplayGroceryOrderWithSyncInput) {
  const supabase = await createSupabaseServerClient();
  const orderNumber = generateOrderNumber({ timeZone: input.storeTimezone });
  const items = input.cart.items.map((item) => ({
    product_id: item.productId,
    product_name: item.productName,
    variant_id: item.variant?.id ?? null,
    variant_name: item.variant?.name ?? null,
    unit_id: item.unit?.id ?? null,
    unit_name: item.unit?.name ?? null,
    unit_quantity: item.unit?.quantity ?? 1,
    modifiers: item.modifiers,
    quantity: item.quantity,
    unit_price: item.unitPrice,
    total_price: item.totalPrice,
    discount_amount: item.discount ?? 0,
    discount_type: item.discountType ?? null,
    discount_value: item.discountValue ?? null,
    discount_note: item.discountNote ?? null,
    note: item.note ?? null,
  })) as unknown as Json;

  const { data: orderId, error } = await supabase.rpc("replay_grocery_pos_create_order_with_sync", {
    p_organization_id: input.organizationId,
    p_store_id: input.storeId,
    p_device_key: input.deviceId,
    p_catalog_version: input.catalogVersion,
    p_operation_payload: input.operationPayload,
    p_order_number: orderNumber,
    p_cashier_id: input.cashierId,
    p_customer_id: input.customerId ?? null,
    p_coupon_id: input.couponId ?? null,
    p_coupon_discount_amount: input.couponDiscountAmount ?? 0,
    p_subtotal: input.cart.subtotal,
    p_discount: input.cart.discount,
    p_discount_note: input.cart.discountNote ?? null,
    p_total: input.cart.total,
    p_note: input.note ?? null,
    p_items: items,
    p_idempotency_key: input.idempotencyKey,
  });

  if (error || !orderId) {
    return { data: null, error: mapError(error ?? new Error("ไม่สามารถ sync ออร์เดอร์ร้านของชำได้")) };
  }

  return getOrder(orderId);
}

export async function getSucceededGrocerySyncOrder(input: {
  storeId: string;
  idempotencyKey: string;
}) {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("pos_sync_operations")
    .select("status, result_order_id")
    .eq("store_id", input.storeId)
    .eq("idempotency_key", input.idempotencyKey)
    .maybeSingle();

  if (error) {
    return { data: null, error: mapError(error) };
  }
  if (data?.status === "succeeded" && data.result_order_id) {
    return getOrder(data.result_order_id);
  }
  return { data: null, error: null };
}

export async function recordGrocerySyncConflict(input: {
  organizationId: string;
  storeId: string;
  deviceId: string;
  catalogVersion: string;
  operationPayload: Json;
  idempotencyKey: string;
  errorMessage?: string;
}) {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc("record_grocery_pos_sync_conflict", {
    p_organization_id: input.organizationId,
    p_store_id: input.storeId,
    p_device_key: input.deviceId,
    p_catalog_version: input.catalogVersion,
    p_operation_payload: input.operationPayload,
    p_idempotency_key: input.idempotencyKey,
    p_error_message: input.errorMessage ?? "catalog_conflict",
  });

  if (error) {
    return { ok: false, error: mapError(error) };
  }
  return { ok: true, error: null };
}

export interface CloseGroceryOrderPaymentWithRewardsInput {
  orderId: string;
  storeId: string;
  processedByUserId: string;
  payment: AddPaymentInput;
  idempotencyKey?: string | null;
}

export async function closeGroceryOrderPaymentWithRewards(
  input: CloseGroceryOrderPaymentWithRewardsInput,
) {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc("close_grocery_pos_order_payment_with_rewards", {
    p_order_id: input.orderId,
    p_store_id: input.storeId,
    p_processed_by_user_id: input.processedByUserId,
    p_method: input.payment.method,
    p_amount: input.payment.amount,
    p_received_amount: input.payment.receivedAmount ?? null,
    p_change_amount: input.payment.changeAmount ?? null,
    p_reference: input.payment.reference ?? null,
    p_idempotency_key: input.idempotencyKey ?? null,
  });

  if (error) {
    return { data: null, error: mapError(error) };
  }

  return getOrder(input.orderId);
}

export interface VoidGroceryOrderWithRewardsInput {
  orderId: string;
  storeId: string;
  voidedByUserId: string;
  reason: string;
  idempotencyKey?: string | null;
}

export async function voidGroceryOrderWithRewards(input: VoidGroceryOrderWithRewardsInput) {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc("void_grocery_pos_order_with_rewards", {
    p_order_id: input.orderId,
    p_store_id: input.storeId,
    p_voided_by_user_id: input.voidedByUserId,
    p_reason: input.reason,
    p_idempotency_key: input.idempotencyKey ?? null,
  });

  if (error) {
    return { ok: false, error: mapError(error) };
  }

  return { ok: true, error: null };
}
