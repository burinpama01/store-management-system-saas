"use server";

import { getCurrentUser, getUserStores, resolveCurrentStore } from "@/modules/auth/session";
import { getResolvedCurrentPermissions, requireFeature, requirePermission } from "@/modules/auth/guards";
import {
  createProduct,
  createVariant,
  findProductByBarcode,
  listCategories,
  createCategory,
  listProducts,
  replaceProductUnits,
  type BarcodeProductMatch,
  type ProductUnitInput,
} from "@/modules/catalog/repository";
import { normalizePriceTier } from "@/modules/pos/pricing";
import { listOrdersHistory } from "@/modules/pos/order-repository";
import { searchCustomersForStore } from "@/modules/customers/repository";
import type { CustomerProfile } from "@/modules/customers/types";
import {
  closeGroceryOrderPaymentWithRewards,
  voidGroceryOrderWithRewards,
} from "@/modules/grocery-pos/order-repository";
import {
  createTrustedGroceryOrder,
  mapGroceryCouponError,
  resolveTrustedPriceTier,
} from "@/modules/grocery-pos/checkout-service";
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
  priceTier?: string | null,
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

    const tierRes = await resolveTrustedPriceTier(ctx.storeId, customerId, priceTier);
    if (tierRes.error) {
      return { couponId: null, discount: 0, normalizedCode: null, error: tierRes.error };
    }

    const trustedCart = buildTrustedCartFromCatalog(cart, productsRes.data, {
      storeId: ctx.storeId,
      canDiscount: resolved.can("pos.discount"),
      priceTier: tierRes.tier,
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
  priceTier?: string | null;
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
      priceTier: normalizePriceTier(input.priceTier),
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

export interface GroceryOrdersHistoryActionInput {
  fromDate?: string;
  toDate?: string;
  limit?: number;
}

/** ประวัติบิลย้อนหลังสำหรับหน้า POS ขายส่ง (กรองตามวันที่ เวลาท้องถิ่นร้าน) */
export async function listGroceryOrdersHistoryAction(
  input: GroceryOrdersHistoryActionInput = {},
): Promise<{ orders: Order[]; error: string | null }> {
  try {
    await requirePermission("pos.use");
    await requireFeature("groceryPos");
    const { ctx } = await getStoreContext();
    const result = await listOrdersHistory(ctx.storeId, ctx.storeTimezone, {
      fromDate: input.fromDate,
      toDate: input.toDate,
      limit: input.limit ?? 100,
    });
    if (result.error) return { orders: [], error: result.error.userMessage };
    return { orders: result.data ?? [], error: null };
  } catch (e) {
    return { orders: [], error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}

export interface QuickAddGroceryProductInput {
  name: string;
  barcode?: string | null;
  basePrice: number;
  unitLabel?: string | null;
  priceWholesale?: number | null;
  priceAgent?: number | null;
  priceRegular?: number | null;
  /** ระบุจำนวนสต๊อกเริ่มต้น = เปิดติดตามสต๊อก (สร้าง variant "มาตรฐาน" ให้อัตโนมัติ) */
  initialStock?: number | null;
  units?: Array<{
    name: string;
    quantity: number;
    price: number;
    priceWholesale?: number | null;
    priceAgent?: number | null;
    priceRegular?: number | null;
    barcode?: string | null;
  }>;
}

const QUICK_ADD_DEFAULT_CATEGORY = "สินค้าทั่วไป";

/** เพิ่มสินค้าเร็วจากหน้า POS ขายส่ง: ชื่อ+บาร์โค้ด+ราคา(หลายระดับ)+สต๊อก+หน่วยโหล/แพ็ค จบในคำสั่งเดียว */
export async function quickAddGroceryProductAction(
  input: QuickAddGroceryProductInput,
): Promise<{ ok: boolean; error: string | null }> {
  try {
    await requirePermission("catalog.manage");
    await requireFeature("groceryPos");
    const { ctx } = await getStoreContext();

    const name = input.name.trim();
    if (!name) return { ok: false, error: "กรุณากรอกชื่อสินค้า" };
    if (!Number.isFinite(input.basePrice) || input.basePrice < 0) {
      return { ok: false, error: "ราคาสินค้าไม่ถูกต้อง" };
    }
    const units: ProductUnitInput[] = (input.units ?? [])
      .filter((unit) => unit.name.trim())
      .map((unit, index) => ({
        name: unit.name,
        quantity: Math.floor(unit.quantity),
        price: unit.price,
        priceWholesale: unit.priceWholesale ?? null,
        priceAgent: unit.priceAgent ?? null,
        priceRegular: unit.priceRegular ?? null,
        barcode: unit.barcode ?? null,
        sortOrder: index,
      }));
    for (const unit of units) {
      if (!Number.isInteger(unit.quantity) || unit.quantity < 2) {
        return { ok: false, error: "จำนวนต่อหน่วยแพ็คต้องเป็นจำนวนเต็มตั้งแต่ 2 ขึ้นไป" };
      }
      if (!Number.isFinite(unit.price) || unit.price < 0) {
        return { ok: false, error: "ราคาต่อหน่วยแพ็คไม่ถูกต้อง" };
      }
    }

    const categoriesRes = await listCategories(ctx.storeId);
    if (categoriesRes.error) return { ok: false, error: categoriesRes.error.userMessage };
    let categoryId = (categoriesRes.data ?? []).find(
      (category) => category.name === QUICK_ADD_DEFAULT_CATEGORY,
    )?.id ?? (categoriesRes.data ?? [])[0]?.id;
    if (!categoryId) {
      const createdCategory = await createCategory({
        organization_id: ctx.organizationId,
        store_id: ctx.storeId,
        name: QUICK_ADD_DEFAULT_CATEGORY,
      });
      if (createdCategory.error || !createdCategory.data) {
        return { ok: false, error: createdCategory.error?.userMessage ?? "สร้างหมวดหมู่ไม่สำเร็จ" };
      }
      categoryId = createdCategory.data.id;
    }

    const productRes = await createProduct({
      storeId: ctx.storeId,
      organizationId: ctx.organizationId,
      categoryId,
      name,
      barcode: input.barcode?.trim() || undefined,
      basePrice: input.basePrice,
      unitLabel: input.unitLabel?.trim() || null,
      priceWholesale: input.priceWholesale ?? null,
      priceAgent: input.priceAgent ?? null,
      priceRegular: input.priceRegular ?? null,
      availableForPos: true,
      availableForQr: false,
    });
    if (productRes.error || !productRes.data) {
      return { ok: false, error: productRes.error?.userMessage ?? "สร้างสินค้าไม่สำเร็จ" };
    }

    const initialStock = input.initialStock;
    if (typeof initialStock === "number" && Number.isFinite(initialStock)) {
      const variantRes = await createVariant({
        productId: productRes.data.id,
        name: "มาตรฐาน",
        priceAdjustment: 0,
        trackStock: true,
        stockQuantity: Math.max(0, Math.floor(initialStock)),
      });
      if (variantRes.error) return { ok: false, error: variantRes.error.userMessage };
    }

    if (units.length > 0) {
      const unitsRes = await replaceProductUnits(productRes.data.id, ctx.storeId, units);
      if (unitsRes.error) return { ok: false, error: unitsRes.error.userMessage };
    }

    return { ok: true, error: null };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
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
