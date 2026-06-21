import { findCouponPolicyByCode } from "@/modules/promotions/repository";
import { buildGroceryCheckoutCart } from "@/modules/grocery-pos/rewards";
import {
  createGroceryOrderWithRewards,
  getSucceededGrocerySyncOrder,
  recordGrocerySyncConflict,
  replayGroceryOrderWithSync,
  type CreateGroceryOrderWithRewardsInput,
} from "@/modules/grocery-pos/order-repository";
import { buildGroceryCatalogVersion } from "@/modules/grocery-pos/offline-sync";
import { buildTrustedCartFromCatalog, CartValidationError } from "@/modules/pos/server-cart";
import { listProducts } from "@/modules/catalog/repository";
import type { Cart, Order } from "@/modules/pos/types";
import type { Json } from "@/server/integrations/supabase/database.types";

export interface CreateTrustedGroceryOrderInput {
  organizationId: string;
  storeId: string;
  cashierId: string;
  storeTimezone?: string;
  canDiscount: boolean;
  cart: Cart;
  customerId?: string | null;
  couponCode?: string | null;
  clientCouponDiscountAmount?: number;
  idempotencyKey: string;
  note?: string;
  sync?: {
    deviceId: string;
    catalogVersion: string;
    operationPayload: Json;
  };
}

function couponErrorMessage(reason: string): string {
  const messages: Record<string, string> = {
    coupon_code_mismatch: "รหัสคูปองไม่ถูกต้อง",
    coupon_inactive: "คูปองนี้ปิดใช้งานแล้ว",
    coupon_wrong_store: "คูปองนี้ใช้กับร้านนี้ไม่ได้",
    coupon_not_started: "คูปองนี้ยังไม่เริ่มใช้งาน",
    coupon_expired: "คูปองนี้หมดอายุแล้ว",
    coupon_min_subtotal: "ยอดซื้อยังไม่ถึงขั้นต่ำของคูปอง",
    coupon_usage_limit: "คูปองนี้ถูกใช้ครบจำนวนแล้ว",
    coupon_customer_usage_limit: "ลูกค้าคนนี้ใช้คูปองครบจำนวนแล้ว",
    coupon_customer_required: "คูปองนี้ใช้ได้เฉพาะลูกค้าที่กำหนด",
    coupon_manual_discount_conflict: "คูปองนี้ใช้ร่วมกับส่วนลดท้ายบิลไม่ได้",
    coupon_invalid_discount: "มูลค่าคูปองไม่ถูกต้อง",
  };
  return messages[reason] ?? "คูปองนี้ใช้ไม่ได้";
}

export function mapGroceryCouponError(reason: string): string {
  return couponErrorMessage(reason);
}

export async function createTrustedGroceryOrder(
  input: CreateTrustedGroceryOrderInput,
): Promise<{ order: Order | null; error: string | null }> {
  try {
    if (input.cart.storeId !== input.storeId) {
      return { order: null, error: "ร้านค้าในตะกร้าไม่ถูกต้อง" };
    }

    const productsRes = await listProducts(input.storeId, { includeInactive: false });
    if (productsRes.error || !productsRes.data) {
      return { order: null, error: productsRes.error?.userMessage ?? "ไม่พบข้อมูลสินค้า" };
    }

    if (input.sync) {
      const existingOrder = await getSucceededGrocerySyncOrder({
        storeId: input.storeId,
        idempotencyKey: input.idempotencyKey,
      });
      if (existingOrder.error) return { order: null, error: existingOrder.error.userMessage };
      if (existingOrder.data) return { order: existingOrder.data, error: null };

      const currentCatalogVersion = buildGroceryCatalogVersion({ products: productsRes.data });
      if (input.sync.catalogVersion !== currentCatalogVersion) {
        const conflict = await recordGrocerySyncConflict({
          organizationId: input.organizationId,
          storeId: input.storeId,
          deviceId: input.sync.deviceId,
          catalogVersion: input.sync.catalogVersion,
          operationPayload: input.sync.operationPayload,
          idempotencyKey: input.idempotencyKey,
          errorMessage: "catalog_conflict",
        });
        if (conflict.error) return { order: null, error: conflict.error.userMessage };
        return { order: null, error: "catalog_conflict" };
      }
    }

    const trustedCart = buildTrustedCartFromCatalog(input.cart, productsRes.data, {
      storeId: input.storeId,
      canDiscount: input.canDiscount,
    });
    const couponRes = input.couponCode
      ? await findCouponPolicyByCode(input.storeId, input.couponCode, input.customerId)
      : { data: null, error: null };
    if (couponRes.error) return { order: null, error: couponRes.error.userMessage };

    const checkout = buildGroceryCheckoutCart({
      trustedCart,
      coupon: couponRes.data,
      couponCode: input.couponCode,
      customerId: input.customerId,
      clientCouponDiscountAmount: input.clientCouponDiscountAmount,
    });
    if (!checkout.ok) {
      return {
        order: null,
        error: checkout.error.startsWith("coupon_") ? couponErrorMessage(checkout.error) : checkout.error,
      };
    }

    const repositoryInput: CreateGroceryOrderWithRewardsInput = {
      organizationId: input.organizationId,
      storeId: input.storeId,
      cashierId: input.cashierId,
      storeTimezone: input.storeTimezone,
      cart: checkout.cart,
      customerId: input.customerId,
      couponId: checkout.couponId,
      couponDiscountAmount: checkout.couponDiscountAmount,
      idempotencyKey: input.idempotencyKey,
      note: input.note,
    };
    const result = input.sync
      ? await replayGroceryOrderWithSync({
          ...repositoryInput,
          deviceId: input.sync.deviceId,
          catalogVersion: input.sync.catalogVersion,
          operationPayload: input.sync.operationPayload,
        })
      : await createGroceryOrderWithRewards(repositoryInput);

    if (result.error) return { order: null, error: result.error.userMessage };
    return { order: result.data, error: null };
  } catch (error) {
    if (error instanceof CartValidationError) {
      return { order: null, error: error.message };
    }
    return { order: null, error: error instanceof Error ? error.message : "เกิดข้อผิดพลาด" };
  }
}
