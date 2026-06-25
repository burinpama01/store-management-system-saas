"use server";

import { getCurrentUser, getUserStores, resolveCurrentStore } from "@/modules/auth/session";
import { getResolvedCurrentPermissions, requireFeature, requirePermission } from "@/modules/auth/guards";
import { findProductByBarcode, listProducts, type BarcodeProductMatch } from "@/modules/catalog/repository";
import { searchCustomersForStore } from "@/modules/customers/repository";
import type { CustomerProfile } from "@/modules/customers/types";
import {
  closeGroceryOrderPaymentWithRewards,
  voidGroceryOrderWithRewards,
} from "@/modules/grocery-pos/order-repository";
import { createTrustedGroceryOrder, mapGroceryCouponError } from "@/modules/grocery-pos/checkout-service";
import { buildTrustedCartFromCatalog, CartValidationError } from "@/modules/pos/server-cart";
import { getOrder, type AddPaymentInput } from "@/modules/pos/order-repository";
import type { Order } from "@/modules/pos/types";
import type { Cart } from "@/modules/pos/types";
import { evaluateCouponForCart } from "@/modules/promotions/coupon-policy";
import { findCouponPolicyByCode } from "@/modules/promotions/repository";
import type { Json } from "@/server/integrations/supabase/database.types";

async function getStoreContext() {
  const user = await getCurrentUser();
  if (!user) throw new Error("กรุณาเข้าสู่ระบบ");
  const { organizations, stores, memberships } = await getUserStores();
  const ctx = await resolveCurrentStore(stores, organizations, memberships);
  if (!ctx) throw new Error("ไม่พบข้อมูลร้านค้า");
  return { user, ctx };
}

