"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { getCurrentUser, getUserStores, resolveCurrentStore } from "@/modules/auth/session";
import { getResolvedCurrentPermissions, requireFeature, requirePermission } from "@/modules/auth/guards";
import { listProducts } from "@/modules/catalog/repository";
import { searchCustomersForStore } from "@/modules/customers/repository";
import type { CustomerProfile } from "@/modules/customers/types";
import { buildGroceryCheckoutCart } from "@/modules/grocery-pos/rewards";
import { mapGroceryCouponError } from "@/modules/grocery-pos/checkout-service";
import { evaluateCouponForCart } from "@/modules/promotions/coupon-policy";
import { isCouponAttemptBlocked, recordCouponAttempt } from "@/modules/promotions/coupon-attempt-guard";
import { findCouponPolicyByCode } from "@/modules/promotions/repository";
import {
  attachRewardVoucherOrder,
  findProductRewardVoucher,
  releaseProductRewardVoucher,
  reserveProductRewardVoucher,
} from "@/modules/loyalty/repository";
import {
  createOrderWithItemsIds,
  addPaymentAndClose,
  closePosOrderPaymentWithRewards,
  createPosOrderWithCustomerRewardsIds,
  getOrder,
  getOrderPaymentContext,
  listOrdersHistory,
  listTodayOrders,
  voidOrder,
} from "@/modules/pos/order-repository";
import { listSavedTickets, saveSavedTicket, deleteSavedTicket, deleteSavedTicketAndCloseTable } from "@/modules/pos/saved-ticket-repository";
import { buildTrustedCartFromCatalog } from "@/modules/pos/server-cart";
import { cartRequestsDiscount } from "@/modules/pos/discount-policy";
import { openTableSession, closeTableSession, getStore, getTable, listManagedTables, listPrinters } from "@/modules/stores/repository";
import { listActiveQrOrders } from "@/modules/qr-ordering/repository";
import { submitQrOrderAction, type QrOrderItem } from "@/app/qr/[storeSlug]/[tableId]/actions";
import { buildTableQrUrl } from "@/modules/qr-ordering/printed-qr";
import { notifyOwnerSafely } from "@/modules/notifications/dispatcher";
import { notifyLowStockAfterSaleSafely } from "@/modules/stock/notify";
import { getOpenCashSession } from "@/modules/cashflow/repository";
import type { Cart, Order, SavedOrderTicket } from "@/modules/pos/types";
import type { AddPaymentInput } from "@/modules/pos/order-repository";
import type { QrOrderView } from "@/modules/qr-ordering/types";
import type { Printer, QrOrderingMode } from "@/modules/stores/types";

async function getStoreContext() {
  const user = await getCurrentUser();
  if (!user) throw new Error("ไม่มีสิทธิ์เข้าถึง");
  const { organizations, stores, memberships } = await getUserStores();
  const ctx = await resolveCurrentStore(stores, organizations, memberships);
  if (!ctx) throw new Error("ไม่พบข้อมูลร้านค้า");
  return { user, ctx };
}

export async function listSavedTicketsAction(): Promise<{ tickets: SavedOrderTicket[]; error: string | null }> {
  try {
    await requirePermission("pos.use");
    const { ctx } = await getStoreContext();
    const result = await listSavedTickets(ctx.storeId);
    if (result.error) return { tickets: [], error: result.error.userMessage };
    return { tickets: result.data ?? [], error: null };
  } catch (e) {
    return { tickets: [], error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}

export async function saveSavedTicketAction(ticket: SavedOrderTicket): Promise<{ ticket: SavedOrderTicket | null; error: string | null }> {
  try {
    await requirePermission("pos.use");
    const { user, ctx } = await getStoreContext();

    if (ticket.cart.storeId !== ctx.storeId) {
      return { ticket: null, error: "ตั๋วนี้ไม่ใช่ของร้านค้าปัจจุบัน" };
    }
    if (ticket.cart.items.length === 0) {
      return { ticket: null, error: "ไม่มีรายการในตั๋ว" };
    }

    const canDiscount = !cartRequestsDiscount(ticket.cart) || await requirePermission("pos.discount").then(() => true).catch(() => false);
    const productsRes = await listProducts(ctx.storeId, {
      includeInactive: false,
      productIds: Array.from(new Set(ticket.cart.items.map((item) => item.productId))),
    });
    if (productsRes.error || !productsRes.data) {
      return { ticket: null, error: productsRes.error?.userMessage ?? "ไม่สามารถตรวจสอบสินค้าได้" };
    }

    const trustedCart = buildTrustedCartFromCatalog(ticket.cart, productsRes.data, {
      storeId: ctx.storeId,
      canDiscount,
    });
    let tableContext: Pick<SavedOrderTicket, "tableId" | "tableNumber" | "buffetSessionId"> = {
      tableId: ticket.tableId,
      tableNumber: ticket.tableNumber?.trim() || undefined,
      buffetSessionId: ticket.buffetSessionId,
    };
    if (ticket.tableId) {
      const tableRes = await getTable(ticket.tableId, ctx.storeId);
      if (tableRes.error) return { ticket: null, error: tableRes.error.userMessage };
      if (!tableRes.data) return { ticket: null, error: "ไม่พบโต๊ะนี้ในร้านค้า" };
      tableContext = {
        tableId: tableRes.data.id,
        tableNumber: tableRes.data.label ?? tableRes.data.number,
        buffetSessionId: tableRes.data.currentSessionId,
      };
    }
    const trustedTicket: SavedOrderTicket = {
      ...ticket,
      ...tableContext,
      cart: trustedCart,
      label: ticket.label.trim() || ticket.ticketNumber,
      customerName: ticket.customerName?.trim() || undefined,
      note: ticket.note?.trim() || undefined,
      updatedAt: new Date().toISOString(),
    };

    const result = await saveSavedTicket({
      organizationId: ctx.organizationId,
      storeId: ctx.storeId,
      userId: user.id,
      ticket: trustedTicket,
    });
    if (result.error) return { ticket: null, error: result.error.userMessage };
    // No revalidatePath: /pos renders no ticket data server-side (tickets sync via
    // listSavedTicketsAction), and revalidating would re-render the whole catalog page.
    return { ticket: result.data, error: null };
  } catch (e) {
    return { ticket: null, error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}

export async function deleteSavedTicketAction(ticketId: string, opts?: { closeRelatedTableSession?: boolean }): Promise<{ error: string | null }> {
  try {
    await requirePermission("pos.use");
    const { ctx } = await getStoreContext();
    const result = opts?.closeRelatedTableSession
      ? await deleteSavedTicketAndCloseTable(ticketId, ctx.storeId)
      : await deleteSavedTicket(ticketId, ctx.storeId);
    if (result.error) return { error: result.error.userMessage };
    return { error: null };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}

export async function listTodayOrdersAction(): Promise<{ orders: Order[]; error: string | null }> {
  try {
    await requirePermission("pos.use");
    const { ctx } = await getStoreContext();
    const result = await listTodayOrders(ctx.storeId, ctx.storeTimezone);
    if (result.error) return { orders: [], error: result.error.userMessage };
    return { orders: result.data ?? [], error: null };
  } catch (e) {
    return { orders: [], error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}

export async function listOrdersHistoryAction(input?: {
  fromDate?: string;
  toDate?: string;
  limit?: number;
}): Promise<{ orders: Order[]; error: string | null }> {
  try {
    await requirePermission("pos.use");
    const { ctx } = await getStoreContext();
    const result = await listOrdersHistory(ctx.storeId, ctx.storeTimezone, input);
    if (result.error) return { orders: [], error: result.error.userMessage };
    return { orders: result.data ?? [], error: null };
  } catch (e) {
    return { orders: [], error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}

export async function searchPosCustomersAction(
  query: string,
): Promise<{ customers: CustomerProfile[]; error: string | null }> {
  try {
    await requirePermission("pos.use");
    await requireFeature("loyaltyPoints");
    const { ctx } = await getStoreContext();
    const result = await searchCustomersForStore(ctx.storeId, query);
    if (result.error) return { customers: [], error: result.error.userMessage };
    return { customers: result.data ?? [], error: null };
  } catch (e) {
    return { customers: [], error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}

export interface RewardProductLine {
  voucherCode: string;
  productId: string;
  productName: string;
}

export async function evaluatePosCouponAction(
  code: string,
  cart: Cart,
  customerId?: string | null,
): Promise<{
  couponId: string | null;
  discount: number;
  normalizedCode: string | null;
  rewardProduct?: RewardProductLine | null;
  error: string | null;
}> {
  try {
    const { ctx, resolved } = await getResolvedCurrentPermissions();
    if (!resolved.can("pos.use")) return { couponId: null, discount: 0, normalizedCode: null, error: "ไม่มีสิทธิ์ใช้งาน POS" };
    await requireFeature("couponManagement");

    if (cart.storeId !== ctx.storeId) {
      return { couponId: null, discount: 0, normalizedCode: null, error: "ร้านค้าในตะกร้าไม่ถูกต้อง" };
    }

    const productsRes = await listProducts(ctx.storeId, {
      includeInactive: false,
      productIds: Array.from(new Set(cart.items.map((item) => item.productId))),
    });
    if (productsRes.error || !productsRes.data) {
      return { couponId: null, discount: 0, normalizedCode: null, error: productsRes.error?.userMessage ?? "ไม่พบข้อมูลสินค้า" };
    }

    const trustedCart = buildTrustedCartFromCatalog(cart, productsRes.data, {
      storeId: ctx.storeId,
      canDiscount: resolved.can("pos.discount"),
    });

    if (await isCouponAttemptBlocked(ctx.storeId)) {
      return {
        couponId: null,
        discount: 0,
        normalizedCode: null,
        error: "กรอกรหัสคูปองผิดบ่อยเกินไป กรุณารอสักครู่แล้วลองใหม่",
      };
    }
    const organizationId = ctx.organizationId ?? null;

    const couponRes = await findCouponPolicyByCode(ctx.storeId, code, customerId);
    if (couponRes.error) {
      return { couponId: null, discount: 0, normalizedCode: null, error: couponRes.error.userMessage };
    }
    if (!couponRes.data) {
      // Not a discount coupon — it may be a product reward voucher (added as a ฿0 line, not a discount).
      const voucherRes = await findProductRewardVoucher(ctx.storeId, code);
      if (voucherRes.error) {
        return { couponId: null, discount: 0, normalizedCode: null, error: voucherRes.error.userMessage };
      }
      if (voucherRes.data) {
        await recordCouponAttempt({ organizationId, storeId: ctx.storeId, code, succeeded: true });
        return {
          couponId: null,
          discount: 0,
          normalizedCode: voucherRes.data.voucherCode,
          rewardProduct: {
            voucherCode: voucherRes.data.voucherCode,
            productId: voucherRes.data.productId,
            productName: voucherRes.data.rewardName,
          },
          error: null,
        };
      }
      await recordCouponAttempt({ organizationId, storeId: ctx.storeId, code, succeeded: false });
      return { couponId: null, discount: 0, normalizedCode: null, error: "ไม่พบคูปองนี้" };
    }

    const evaluation = evaluateCouponForCart({
      coupon: couponRes.data,
      cart: trustedCart,
      code,
      customerId,
    });
    await recordCouponAttempt({ organizationId, storeId: ctx.storeId, code, succeeded: evaluation.ok });

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
    return { couponId: null, discount: 0, normalizedCode: null, error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}

export async function submitOrderAction(
  cart: Cart,
  opts?: {
    tableId?: string;
    tableNumber?: string;
    note?: string;
    customerId?: string | null;
    couponCode?: string | null;
    clientCouponDiscountAmount?: number;
    idempotencyKey?: string | null;
  },
): Promise<{ orderId: string | null; orderNumber: string | null; error: string | null }> {
  try {
    // One auth/permission resolution per request — requirePermission plus a separate
    // store-context lookup used to run the full auth chain twice.
    const { user, ctx, resolved } = await getResolvedCurrentPermissions();
    if (!resolved.can("pos.use")) {
      return { orderId: null, orderNumber: null, error: "ไม่มีสิทธิ์ใช้งาน POS" };
    }
    const canDiscount = !cartRequestsDiscount(cart) || resolved.can("pos.discount");
    return await createPosOrderCore(user, ctx, canDiscount, cart, opts);
  } catch (e) {
    return { orderId: null, orderNumber: null, error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}

/**
 * Order-creation core shared by submitOrderAction and checkoutAndPayAction:
 * validates the cart against the catalog, handles reward vouchers and
 * coupon/customer checkout, creates the order, and fires the new-order
 * notification. Auth/permissions must already be resolved by the caller.
 */
async function createPosOrderCore(
  user: { id: string },
  ctx: { storeId: string; organizationId: string; storeTimezone: string },
  canDiscount: boolean,
  cart: Cart,
  opts?: {
    tableId?: string;
    tableNumber?: string;
    note?: string;
    customerId?: string | null;
    couponCode?: string | null;
    clientCouponDiscountAmount?: number;
    idempotencyKey?: string | null;
  },
): Promise<{ orderId: string | null; orderNumber: string | null; error: string | null }> {
  // Reserved voucher ids live outside the try so the catch can release them too —
  // a reserved-but-unreleased voucher is permanently lost to the customer.
  const reservedRedemptionIds: string[] = [];
  async function releaseReservedVouchers() {
    for (const redemptionId of reservedRedemptionIds) {
      await releaseProductRewardVoucher(ctx.storeId, redemptionId);
    }
  }
  try {
    if (cart.items.length === 0) return { orderId: null, orderNumber: null, error: "ไม่มีรายการในออร์เดอร์" };
    const rewardItems = cart.items.filter((item) => item.rewardVoucherCode);
    const normalCart: Cart = { ...cart, items: cart.items.filter((item) => !item.rewardVoucherCode) };
    // Re-pricing needs only the products present in the cart, not the whole catalog.
    const cartProductIds = Array.from(new Set(cart.items.map((item) => item.productId)));
    const productsRes = await listProducts(ctx.storeId, { includeInactive: false, productIds: cartProductIds });
    if (productsRes.error || !productsRes.data) {
      return { orderId: null, orderNumber: null, error: productsRes.error?.userMessage ?? "ไม่สามารถตรวจสอบสินค้าได้" };
    }
    const trustedCart = buildTrustedCartFromCatalog(normalCart, productsRes.data, {
      storeId: ctx.storeId,
      canDiscount,
    });

    // Product reward vouchers: validate the voucher + catalog server-side, then append a ฿0
    // line (stock still deducts via the order RPC). Vouchers are reserved (single-use) before
    // the order is created and released if creation fails.
    const rewardRedemptionIds: string[] = [];
    const rewardLines: Cart["items"] = [];
    if (rewardItems.length > 0) {
      await requireFeature("loyaltyPoints");
      // A free reward must accompany a real purchase — a ฿0-only order has no payment to collect.
      if (trustedCart.items.length === 0) {
        return { orderId: null, orderNumber: null, error: "ของรางวัลแบบสินค้าต้องแลกพร้อมรายการสั่งซื้ออื่น" };
      }
      for (const rewardItem of rewardItems) {
        const voucherRes = await findProductRewardVoucher(ctx.storeId, rewardItem.rewardVoucherCode ?? "");
        if (voucherRes.error) return { orderId: null, orderNumber: null, error: voucherRes.error.userMessage };
        if (!voucherRes.data) {
          return { orderId: null, orderNumber: null, error: "โค้ดของรางวัลใช้ไม่ได้หรือหมดอายุ" };
        }
        if (voucherRes.data.productId !== rewardItem.productId) {
          return { orderId: null, orderNumber: null, error: "โค้ดของรางวัลไม่ตรงกับสินค้า" };
        }
        const product = productsRes.data.find((candidate) => candidate.id === voucherRes.data!.productId);
        if (!product || !product.isActive || !product.availableForPos) {
          return { orderId: null, orderNumber: null, error: "สินค้าของรางวัลไม่พร้อมใช้งาน" };
        }
        rewardLines.push({
          key: `reward:${voucherRes.data.voucherCode}`,
          productId: product.id,
          productName: product.name,
          categoryId: product.categoryId,
          variant: null,
          modifiers: [],
          quantity: 1,
          unitPrice: 0,
          totalPrice: 0,
          note: `🎁 ของรางวัล · ${voucherRes.data.voucherCode}`,
        });
        rewardRedemptionIds.push(voucherRes.data.redemptionId);
      }
    }
    const finalCart: Cart =
      rewardLines.length > 0 ? { ...trustedCart, items: [...trustedCart.items, ...rewardLines] } : trustedCart;

    const tableRes = opts?.tableId ? await getTable(opts.tableId, ctx.storeId) : null;
    if (tableRes?.error) {
      return { orderId: null, orderNumber: null, error: tableRes.error.userMessage };
    }
    if (opts?.tableId && !tableRes?.data) {
      return { orderId: null, orderNumber: null, error: "ไม่พบโต๊ะนี้ในร้านค้า" };
    }
    const buffetSessionId = tableRes?.data?.currentSessionId;
    const customerId = opts?.customerId?.trim() || null;
    const couponCode = opts?.couponCode?.trim() || null;
    const clientCouponDiscountAmount = opts?.clientCouponDiscountAmount ?? 0;
    if (customerId) await requireFeature("loyaltyPoints");
    if (couponCode || clientCouponDiscountAmount > 0) await requireFeature("couponManagement");
    if (clientCouponDiscountAmount > 0 && !couponCode) {
      return { orderId: null, orderNumber: null, error: "ต้องระบุรหัสคูปอง" };
    }
    if ((customerId || couponCode) && !opts?.idempotencyKey?.trim()) {
      return { orderId: null, orderNumber: null, error: "ต้องมี idempotency key สำหรับ POS customer/coupon checkout" };
    }

    // Reserve vouchers (atomic single-use) as the LAST step before creating the
    // order — every validation above returns without touching them, so a failed
    // checkout can never strand a customer's voucher in the used state.
    for (const redemptionId of rewardRedemptionIds) {
      const reserved = await reserveProductRewardVoucher(ctx.storeId, redemptionId);
      if (reserved.error || !reserved.reserved) {
        await releaseReservedVouchers();
        return { orderId: null, orderNumber: null, error: "โค้ดของรางวัลถูกใช้ไปแล้ว" };
      }
      reservedRedemptionIds.push(redemptionId);
    }

    let orderCart = finalCart;
    const result = customerId || couponCode
      ? await (async () => {
          const couponRes = couponCode
            ? await findCouponPolicyByCode(ctx.storeId, couponCode, customerId)
            : { data: null, error: null };
          if (couponRes.error) return { data: null, error: couponRes.error };

          const checkout = buildGroceryCheckoutCart({
            trustedCart: finalCart,
            coupon: couponRes.data,
            couponCode,
            customerId,
            clientCouponDiscountAmount,
          });
          if (!checkout.ok) {
            const message = checkout.error.startsWith("coupon_")
              ? mapGroceryCouponError(checkout.error)
              : checkout.error;
            return { data: null, error: { userMessage: message } };
          }

          orderCart = checkout.cart;
          return createPosOrderWithCustomerRewardsIds({
            storeId: ctx.storeId,
            organizationId: ctx.organizationId,
            cashierId: user.id,
            storeTimezone: ctx.storeTimezone,
            cart: checkout.cart,
            tableId: opts?.tableId,
            tableNumber: opts?.tableNumber,
            note: opts?.note,
            customerId,
            couponId: checkout.couponId,
            couponDiscountAmount: checkout.couponDiscountAmount,
            idempotencyKey: opts?.idempotencyKey,
          });
        })()
      : await createOrderWithItemsIds({
          storeId: ctx.storeId,
          organizationId: ctx.organizationId,
          cashierId: user.id,
          storeTimezone: ctx.storeTimezone,
          cart: finalCart,
          tableId: opts?.tableId,
          tableNumber: opts?.tableNumber,
          note: opts?.note,
        });

    if (result.error) {
      await releaseReservedVouchers();
      return { orderId: null, orderNumber: null, error: result.error.userMessage };
    }

    // Order exists — link the reserved reward vouchers to it (best-effort; single-use already locked).
    for (const redemptionId of reservedRedemptionIds) {
      const attached = await attachRewardVoucherOrder(ctx.storeId, redemptionId, result.data.id);
      if (attached.error) {
        console.warn("[pos] reward voucher attach issue", {
          storeId: ctx.storeId,
          orderId: result.data.id,
          redemptionId,
          error: attached.error.userMessage,
        });
      }
    }
    if (buffetSessionId) {
      notifyOwnerSafely({
        type: "new_buffet_order",
        organizationId: ctx.organizationId,
        storeId: ctx.storeId,
        title: "มีออเดอร์บุฟเฟต์ใหม่",
        message: `ออเดอร์ ${result.data.orderNumber} ยอด ${orderCart.total.toFixed(2)}`,
        metadata: {
          orderId: result.data.id,
          orderNumber: result.data.orderNumber,
          buffetSessionId,
          total: orderCart.total,
          source: "pos",
        },
      });
    } else {
      notifyOwnerSafely({
        type: "new_pos_order",
        organizationId: ctx.organizationId,
        storeId: ctx.storeId,
        title: "มีออเดอร์ POS ใหม่",
        message: `ออเดอร์ ${result.data.orderNumber} ยอด ${orderCart.total.toFixed(2)}`,
        metadata: {
          orderId: result.data.id,
          orderNumber: result.data.orderNumber,
          total: orderCart.total,
          source: "pos",
        },
      });
    }
    return { orderId: result.data.id, orderNumber: result.data.orderNumber, error: null };
  } catch (e) {
    await releaseReservedVouchers();
    return { orderId: null, orderNumber: null, error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}

export async function collectPaymentAction(
  orderId: string,
  payment: AddPaymentInput,
  opts?: { idempotencyKey?: string | null },
): Promise<{ order: Order | null; error: string | null }> {
  try {
    const { user, ctx, resolved } = await getResolvedCurrentPermissions();
    if (!resolved.can("pos.use")) return { order: null, error: "ไม่มีสิทธิ์ใช้งาน POS" };

    if (payment.method === "cash") {
      const cashSession = await getOpenCashSession(ctx.storeId);
      if (cashSession.error) return { order: null, error: cashSession.error.userMessage };
      if (!cashSession.data) return { order: null, error: "ต้องเปิดรอบเงินสดก่อนรับเงินสด" };
    }

    if (payment.method === "qr_promptpay" && payment.qrPaymentVerified !== true) {
      return { order: null, error: "กรุณายืนยันว่าได้รับเงิน QR แล้ว" };
    }

    // Slim lookup: the close RPC re-validates store/status; this only needs tenant
    // scope plus whether the order carries a customer (rewards close path).
    const orderRes = await getOrderPaymentContext(orderId);
    if (orderRes.error) return { order: null, error: orderRes.error.userMessage };
    if (orderRes.data?.storeId !== ctx.storeId) return { order: null, error: "ร้านค้าในออร์เดอร์ไม่ถูกต้อง" };

    let paymentId: string | null = null;
    let paidAmount = payment.amount;
    let paidMethod = payment.method;
    let paidOrder: Order | null = null;
    if (orderRes.data?.customerId) {
      await requireFeature("loyaltyPoints");
      const result = await closePosOrderPaymentWithRewards({
        orderId,
        storeId: ctx.storeId,
        processedByUserId: user.id,
        payment,
        idempotencyKey: opts?.idempotencyKey ?? randomUUID(),
      });
      if (result.error) return { order: null, error: result.error.userMessage };
      paidOrder = result.data ?? null;
      const completedPayment = result.data?.payments.find((item) => item.status === "completed") ?? result.data?.payments[0];
      paymentId = completedPayment?.id ?? null;
      paidAmount = completedPayment?.amount ?? paidAmount;
      paidMethod = completedPayment?.method ?? paidMethod;
    } else {
      const result = await addPaymentAndClose(orderId, ctx.storeId, user.id, payment);
      if (result.error) return { order: null, error: result.error.userMessage };
      paymentId = result.data.id;
      paidAmount = result.data.amount;
      paidMethod = result.data.method;
      const paidOrderRes = await getOrder(orderId);
      if (!paidOrderRes.error) {
        paidOrder = paidOrderRes.data ?? null;
      }
    }

    notifyOwnerSafely({
      type: "payment",
      organizationId: ctx.organizationId,
      storeId: ctx.storeId,
      title: "ชำระเงินแล้ว",
      message: `รับชำระเงิน ${paidAmount.toFixed(2)} ผ่าน ${paidMethod}`,
      metadata: {
        orderId,
        paymentId,
        amount: paidAmount,
        method: paidMethod,
      },
    });
    if (paidOrder) {
      notifyLowStockAfterSaleSafely(
        ctx.organizationId,
        ctx.storeId,
        paidOrder.items.map((item) => ({
          variantId: item.variantId,
          baseQuantity: item.quantity * (item.unitQuantity ?? 1),
        })),
      );
    }
    return { order: paidOrder, error: null };
  } catch (e) {
    return { order: null, error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface CheckoutAndPayResult {
  orderId: string | null;
  orderNumber: string | null;
  order: Order | null;
  /** "order": nothing was persisted; "payment": order exists — retry payment only. */
  failedStage: "order" | "payment" | null;
  error: string | null;
}

/**
 * Creates the order and collects its payment in a single request — the POS
 * pay-now path. Splitting these into two actions doubled the network and
 * auth/context cost on the most latency-sensitive step of the POS.
 */
export async function checkoutAndPayAction(
  cart: Cart,
  payment: AddPaymentInput,
  opts?: {
    tableId?: string;
    tableNumber?: string;
    note?: string;
    customerId?: string | null;
    couponCode?: string | null;
    clientCouponDiscountAmount?: number;
    idempotencyKey?: string | null;
    paymentIdempotencyKey?: string | null;
  },
): Promise<CheckoutAndPayResult> {
  let createdOrderId: string | null = null;
  let createdOrderNumber: string | null = null;
  try {
    const { user, ctx, resolved } = await getResolvedCurrentPermissions();
    if (!resolved.can("pos.use")) {
      return { orderId: null, orderNumber: null, order: null, failedStage: "order", error: "ไม่มีสิทธิ์ใช้งาน POS" };
    }

    if (payment.method === "cash") {
      const cashSession = await getOpenCashSession(ctx.storeId);
      if (cashSession.error) {
        return { orderId: null, orderNumber: null, order: null, failedStage: "order", error: cashSession.error.userMessage };
      }
      if (!cashSession.data) {
        return { orderId: null, orderNumber: null, order: null, failedStage: "order", error: "ต้องเปิดรอบเงินสดก่อนรับเงินสด" };
      }
    }
    if (payment.method === "qr_promptpay" && payment.qrPaymentVerified !== true) {
      return { orderId: null, orderNumber: null, order: null, failedStage: "order", error: "กรุณายืนยันว่าได้รับเงิน QR แล้ว" };
    }

    const canDiscount = !cartRequestsDiscount(cart) || resolved.can("pos.discount");
    const created = await createPosOrderCore(user, ctx, canDiscount, cart, opts);
    if (created.error || !created.orderId || !created.orderNumber) {
      return { orderId: null, orderNumber: null, order: null, failedStage: "order", error: created.error ?? "ไม่สามารถสร้างออร์เดอร์ได้" };
    }
    createdOrderId = created.orderId;
    createdOrderNumber = created.orderNumber;

    const customerId = opts?.customerId?.trim() || null;
    let paymentId: string | null = null;
    let paidAmount = payment.amount;
    let paidMethod = payment.method;
    let paidOrder: Order | null = null;
    if (customerId) {
      const result = await closePosOrderPaymentWithRewards({
        orderId: created.orderId,
        storeId: ctx.storeId,
        processedByUserId: user.id,
        payment,
        idempotencyKey: opts?.paymentIdempotencyKey?.trim() || randomUUID(),
      });
      if (result.error) {
        return { orderId: created.orderId, orderNumber: created.orderNumber, order: null, failedStage: "payment", error: result.error.userMessage };
      }
      paidOrder = result.data ?? null;
      const completedPayment = result.data?.payments.find((item) => item.status === "completed") ?? result.data?.payments[0];
      paymentId = completedPayment?.id ?? null;
      paidAmount = completedPayment?.amount ?? paidAmount;
      paidMethod = completedPayment?.method ?? paidMethod;
    } else {
      const result = await addPaymentAndClose(created.orderId, ctx.storeId, user.id, payment);
      if (result.error) {
        return { orderId: created.orderId, orderNumber: created.orderNumber, order: null, failedStage: "payment", error: result.error.userMessage };
      }
      paymentId = result.data.id;
      paidAmount = result.data.amount;
      paidMethod = result.data.method;
      // No post-payment order refresh: non-customer orders carry no loyalty
      // movement and the receipt renders from client-side cart data.
    }

    notifyOwnerSafely({
      type: "payment",
      organizationId: ctx.organizationId,
      storeId: ctx.storeId,
      title: "ชำระเงินแล้ว",
      message: `รับชำระเงิน ${paidAmount.toFixed(2)} ผ่าน ${paidMethod}`,
      metadata: {
        orderId: created.orderId,
        paymentId,
        amount: paidAmount,
        method: paidMethod,
      },
    });
    notifyLowStockAfterSaleSafely(
      ctx.organizationId,
      ctx.storeId,
      cart.items.map((item) => ({
        variantId: item.variant?.id,
        baseQuantity: item.quantity * (item.unit?.quantity ?? 1),
      })),
    );
    return { orderId: created.orderId, orderNumber: created.orderNumber, order: paidOrder, failedStage: null, error: null };
  } catch (e) {
    return {
      orderId: createdOrderId,
      orderNumber: createdOrderNumber,
      order: null,
      failedStage: createdOrderId ? "payment" : "order",
      error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด",
    };
  }
}

export interface OpenTableStatus {
  id: string;
  number: string;
  label: string | null;
  occupied: boolean;
  /** true = โต๊ะเปิดอยู่แบบไม่จับเวลา (ไม่มี expiresAt) */
  noExpiry: boolean;
  currentSessionId: string | null;
  expiresAt: string | null;
  /** Unpaid open QR orders still attached to this table. */
  unpaidCount: number;
  unpaidTotal: number;
}

/** Tables with their open-session status + unpaid-bill info, for the POS open-table picker. */
export async function listTablesForOpenAction(): Promise<{
  tables: OpenTableStatus[];
  noExpiryDefault: boolean;
  error: string | null;
}> {
  try {
    await requirePermission("pos.use");
    const { ctx } = await getStoreContext();
    const [tablesRes, ordersRes, storeRes] = await Promise.all([
      listManagedTables(ctx.storeId),
      listActiveQrOrders(ctx.storeId),
      getStore(ctx.storeId),
    ]);
    if (tablesRes.error) return { tables: [], noExpiryDefault: false, error: tablesRes.error.userMessage };

    // Aggregate unpaid open QR orders by table.
    const unpaid = new Map<string, { count: number; total: number }>();
    for (const o of ordersRes.data ?? []) {
      if (!o.tableId) continue;
      const cur = unpaid.get(o.tableId) ?? { count: 0, total: 0 };
      cur.count += 1;
      cur.total += o.total;
      unpaid.set(o.tableId, cur);
    }

    const now = Date.now();
    const tables = (tablesRes.data ?? [])
      .filter((t) => t.isActive)
      .map((t) => {
        const u = unpaid.get(t.id) ?? { count: 0, total: 0 };
        // เปิดอยู่ = มีการเปิดโต๊ะ (session_started_at) และยังไม่หมดเวลา
        // (ไม่มี expires = ไม่จับเวลา = ยังเปิดอยู่)
        const occupied =
          !!t.sessionStartedAt &&
          (!t.sessionExpiresAt || Date.parse(t.sessionExpiresAt) > now);
        return {
          id: t.id,
          number: t.number,
          label: t.label ?? null,
          occupied,
          noExpiry: occupied && !t.sessionExpiresAt,
          currentSessionId: t.currentSessionId ?? null,
          expiresAt: t.sessionExpiresAt ?? null,
          unpaidCount: u.count,
          unpaidTotal: u.total,
        };
      });
    return { tables, noExpiryDefault: storeRes.data?.dineInNoExpiry ?? false, error: null };
  } catch (e) {
    return { tables: [], noExpiryDefault: false, error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}

/** Open an à la carte table session using the store's default duration. Returns the slug + expiry for the receipt. */
export async function openTableAction(
  tableId: string,
  opts?: { minutes?: number; noExpiry?: boolean },
): Promise<{
  error: string | null;
  expiresAt: string | null;
  storeSlug: string | null;
  qrMode: QrOrderingMode | null;
  qrUrl: string | null;
}> {
  const empty = { expiresAt: null, storeSlug: null, qrMode: null, qrUrl: null };
  try {
    await requirePermission("pos.use");
    const { ctx } = await getStoreContext();
    if (!UUID_RE.test(tableId)) return { error: "โต๊ะไม่ถูกต้อง", ...empty };

    const storeRes = await getStore(ctx.storeId);
    // noExpiry (จาก modal) มาก่อน; ถ้าไม่ได้ส่งมาให้ใช้ค่าเริ่มต้นของร้าน
    const noExpiry = opts?.noExpiry ?? storeRes.data?.dineInNoExpiry ?? false;
    const minutes: number | null = noExpiry
      ? null
      : Number.isInteger(opts?.minutes)
        ? opts!.minutes!
        : storeRes.data?.dineInDurationMinutes ?? 120;

    const res = await openTableSession(ctx.storeId, tableId, minutes);
    if (res.error) return { error: res.error.userMessage, ...empty };

    // For session_printed stores, build the temporary QR (with the active
    // session token) the cashier prints and hands to the customer.
    const store = storeRes.data;
    const qrMode = store?.qrOrderingMode ?? null;
    const tableRes = await getTable(tableId, ctx.storeId);
    const tableLabel = tableRes.data?.label ?? tableRes.data?.number ?? "-";

    notifyOwnerSafely({
      type: "new_table",
      organizationId: ctx.organizationId,
      storeId: ctx.storeId,
      title: "เปิดโต๊ะใหม่",
      message: minutes === null ? `เปิดโต๊ะ ${tableLabel} แล้ว (ไม่จับเวลา)` : `เปิดโต๊ะ ${tableLabel} แล้ว`,
      metadata: { tableId, tableLabel, minutes, expiresAt: res.data },
    });

    let qrUrl: string | null = null;
    if (store && qrMode === "session_printed") {
      const sessionId = tableRes.data?.currentSessionId ?? null;
      const h = await headers();
      const host = h.get("host") ?? "";
      const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
      const baseUrl = host ? `${proto}://${host}` : "";
      if (baseUrl) {
        qrUrl = buildTableQrUrl({ baseUrl, storeSlug: store.slug, tableId, qrMode, sessionId });
      }
    }

    revalidatePath("/pos", "page");
    return {
      error: null,
      expiresAt: res.data,
      storeSlug: store?.slug ?? null,
      qrMode,
      qrUrl,
    };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด", ...empty };
  }
}

/**
 * Returns everything the client needs to print a table-open QR slip on a thermal
 * printer through the Print Hub: the customer ordering QR (for both QR modes),
 * table label, valid-until, and the store's printers. Read-only — call after
 * openTableAction so the session (and session_printed token) already exists.
 */
export async function getTableQrSlipAction(tableId: string): Promise<{
  error: string | null;
  slip: { storeName: string; tableLabel: string; qrPayload: string; validUntil: string | null; logoUrl: string | null } | null;
  printers: Printer[];
}> {
  try {
    await requirePermission("pos.use");
    const { ctx } = await getStoreContext();
    if (!UUID_RE.test(tableId)) return { error: "โต๊ะไม่ถูกต้อง", slip: null, printers: [] };

    const [storeRes, tableRes, printersRes] = await Promise.all([
      getStore(ctx.storeId),
      getTable(tableId, ctx.storeId),
      listPrinters(ctx.storeId, ctx.organizationId),
    ]);
    const store = storeRes.data;
    const table = tableRes.data;
    if (!store || !table) return { error: "ไม่พบร้าน/โต๊ะ", slip: null, printers: [] };

    const h = await headers();
    const host = h.get("host") ?? "";
    const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
    const baseUrl = host ? `${proto}://${host}` : "";
    if (!baseUrl) return { error: "สร้าง URL ไม่สำเร็จ", slip: null, printers: [] };

    const qrPayload = buildTableQrUrl({
      baseUrl,
      storeSlug: store.slug,
      tableId,
      qrMode: store.qrOrderingMode,
      sessionId: table.currentSessionId ?? null,
    });

    return {
      error: null,
      slip: {
        storeName: store.name,
        tableLabel: table.label ?? String(table.number),
        qrPayload,
        validUntil: table.sessionExpiresAt ?? null,
        logoUrl: store.logoUrl ?? null,
      },
      printers: printersRes.data ?? [],
    };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด", slip: null, printers: [] };
  }
}

export async function closeTableAction(tableId: string): Promise<{ error: string | null }> {
  try {
    await requirePermission("pos.use");
    const { ctx } = await getStoreContext();
    if (!UUID_RE.test(tableId)) return { error: "โต๊ะไม่ถูกต้อง" };
    const res = await closeTableSession(ctx.storeId, tableId);
    if (res.error) return { error: res.error.userMessage };
    revalidatePath("/pos", "page");
    return { error: null };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}

/** Open QR orders (per table) the cashier can settle from POS. */
export async function listOpenQrOrdersAction(): Promise<{ orders: QrOrderView[]; error: string | null }> {
  try {
    await requirePermission("pos.use");
    const { ctx } = await getStoreContext();
    const res = await listActiveQrOrders(ctx.storeId);
    if (res.error) return { orders: [], error: res.error.userMessage };
    return { orders: res.data ?? [], error: null };
  } catch (e) {
    return { orders: [], error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}

/**
 * พนักงานเพิ่มรายการเข้าโต๊ะที่เปิดอยู่ → ส่งเข้าครัวทันทีเป็น "ออเดอร์เปิด" ผูกโต๊ะ
 * (ยังไม่เก็บเงิน). ใช้ไปป์ไลน์เดียวกับ QR order (create_qr_order_with_items) เพื่อให้
 * ครัวเห็นบนบอร์ด + ตัดสต็อกตอนสั่ง + โผล่ในบิลรวมของโต๊ะ + เช็คบิลรวมได้เลย.
 * โต๊ะที่เปิดอยู่ = session active → ผ่านด่านเช็คของ submitQrOrderAction เอง.
 */
export async function addItemsToTableAction(
  tableId: string,
  items: QrOrderItem[],
): Promise<{ orderId: string | null; orderNumber: string | null; error: string | null }> {
  try {
    await requirePermission("pos.use");
    const { ctx } = await getStoreContext();
    if (!UUID_RE.test(tableId)) {
      return { orderId: null, orderNumber: null, error: "โต๊ะไม่ถูกต้อง" };
    }
    const res = await submitQrOrderAction(ctx.storeId, tableId, items);
    if (!res.error) revalidatePath("/pos", "page");
    return res;
  } catch (e) {
    return { orderId: null, orderNumber: null, error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}

// --- Unified table bill: รวมออร์เดอร์ QR + ตั๋ว POS ที่พักไว้ ต่อโต๊ะ เป็นบิลเดียว ---

export interface TableBillTicket {
  id: string;
  label: string;
  total: number;
  itemCount: number;
}

export interface TableBill {
  tableId: string;
  tableNumber: string;
  qrOrders: QrOrderView[];
  tickets: TableBillTicket[];
  qrTotal: number;
  ticketTotal: number;
  grandTotal: number;
}

/** โต๊ะที่มีบิลค้าง (QR order ที่เปิดอยู่ + ตั๋ว POS ที่ผูกโต๊ะ) รวมยอดต่อโต๊ะ */
export async function listTableBillsAction(): Promise<{ bills: TableBill[]; error: string | null }> {
  try {
    await requirePermission("pos.use");
    const { ctx } = await getStoreContext();
    const [ordersRes, ticketsRes] = await Promise.all([
      listActiveQrOrders(ctx.storeId),
      listSavedTickets(ctx.storeId),
    ]);
    if (ordersRes.error) return { bills: [], error: ordersRes.error.userMessage };
    if (ticketsRes.error) return { bills: [], error: ticketsRes.error.userMessage };

    const byTable = new Map<string, TableBill>();
    const ensure = (tableId: string, tableNumber: string): TableBill => {
      let bill = byTable.get(tableId);
      if (!bill) {
        bill = { tableId, tableNumber, qrOrders: [], tickets: [], qrTotal: 0, ticketTotal: 0, grandTotal: 0 };
        byTable.set(tableId, bill);
      }
      return bill;
    };

    for (const order of ordersRes.data ?? []) {
      if (!order.tableId) continue;
      const bill = ensure(order.tableId, order.tableNumber ?? "-");
      bill.qrOrders.push(order);
      bill.qrTotal += order.total;
    }
    for (const ticket of ticketsRes.data ?? []) {
      if (!ticket.tableId) continue;
      const bill = ensure(ticket.tableId, ticket.tableNumber ?? "-");
      bill.tickets.push({
        id: ticket.id,
        label: ticket.label || ticket.ticketNumber,
        total: ticket.cart.total,
        itemCount: ticket.cart.items.length,
      });
      bill.ticketTotal += ticket.cart.total;
    }

    const bills = [...byTable.values()]
      .map((b) => ({ ...b, grandTotal: b.qrTotal + b.ticketTotal }))
      .filter((b) => b.qrOrders.length > 0 || b.tickets.length > 0)
      .sort((a, b) => a.tableNumber.localeCompare(b.tableNumber, "th"));

    return { bills, error: null };
  } catch (e) {
    return { bills: [], error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}

/**
 * ชำระรวมทั้งโต๊ะ: เก็บเงินทุก QR order ที่เปิดอยู่ + คิดเงินตั๋ว POS ที่พักไว้ทั้งหมด
 * ของโต๊ะนี้ ด้วยวิธีจ่ายเดียว แล้วปิดโต๊ะ (คืนโต๊ะว่าง). แต่ละบิลจะบันทึกยอดของตัวเอง
 * ถ้ามีบิลใดชำระไม่ผ่าน จะหยุดและไม่ปิดโต๊ะ (บิลที่จ่ายไปแล้วจะไม่กลับมาอีก).
 */
export async function settleWholeTableAction(
  tableId: string,
  method: "cash" | "qr_promptpay",
  opts?: { qrPaymentVerified?: boolean },
): Promise<{ error: string | null; settledCount: number; total: number; closed: boolean }> {
  const fail = (error: string, settledCount = 0, total = 0) => ({ error, settledCount, total, closed: false });
  try {
    await requirePermission("pos.use");
    const { ctx } = await getStoreContext();
    if (!UUID_RE.test(tableId)) return fail("โต๊ะไม่ถูกต้อง");
    if (method !== "cash" && method !== "qr_promptpay") return fail("วิธีชำระไม่ถูกต้อง");
    if (method === "qr_promptpay" && opts?.qrPaymentVerified !== true) {
      return fail("กรุณายืนยันว่าได้รับเงิน QR แล้ว");
    }
    if (method === "cash") {
      const cashSession = await getOpenCashSession(ctx.storeId);
      if (cashSession.error) return fail(cashSession.error.userMessage);
      if (!cashSession.data) return fail("ต้องเปิดรอบเงินสดก่อนรับเงินสด");
    }

    const [ordersRes, ticketsRes] = await Promise.all([
      listActiveQrOrders(ctx.storeId),
      listSavedTickets(ctx.storeId),
    ]);
    if (ordersRes.error) return fail(ordersRes.error.userMessage);
    if (ticketsRes.error) return fail(ticketsRes.error.userMessage);

    const qrOrders = (ordersRes.data ?? []).filter((o) => o.tableId === tableId);
    const tickets = (ticketsRes.data ?? []).filter((t) => t.tableId === tableId);
    if (qrOrders.length === 0 && tickets.length === 0) {
      return fail("โต๊ะนี้ไม่มีบิลค้างชำระ");
    }

    let settledCount = 0;
    let total = 0;

    // 1) เก็บเงิน QR order ที่เปิดอยู่ทีละใบ
    for (const order of qrOrders) {
      const res = await collectPaymentAction(order.id, {
        method,
        amount: order.total,
        receivedAmount: method === "cash" ? order.total : undefined,
        changeAmount: method === "cash" ? 0 : undefined,
        qrPaymentVerified: method === "qr_promptpay" ? true : undefined,
      });
      if (res.error) {
        return { error: `บิล #${order.orderNumber}: ${res.error}`, settledCount, total, closed: false };
      }
      settledCount += 1;
      total += order.total;
    }

    // 2) คิดเงินตั๋ว POS ที่พักไว้ทีละใบ แล้วลบตั๋ว
    for (const ticket of tickets) {
      const res = await checkoutAndPayAction(
        ticket.cart,
        {
          method,
          amount: ticket.cart.total,
          receivedAmount: method === "cash" ? ticket.cart.total : undefined,
          changeAmount: method === "cash" ? 0 : undefined,
          qrPaymentVerified: method === "qr_promptpay" ? true : undefined,
        },
        { tableId, tableNumber: ticket.tableNumber, customerId: null },
      );
      if (res.error) {
        return { error: `ตั๋ว ${ticket.label || ticket.ticketNumber}: ${res.error}`, settledCount, total, closed: false };
      }
      await deleteSavedTicket(ticket.id, ctx.storeId);
      settledCount += 1;
      total += ticket.cart.total;
    }

    // 3) ปิดโต๊ะ (คืนโต๊ะว่าง)
    const close = await closeTableSession(ctx.storeId, tableId);
    revalidatePath("/pos", "page");
    return { error: null, settledCount, total, closed: !close.error };
  } catch (e) {
    return fail(e instanceof Error ? e.message : "เกิดข้อผิดพลาด");
  }
}

export async function voidOrderAction(
  orderId: string,
  reason: string,
): Promise<{ error: string | null }> {
  try {
    await requirePermission("pos.delete_bill");
    const { user, ctx } = await getStoreContext();

    const result = await voidOrder(orderId, ctx.storeId, user.id, reason);
    if (result.error) return { error: result.error.userMessage };
    notifyOwnerSafely({
      type: "order_cancelled",
      organizationId: ctx.organizationId,
      storeId: ctx.storeId,
      title: "มีการยกเลิกออเดอร์",
      message: `ออเดอร์ ${orderId} ถูกยกเลิก: ${reason || "ไม่ระบุเหตุผล"}`,
      metadata: {
        orderId,
        reason: reason || null,
      },
    });
    return { error: null };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}