export async function lookupGroceryBarcodeAction(
  barcode: string,
): Promise<{ match: BarcodeProductMatch | null; error: string | null }> {
  try {
    await requirePermission("pos.use");
    await requireFeature("groceryPos");
    const { ctx } = await getStoreContext();
    const result = await findProductByBarcode(ctx.storeId, barcode);
    if (result.error) return { match: null, error: result.error.userMessage };
    if (!result.data) return { match: null, error: "ไม่พบสินค้าจากบาร์โค้ดนี้" };
    return { match: result.data, error: null };
  } catch (e) {
    return { match: null, error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}

export async function searchGroceryCustomersAction(
  query: string,
): Promise<{ customers: CustomerProfile[]; error: string | null }> {
  try {
    await requirePermission("pos.use");
    await requireFeature("groceryPos");
    await requireFeature("loyaltyPoints");
    const { ctx } = await getStoreContext();
    const result = await searchCustomersForStore(ctx.storeId, query);
    if (result.error) return { customers: [], error: result.error.userMessage };
    return { customers: result.data ?? [], error: null };
  } catch (e) {
    return { customers: [], error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}

export async function evaluateGroceryCouponAction(
  code: string,
  cart: Cart,
  customerId?: string | null,
): Promise<{
  couponId: string | null;
  discount: number;
  normalizedCode: string | null;
  error: string | null;
}> {
  try {
    const { ctx, resolved } = await getResolvedCurrentPermissions();
    if (!resolved.can("pos.use")) return { couponId: null, discount: 0, normalizedCode: null, error: "ไม่มีสิทธิ์ใช้งาน POS" };
    await requireFeature("groceryPos");
    await requireFeature("couponManagement");

    if (cart.storeId !== ctx.storeId) {
      return { couponId: null, discount: 0, normalizedCode: null, error: "ร้านค้าในตะกร้าไม่ถูกต้อง" };
    }

    const productsRes = await listProducts(ctx.storeId, { includeInactive: false });
    if (productsRes.error || !productsRes.data) {
      return { couponId: null, discount: 0, normalizedCode: null, error: productsRes.error?.userMessage ?? "ไม่พบข้อมูลสินค้า" };
    }

    const trustedCart = buildTrustedCartFromCatalog(cart, productsRes.data, {
      storeId: ctx.storeId,
      canDiscount: resolved.can("pos.discount"),
    });

    const couponRes = await findCouponPolicyByCode(ctx.storeId, code, customerId);
    if (couponRes.error) {
      return { couponId: null, discount: 0, normalizedCode: null, error: couponRes.error.userMessage };
    }
    if (!couponRes.data) {
      return { couponId: null, discount: 0, normalizedCode: null, error: "ไม่พบคูปองนี้" };
    }

    const evaluation = evaluateCouponForCart({
      coupon: couponRes.data,
      cart: trustedCart,
      code,
      customerId,
    });

    if (!evaluation.ok) {
      return {
        couponId: null,
        discount: 0,
        normalizedCode: evaluation.normalizedCode,
        error: mapGroceryCouponError(evaluation.reason),
      };
    }

    return {
      couponId: evaluation.couponId,
      discount: evaluation.discount,
      normalizedCode: evaluation.normalizedCode,
      error: null,
    };
  } catch (e) {
    if (e instanceof CartValidationError) {
      return { couponId: null, discount: 0, normalizedCode: null, error: e.message };
    }
    return { couponId: null, discount: 0, normalizedCode: null, error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}

export interface CreateGroceryOrderActionInput {
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

export async function createGroceryOrderAction(
  input: CreateGroceryOrderActionInput,
): Promise<{ order: Order | null; error: string | null }> {
  try {
    const { user, ctx, resolved } = await getResolvedCurrentPermissions();
    if (!resolved.can("pos.use")) return { order: null, error: "ไม่มีสิทธิ์ใช้งาน POS" };
    await requireFeature("groceryPos");

    const hasCoupon = !!input.couponCode || (input.clientCouponDiscountAmount ?? 0) > 0;
    if (hasCoupon) await requireFeature("couponManagement");
    if (input.sync) await requireFeature("offlinePos");
    if ((input.clientCouponDiscountAmount ?? 0) > 0 && !input.couponCode) {
      return { order: null, error: "ต้องระบุรหัสคูปอง" };
    }

    if (input.cart.storeId !== ctx.storeId) {
      return { order: null, error: "ร้านค้าในตะกร้าไม่ถูกต้อง" };
    }

    return createTrustedGroceryOrder({
      organizationId: ctx.organizationId,
      storeId: ctx.storeId,
      cashierId: user.id,
      storeTimezone: ctx.storeTimezone,
      canDiscount: resolved.can("pos.discount"),
      cart: input.cart,
      customerId: input.customerId,
      idempotencyKey: input.idempotencyKey,
      couponCode: input.couponCode,
      clientCouponDiscountAmount: input.clientCouponDiscountAmount,
      note: input.note,
      sync: input.sync,
    });
  } catch (e) {
    if (e instanceof CartValidationError) {
      return { order: null, error: e.message };
    }
    return { order: null, error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}

export interface CloseGroceryOrderPaymentActionInput {
  orderId: string;
  payment: AddPaymentInput;
  idempotencyKey?: string | null;
}

export async function closeGroceryOrderPaymentAction(
  input: CloseGroceryOrderPaymentActionInput,
): Promise<{ order: Order | null; error: string | null }> {
  try {
    const { user, ctx, resolved } = await getResolvedCurrentPermissions();
    if (!resolved.can("pos.use")) return { order: null, error: "ไม่มีสิทธิ์ใช้งาน POS" };
    await requireFeature("groceryPos");

    const orderRes = await getOrder(input.orderId);
    if (orderRes.error) return { order: null, error: orderRes.error.userMessage };
    if (orderRes.data?.storeId !== ctx.storeId) {
      return { order: null, error: "ร้านค้าในออร์เดอร์ไม่ถูกต้อง" };
    }
    if (orderRes.data?.customerId) {
      await requireFeature("loyaltyPoints");
    }

    const result = await closeGroceryOrderPaymentWithRewards({
      orderId: input.orderId,
      storeId: ctx.storeId,
      processedByUserId: user.id,
      payment: input.payment,
      idempotencyKey: input.idempotencyKey,
    });

    if (result.error) return { order: null, error: result.error.userMessage };
    return { order: result.data, error: null };
  } catch (e) {
    return { order: null, error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}

export async function voidGroceryOrderAction(
  orderId: string,
  reason: string,
): Promise<{ error: string | null }> {
  try {
    const { user, ctx, resolved } = await getResolvedCurrentPermissions();
    if (!resolved.can("pos.delete_bill")) return { error: "ไม่มีสิทธิ์ยกเลิกออร์เดอร์" };
    await requireFeature("groceryPos");

    const result = await voidGroceryOrderWithRewards({
      orderId,
      storeId: ctx.storeId,
      voidedByUserId: user.id,
      reason,
      idempotencyKey: `${orderId}:void`,
    });

    if (result.error) return { error: result.error.userMessage };
    return { error: null };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}
