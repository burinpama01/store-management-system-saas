"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { getCurrentUser, getUserStores, resolveCurrentStore } from "@/modules/auth/session";
import { getResolvedCurrentPermissions, requireFeature, requirePermission } from "@/modules/auth/guards";
import { resolveUnknownPrintJob } from "@/modules/printing/print-hub-repository";
import { logSystemEvent } from "@/modules/system/event-log";
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
  changeOrderPaymentMethod,
  voidOrder,
} from "@/modules/pos/order-repository";
import {
  listSavedTickets,
  listTableSavedTickets,
  ensureTableAutoTicket,
  saveSavedTicket,
  deleteSavedTicket,
  deleteSavedTicketAndCloseTable,
  getSavedTicket,
} from "@/modules/pos/saved-ticket-repository";
import { generateOrderNumber } from "@/modules/pos/order-number";
import { createSupabaseServerClient } from "@/server/integrations/supabase/server";
import { buildTrustedCartFromCatalog } from "@/modules/pos/server-cart";
import { cartRequestsDiscount } from "@/modules/pos/discount-policy";
import { buildTableTicket, isEmptyTicket } from "@/modules/pos/table-ticket";
import { describeTableUnpaid, findTableUnpaidContext } from "@/modules/pos/table-unpaid";
import { openTableSession, closeTableSession, getStore, getTable, listManagedTables, listPrinters } from "@/modules/stores/repository";
import { listActiveQrOrders, voidQrOrderItem } from "@/modules/qr-ordering/repository";
import { submitQrOrderAction, type QrOrderItem } from "@/app/qr/[storeSlug]/[tableId]/actions";
import { buildTableQrUrl } from "@/modules/qr-ordering/printed-qr";
import { getUnifiedPosStoreFlag, settleOrdersGoverned } from "@/modules/unified-pos/settlement";
import { notifyOwnerSafely } from "@/modules/notifications/dispatcher";
import { notifyLowStockAfterSaleSafely } from "@/modules/stock/notify";
import { getOpenCashSession } from "@/modules/cashflow/repository";
import type { Cart, Order, PaymentMethod, SavedOrderTicket } from "@/modules/pos/types";
import type { AddPaymentInput } from "@/modules/pos/order-repository";
import {
  confirmTrueMoneyManualPayment,
  createTrueMoneyManualPending,
  prepareTrueMoneyManualQr,
} from "@/modules/payments/service";
import { getEnabledTrueMoneyManualConfig } from "@/modules/payments/repository";
import {
  cancelBeamQrPayment,
  claimBeamPaymentForOrder,
  createBeamQrPayment,
  finalizeBeamPaymentForOrder,
  isBeamReadyForStore,
  refreshBeamPayment,
  releaseBeamPaymentClaim,
} from "@/modules/payments/beam-service";
import type { BeamQrForPos, GatewayPaymentStatus } from "@/modules/payments/types";
import { canUseFeature, DEFAULT_BILLING_STATE } from "@/modules/billing/types";
import { getOrganizationBillingState } from "@/modules/billing/billing-service";
import type { QrOrderView } from "@/modules/qr-ordering/types";
import type { Printer, QrOrderingMode } from "@/modules/stores/types";
import { buildLoyaltyClaimUrl, ensureLoyaltyClaimCode } from "@/modules/loyalty/claim-repository";
import { generateMemberPortalLink } from "@/modules/customers/member-repository";

/** log แบบ best-effort — ระบบ log ล่มต้องไม่เปลี่ยนผลของงานหลัก (เปิดโต๊ะ/เช็คบิล) */
function safeLog(input: Parameters<typeof logSystemEvent>[0]): Promise<void> {
  try {
    return logSystemEvent(input).catch(() => undefined);
  } catch {
    return Promise.resolve();
  }
}

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
    if (opts?.closeRelatedTableSession) {
      // ลบตั๋วแล้วเคลียร์โต๊ะได้เฉพาะเมื่อโต๊ะไม่มีบิลอื่นค้าง (ออเดอร์ QR / ตั๋วอื่น)
      const ticket = await getSavedTicket(ticketId, ctx.storeId);
      if (ticket.error) return { error: ticket.error.userMessage };
      if (ticket.data?.tableId) {
        const unpaid = await findTableUnpaidContext(await createSupabaseServerClient(), ctx.storeId, ticket.data.tableId, {
          excludeTicketId: ticketId,
        });
        if (!unpaid.ok) return { error: unpaid.error };
        if (unpaid.hasUnpaid) {
          return { error: `โต๊ะยังมีบิลค้าง (${describeTableUnpaid(unpaid)}) — ลบตั๋วอย่างเดียว หรือเช็คบิลก่อน` };
        }
      }
    }
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

    // Recheck committed sale movements at the order-creation boundary. Open POS
    // orders currently create their Pool movement at payment close, so this is a
    // no-op until then; pay-now may register both callbacks, with the movement
    // claim providing the exactly-once delivery boundary.
    notifyLowStockAfterSaleSafely(
      ctx.organizationId,
      ctx.storeId,
      result.data.id,
    );

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
  opts?: {
    idempotencyKey?: string | null;
    trueMoney?: { confirmReason?: string | null } | null;
    /** Beam QR already confirmed paid by Beam — the server re-checks before closing. */
    beam?: { gatewayPaymentId: string } | null;
  },
): Promise<{ order: Order | null; error: string | null } & {
  /** บิลรวมโต๊ะ: ผลการปิดโต๊ะหลังจ่าย (ทำฝั่ง server ใน request เดียวกัน ไม่พึ่งหน่วยความจำของเครื่อง) */
  tableBill?: TableBillFinish | null;
}> {
  let beamClaim: { storeId: string; gatewayPaymentId: string; orderId: string } | null = null;
  let beamClosed = false;
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

    let trueMoneyGatewayId: string | null = null;
    let workingPayment: AddPaymentInput = payment;
    if (opts?.trueMoney) {
      await requireFeature("byoPaymentGateway");
      // Slip checkbox is the cashier gate; confirm_reason defaults server-side for audit.
    }

    // Slim lookup: the close RPC re-validates store/status; this only needs tenant
    // scope plus whether the order carries a customer (rewards close path).
    const orderRes = await getOrderPaymentContext(orderId);
    if (orderRes.error) return { order: null, error: orderRes.error.userMessage };
    if (orderRes.data?.storeId !== ctx.storeId) return { order: null, error: "ร้านค้าในออร์เดอร์ไม่ถูกต้อง" };

    if (opts?.trueMoney) {
      const orderFull = await getOrder(orderId);
      if (orderFull.error || !orderFull.data) {
        return { order: null, error: orderFull.error?.userMessage ?? "ไม่พบออร์เดอร์" };
      }
      const amount = orderFull.data.total;
      const pending = await createTrueMoneyManualPending({
        organizationId: ctx.organizationId,
        storeId: ctx.storeId,
        orderId,
        amountMajor: amount,
        actorUserId: user.id,
        idempotencyKey: opts.idempotencyKey ?? null,
      });
      if (!pending.ok) return { order: null, error: pending.error };
      trueMoneyGatewayId = pending.payment.id;
      workingPayment = {
        method: "other",
        amount,
        reference: `TM:${pending.payment.id}`,
      };
    }

    if (opts?.beam) {
      await requireFeature("byoPaymentGateway");
      const orderFull = await getOrder(orderId);
      if (orderFull.error || !orderFull.data) {
        return { order: null, error: orderFull.error?.userMessage ?? "ไม่พบออร์เดอร์" };
      }
      const claimed = await claimBeamPaymentForOrder({
        storeId: ctx.storeId,
        gatewayPaymentId: opts.beam.gatewayPaymentId,
        orderId,
        expectedAmount: orderFull.data.total,
      });
      if (!claimed.ok) return { order: null, error: claimed.error };
      beamClaim = { storeId: ctx.storeId, gatewayPaymentId: opts.beam.gatewayPaymentId, orderId };
      workingPayment = {
        method: "other",
        amount: claimed.amount,
        reference: `BEAM:${opts.beam.gatewayPaymentId}`,
      };
    }

    // U7: flags-gated — ร้านเปิด unified_pos_enabled → เส้นทาง governed ด้านล่าง
    const unifiedFlag = await getUnifiedPosStoreFlag(ctx.storeId);

    let paymentId: string | null = null;
    let paidAmount = workingPayment.amount;
    let paidMethod = workingPayment.method;
    let paidOrder: Order | null = null;
    if (unifiedFlag.enabled && unifiedFlag.organizationId) {
      // U7: ร้านที่เปิด flag → ชำระผ่าน governed RPC (idempotent + rewards exactly-once +
      // ยอดฝั่ง server); retry ของ request เดิม reuse idempotencyKey → replay
      // เดิมบล็อกการปิดบิลทั้งใบเมื่อออร์เดอร์ผูกลูกค้าและแพ็กเกจไม่มี loyalty
      // → ร้านเก็บเงินไม่ได้เลย ซึ่งร้ายแรงกว่าการให้แต้มเกินสิทธิ์แพ็กเกจมาก
      // การจำกัดแพ็กเกจยังอยู่ที่การ "จัดการ" loyalty (ตั้งค่า/ปรับแต้ม/ของรางวัล) เหมือนเดิม
      const settled = await settleOrdersGoverned({
        organizationId: unifiedFlag.organizationId,
        storeId: ctx.storeId,
        mode: "partial",
        orderIds: [orderId],
        method: workingPayment.method,
        amount: workingPayment.amount,
        receivedAmount: workingPayment.receivedAmount ?? null,
        changeAmount: workingPayment.changeAmount ?? null,
        reference: workingPayment.reference ?? null,
        actorUserId: user.id,
        idempotencyKey: opts?.idempotencyKey ?? null,
      });
      if (!settled.ok) return { order: null, error: settled.error.userMessage };
      const completedPayment = settled.result.payments[0];
      paymentId = completedPayment?.payment_id ?? null;
      paidAmount = completedPayment?.amount ?? paidAmount;
      paidMethod = workingPayment.method;
      const paidOrderRes = await getOrder(orderId);
      if (!paidOrderRes.error) {
        paidOrder = paidOrderRes.data ?? null;
      }
    } else if (orderRes.data?.customerId) {
      await requireFeature("loyaltyPoints");
      const result = await closePosOrderPaymentWithRewards({
        orderId,
        storeId: ctx.storeId,
        processedByUserId: user.id,
        payment: workingPayment,
        idempotencyKey: opts?.idempotencyKey ?? randomUUID(),
      });
      if (result.error) return { order: null, error: result.error.userMessage };
      paidOrder = result.data ?? null;
      const completedPayment = result.data?.payments.find((item) => item.status === "completed") ?? result.data?.payments[0];
      paymentId = completedPayment?.id ?? null;
      paidAmount = completedPayment?.amount ?? paidAmount;
      paidMethod = completedPayment?.method ?? paidMethod;
    } else {
      const result = await addPaymentAndClose(orderId, ctx.storeId, user.id, workingPayment);
      if (result.error) return { order: null, error: result.error.userMessage };
      paymentId = result.data.id;
      paidAmount = result.data.amount;
      paidMethod = result.data.method;
      const paidOrderRes = await getOrder(orderId);
      if (!paidOrderRes.error) {
        paidOrder = paidOrderRes.data ?? null;
      }
    }

    if (trueMoneyGatewayId && opts?.trueMoney) {
      const confirmed = await confirmTrueMoneyManualPayment({
        gatewayPaymentId: trueMoneyGatewayId,
        storeId: ctx.storeId,
        orderId,
        expectedAmount: paidAmount,
        confirmedBy: user.id,
        confirmReason: opts.trueMoney.confirmReason,
        posPaymentId: paymentId,
      });
      if (!confirmed.ok) {
        return { order: paidOrder, error: confirmed.error };
      }
    }

    if (beamClaim) {
      beamClosed = true;
      await finalizeBeamPaymentForOrder({
        organizationId: ctx.organizationId,
        storeId: ctx.storeId,
        gatewayPaymentId: beamClaim.gatewayPaymentId,
        orderId,
        posPaymentId: paymentId,
        actorUserId: user.id,
      });
    }

    notifyOwnerSafely({
      type: "payment",
      organizationId: ctx.organizationId,
      storeId: ctx.storeId,
      title: "ชำระเงินแล้ว",
      message: `รับชำระเงิน ${paidAmount.toFixed(2)} ผ่าน ${trueMoneyGatewayId ? "TrueMoney" : beamClaim ? "Beam" : paidMethod}`,
      metadata: {
        orderId,
        paymentId,
        amount: paidAmount,
        method: trueMoneyGatewayId ? "TrueMoney" : beamClaim ? "Beam" : paidMethod,
        trueMoneyGatewayId,
        beamGatewayId: beamClaim?.gatewayPaymentId ?? null,
      },
    });
    notifyLowStockAfterSaleSafely(
      ctx.organizationId,
      ctx.storeId,
      orderId,
    );
    // บิลรวมโต๊ะ: เงินเข้าแล้ว → ปิดโต๊ะทันทีฝั่ง server (idempotent — refresh/เน็ตหลุดไม่ค้าง)
    // ความล้มเหลวตรงนี้ไม่ย้อนการชำระ แค่แจ้งให้ปิดโต๊ะเอง
    let tableBill: TableBillFinish | null = null;
    if (paidOrder?.tableId) {
      tableBill = await finishTableBillIfConsolidated(
        { storeId: ctx.storeId, organizationId: ctx.organizationId, userId: user.id },
        orderId,
      ).catch(() => ({ closed: false, notice: null, error: "ปิดโต๊ะหลังชำระไม่สำเร็จ" }));
    }
    return { order: paidOrder, error: null, tableBill };
  } catch (e) {
    return { order: null, error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  } finally {
    // Closing failed after the Beam payment was reserved → free it for the retry.
    if (beamClaim && !beamClosed) await releaseBeamPaymentClaim(beamClaim);
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
    trueMoney?: { confirmReason?: string | null } | null;
    beam?: { gatewayPaymentId: string } | null;
  },
): Promise<CheckoutAndPayResult> {
  let createdOrderId: string | null = null;
  let createdOrderNumber: string | null = null;
  let beamClaim: { storeId: string; gatewayPaymentId: string; orderId: string } | null = null;
  let beamClosed = false;
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

    let trueMoneyGatewayId: string | null = null;
    let workingPayment: AddPaymentInput = payment;
    if (opts?.trueMoney) {
      await requireFeature("byoPaymentGateway");
      // Slip checkbox is the cashier gate; confirm_reason defaults server-side for audit.
    }
    if (opts?.beam) {
      await requireFeature("byoPaymentGateway");
      // Don't create an order for a QR Beam hasn't confirmed yet.
      const beamState = await refreshBeamPayment({
        storeId: ctx.storeId,
        gatewayPaymentId: opts.beam.gatewayPaymentId,
      });
      if (!beamState.ok) {
        return { orderId: null, orderNumber: null, order: null, failedStage: "order", error: beamState.error };
      }
      if (beamState.status !== "PAID") {
        return {
          orderId: null,
          orderNumber: null,
          order: null,
          failedStage: "order",
          error: "Beam ยังไม่ยืนยันว่าได้รับเงิน — รอลูกค้าสแกนจ่ายก่อน",
        };
      }
    }

    const canDiscount = !cartRequestsDiscount(cart) || resolved.can("pos.discount");
    const created = await createPosOrderCore(user, ctx, canDiscount, cart, opts);
    if (created.error || !created.orderId || !created.orderNumber) {
      return { orderId: null, orderNumber: null, order: null, failedStage: "order", error: created.error ?? "ไม่สามารถสร้างออร์เดอร์ได้" };
    }
    createdOrderId = created.orderId;
    createdOrderNumber = created.orderNumber;

    if (opts?.trueMoney) {
      const orderFull = await getOrder(created.orderId);
      if (orderFull.error || !orderFull.data) {
        return {
          orderId: created.orderId,
          orderNumber: created.orderNumber,
          order: null,
          failedStage: "payment",
          error: orderFull.error?.userMessage ?? "ไม่พบออร์เดอร์",
        };
      }
      const amount = orderFull.data.total;
      const pending = await createTrueMoneyManualPending({
        organizationId: ctx.organizationId,
        storeId: ctx.storeId,
        orderId: created.orderId,
        amountMajor: amount,
        actorUserId: user.id,
        idempotencyKey: opts.paymentIdempotencyKey ?? null,
      });
      if (!pending.ok) {
        return {
          orderId: created.orderId,
          orderNumber: created.orderNumber,
          order: null,
          failedStage: "payment",
          error: pending.error,
        };
      }
      trueMoneyGatewayId = pending.payment.id;
      workingPayment = {
        method: "other",
        amount,
        reference: `TM:${pending.payment.id}`,
      };
    }

    if (opts?.beam) {
      const orderFull = await getOrder(created.orderId);
      if (orderFull.error || !orderFull.data) {
        return {
          orderId: created.orderId,
          orderNumber: created.orderNumber,
          order: null,
          failedStage: "payment",
          error: orderFull.error?.userMessage ?? "ไม่พบออร์เดอร์",
        };
      }
      const claimed = await claimBeamPaymentForOrder({
        storeId: ctx.storeId,
        gatewayPaymentId: opts.beam.gatewayPaymentId,
        orderId: created.orderId,
        expectedAmount: orderFull.data.total,
      });
      if (!claimed.ok) {
        return {
          orderId: created.orderId,
          orderNumber: created.orderNumber,
          order: null,
          failedStage: "payment",
          error: claimed.error,
        };
      }
      beamClaim = {
        storeId: ctx.storeId,
        gatewayPaymentId: opts.beam.gatewayPaymentId,
        orderId: created.orderId,
      };
      workingPayment = {
        method: "other",
        amount: claimed.amount,
        reference: `BEAM:${opts.beam.gatewayPaymentId}`,
      };
    }

    const customerId = opts?.customerId?.trim() || null;
    let paymentId: string | null = null;
    let paidAmount = workingPayment.amount;
    let paidMethod = workingPayment.method;
    let paidOrder: Order | null = null;
    const unifiedFlag = await getUnifiedPosStoreFlag(ctx.storeId);
    if (unifiedFlag.enabled && unifiedFlag.organizationId) {
      // U7: ขั้นชำระผ่าน governed RPC — ออเดอร์ถูกสร้างแล้ว (legacy create RPC) จึงชำระ
      // แบบ partial ให้ RPC ตรวจ revision/ยอดรวม server + rewards exactly-once เอง
      if (customerId) {
        await requireFeature("loyaltyPoints");
      }
      const settled = await settleOrdersGoverned({
        organizationId: unifiedFlag.organizationId,
        storeId: ctx.storeId,
        mode: "partial",
        orderIds: [created.orderId],
        method: workingPayment.method,
        amount: workingPayment.amount,
        receivedAmount: workingPayment.receivedAmount ?? null,
        changeAmount: workingPayment.changeAmount ?? null,
        reference: workingPayment.reference ?? null,
        actorUserId: user.id,
        idempotencyKey: opts?.paymentIdempotencyKey?.trim() || null,
      });
      if (!settled.ok) {
        return { orderId: created.orderId, orderNumber: created.orderNumber, order: null, failedStage: "payment", error: settled.error.userMessage };
      }
      const completedPayment = settled.result.payments[0];
      paymentId = completedPayment?.payment_id ?? null;
      paidAmount = completedPayment?.amount ?? paidAmount;
      paidMethod = payment.method;
      if (customerId) {
        // เฉพาะออเดอร์ลูกค้าต้อง refresh (แต้ม) — walk-in พิมพ์จากข้อมูล cart ฝั่ง client เหมือนเดิม
        const paidOrderRes = await getOrder(created.orderId);
        if (!paidOrderRes.error) {
          paidOrder = paidOrderRes.data ?? null;
        }
      }
    } else if (customerId) {
      const result = await closePosOrderPaymentWithRewards({
        orderId: created.orderId,
        storeId: ctx.storeId,
        processedByUserId: user.id,
        payment: workingPayment,
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
      const result = await addPaymentAndClose(created.orderId, ctx.storeId, user.id, workingPayment);
      if (result.error) {
        return { orderId: created.orderId, orderNumber: created.orderNumber, order: null, failedStage: "payment", error: result.error.userMessage };
      }
      paymentId = result.data.id;
      paidAmount = result.data.amount;
      paidMethod = result.data.method;
      // No post-payment order refresh: non-customer orders carry no loyalty
      // movement and the receipt renders from client-side cart data.
    }

    if (trueMoneyGatewayId && opts?.trueMoney) {
      const confirmed = await confirmTrueMoneyManualPayment({
        gatewayPaymentId: trueMoneyGatewayId,
        storeId: ctx.storeId,
        orderId: created.orderId,
        expectedAmount: paidAmount,
        confirmedBy: user.id,
        confirmReason: opts.trueMoney.confirmReason,
        posPaymentId: paymentId,
      });
      if (!confirmed.ok) {
        return {
          orderId: created.orderId,
          orderNumber: created.orderNumber,
          order: paidOrder,
          failedStage: "payment",
          error: confirmed.error,
        };
      }
    }

    if (beamClaim) {
      beamClosed = true;
      await finalizeBeamPaymentForOrder({
        organizationId: ctx.organizationId,
        storeId: ctx.storeId,
        gatewayPaymentId: beamClaim.gatewayPaymentId,
        orderId: created.orderId,
        posPaymentId: paymentId,
        actorUserId: user.id,
      });
    }

    const methodLabel = trueMoneyGatewayId ? "TrueMoney" : beamClaim ? "Beam" : paidMethod;
    notifyOwnerSafely({
      type: "payment",
      organizationId: ctx.organizationId,
      storeId: ctx.storeId,
      title: "ชำระเงินแล้ว",
      message: `รับชำระเงิน ${paidAmount.toFixed(2)} ผ่าน ${methodLabel}`,
      metadata: {
        orderId: created.orderId,
        paymentId,
        amount: paidAmount,
        method: methodLabel,
        trueMoneyGatewayId,
        beamGatewayId: beamClaim?.gatewayPaymentId ?? null,
      },
    });
    notifyLowStockAfterSaleSafely(
      ctx.organizationId,
      ctx.storeId,
      created.orderId,
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
  } finally {
    if (beamClaim && !beamClosed) await releaseBeamPaymentClaim(beamClaim);
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

/**
 * เปิดตั๋วของโต๊ะรอไว้หลังเปิดโต๊ะ (ถ้าโต๊ะมีตั๋วอยู่แล้วใช้ใบเดิม) — ความล้มเหลวไม่ทำให้
 * การเปิดโต๊ะล้ม: โต๊ะเปิดแล้ว ออเดอร์ QR ยังเช็คบิลผ่าน "เช็คบิลโต๊ะ" ได้เหมือนเดิม
 */
async function ensureTableTicket(
  ctx: { organizationId: string; storeId: string; userId: string },
  tableId: string,
  tableLabel: string,
  timeZone: string,
): Promise<SavedOrderTicket | null> {
  const logBase = { source: "pos.table", action: "openTableTicket", organizationId: ctx.organizationId, storeId: ctx.storeId, actorUserId: ctx.userId };
  try {
    // atomic ใน DB (unique 1 ตั๋วอัตโนมัติต่อโต๊ะ) — เปิดโต๊ะพร้อมกันหลายเครื่องได้ใบเดียว
    const draft = buildTableTicket({ id: randomUUID(), storeId: ctx.storeId, tableId, tableLabel, now: new Date(), timeZone });
    const saved = await ensureTableAutoTicket({ organizationId: ctx.organizationId, storeId: ctx.storeId, ticket: draft });
    if (saved.error || !saved.data) throw new Error(saved.error?.userMessage ?? "บันทึกตั๋วไม่สำเร็จ");
    const reused = saved.data.id !== draft.id;
    await safeLog({
      ...logBase,
      level: "info",
      message: reused ? `โต๊ะ ${tableLabel} มีตั๋วอยู่แล้ว ใช้ใบเดิม` : `เปิดตั๋ว ${saved.data.ticketNumber} รอไว้สำหรับโต๊ะ ${tableLabel}`,
      context: { tableId, ticketId: saved.data.id, reused },
    });
    return saved.data;
  } catch (e) {
    await safeLog({ ...logBase, level: "warn", message: `เปิดโต๊ะแล้วแต่เปิดตั๋วไม่สำเร็จ: ${e instanceof Error ? e.message : String(e)}`, context: { tableId } });
    return null;
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
  /** ตั๋วของโต๊ะที่เปิดรอไว้ (ร้านเปิด table_open_auto_ticket) — null = ไม่ได้สร้าง */
  ticket: SavedOrderTicket | null;
}> {
  const empty = { expiresAt: null, storeSlug: null, qrMode: null, qrUrl: null, ticket: null };
  try {
    await requirePermission("pos.use");
    const { ctx } = await getStoreContext();
    if (!UUID_RE.test(tableId)) return { error: "โต๊ะไม่ถูกต้อง", ...empty };

    // รอบโต๊ะใหม่ต้องไม่ติดบิลของลูกค้ารอบก่อน (1 โต๊ะ = 1 บิล) — อ่านไม่ได้ = ไม่เปิด
    const unpaid = await findTableUnpaidContext(await createSupabaseServerClient(), ctx.storeId, tableId);
    if (!unpaid.ok) return { error: unpaid.error, ...empty };
    if (unpaid.hasUnpaid) {
      return {
        error: `โต๊ะนี้ยังมีบิลค้างจากรอบก่อน (${describeTableUnpaid(unpaid)}) — เช็คบิลก่อนเปิดโต๊ะใหม่`,
        ...empty,
      };
    }

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

    const ticket = store?.tableOpenAutoTicket
      ? await ensureTableTicket(ctx, tableId, tableLabel, store.timezone)
      : null;

    revalidatePath("/pos", "page");
    return {
      error: null,
      expiresAt: res.data,
      storeSlug: store?.slug ?? null,
      qrMode,
      qrUrl,
      ticket,
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

/** ลบตั๋วว่างของโต๊ะ (ตั๋วที่เปิดรอไว้แต่ไม่มีรายการ) ตอนปิดโต๊ะ — ตั๋วที่มีรายการไม่แตะ */
async function deleteEmptyTableTickets(
  ctx: { storeId: string; organizationId: string; userId?: string },
  tableId: string,
  reason: string,
  tickets?: SavedOrderTicket[],
) {
  const list = tickets ?? (await listTableSavedTickets(ctx.storeId, tableId)).data ?? [];
  for (const ticket of list) {
    if (ticket.tableId !== tableId || !isEmptyTicket(ticket)) continue;
    const res = await deleteSavedTicket(ticket.id, ctx.storeId);
    await safeLog({
      level: res.error ? "warn" : "info",
      source: "pos.table",
      action: "deleteEmptyTableTicket",
      message: res.error ? `ลบตั๋วว่างของโต๊ะไม่สำเร็จ: ${res.error.userMessage}` : "ลบตั๋วว่างของโต๊ะ",
      organizationId: ctx.organizationId,
      storeId: ctx.storeId,
      actorUserId: ctx.userId,
      context: { tableId, ticketId: ticket.id, reason, ok: !res.error },
    });
  }
}

export async function closeTableAction(tableId: string): Promise<{ error: string | null }> {
  try {
    await requirePermission("pos.use");
    const { ctx } = await getStoreContext();
    if (!UUID_RE.test(tableId)) return { error: "โต๊ะไม่ถูกต้อง" };
    // ปิดโต๊ะทั้งที่มีบิลค้าง = รายการของลูกค้ารอบนี้จะปนกับรอบหน้า → ต้องเช็คบิลก่อน
    const unpaid = await findTableUnpaidContext(await createSupabaseServerClient(), ctx.storeId, tableId);
    if (!unpaid.ok) return { error: unpaid.error };
    if (unpaid.hasUnpaid) {
      return { error: `ยังมีบิลค้าง (${describeTableUnpaid(unpaid)}) — ชำระเงินทั้งโต๊ะก่อนปิดโต๊ะ` };
    }
    const res = await closeTableSession(ctx.storeId, tableId);
    if (res.error) return { error: res.error.userMessage };
    await deleteEmptyTableTickets(ctx, tableId, "closeTable");
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
 * (ยังไม่เก็บเงิน). ใช้ไปป์ไลน์เดียวกับ QR order เพื่อให้ครัวเห็นบนบอร์ด + โผล่ใน
 * บิลรวมของโต๊ะ + เช็คบิลรวมได้เลย.
 *
 * U4 (v0.35.4):
 *   - operationKey: key ของ request (reuse เมื่อ retry ของ request เดียวกัน)
 *   - ร้านที่เปิด flag unified_pos_enabled → add_items_to_table_v2 (atomic + idempotent,
 *     qr_order_source=false — สต๊อกถูกตัดตอนชำระตาม convention 20260607000006)
 *   - ร้านที่ยังไม่เปิด flag → เส้นทางเดิม (submitQrOrderAction เหมือนเดิมทุกอย่าง)
 *   - actor = session user เสมอ; สิทธิ์ pos.use ถูก enforce ที่ชั้น action (requirePermission)
 *     และชั้น RPC (user_has_permission_in_store)
 */
export async function addItemsToTableAction(
  tableId: string,
  items: QrOrderItem[],
  operationKey?: string,
): Promise<{ orderId: string | null; orderNumber: string | null; error: string | null }> {
  try {
    await requirePermission("pos.use");
    const { ctx } = await getStoreContext();
    if (!UUID_RE.test(tableId)) {
      return { orderId: null, orderNumber: null, error: "โต๊ะไม่ถูกต้อง" };
    }
    const res = await submitQrOrderAction(ctx.storeId, tableId, items, operationKey, {
      actorUserId: ctx.userId,
    });
    if (!res.error) revalidatePath("/pos", "page");
    return res;
  } catch (e) {
    return { orderId: null, orderNumber: null, error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}

// --- บิลรวมโต๊ะ: 1 โต๊ะ = 1 บิล = 1 การจ่าย (consolidate_table_bill) ---

function orderToBillCart(order: Order): Cart {
  return {
    storeId: order.storeId,
    items: order.items.map((item) => ({
      key: item.id,
      productId: item.productId,
      productName: item.productName,
      categoryId: "",
      variant: item.variantId ? { id: item.variantId, name: item.variantName ?? "", priceAdjustment: 0 } : null,
      unit: item.unitId ? { id: item.unitId, name: item.unitName ?? "", quantity: item.unitQuantity ?? 1 } : null,
      modifiers: item.modifiers,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      totalPrice: item.totalPrice,
      note: item.note,
    })),
    subtotal: order.subtotal,
    discount: order.discount,
    total: order.total,
  };
}

/**
 * กดชำระที่ตั๋วโต๊ะ: รวมทุกออเดอร์ QR ที่เปิดอยู่ของโต๊ะ + รายการในตั๋ว เป็นออเดอร์เดียว
 * แล้วคืนออเดอร์นั้นให้หน้าจ่ายเงินปกติของ POS เก็บเงินครั้งเดียว (collectPaymentAction —
 * นโยบาย Beam/เงินสดเดียวกับ POS)
 * - ห้ามรวมถ้ามีออเดอร์ที่ครัวยังไม่รับ (DB ตรวจซ้ำ)
 * - รายการในตั๋วสร้างเป็นออเดอร์ POS (ราคาจาก catalog ฝั่ง server) แล้วถูกรวม + ตัดสต๊อกใน RPC
 * - operationKey เดิม = replay (กดซ้ำ/เน็ตหลุดไม่เกิดบิลซ้ำ)
 */
export async function consolidateTableBillAction(input: {
  tableId: string;
  /** ตั๋วของโต๊ะ — server อ่านรายการจาก DB เอง (ไม่เชื่อตะกร้าในเครื่อง) และ RPC ใช้ตั๋วใน transaction เดียว */
  ticketId?: string | null;
  operationKey: string;
}): Promise<{ order: { orderId: string; orderNumber: string } | null; cart: Cart | null; error: string | null }> {
  const fail = (error: string) => ({ order: null, cart: null, error });
  try {
    const { user, ctx, resolved } = await getResolvedCurrentPermissions();
    if (!resolved.can("pos.use")) return fail("ไม่มีสิทธิ์ใช้งาน POS");
    if (!UUID_RE.test(input.tableId)) return fail("โต๊ะไม่ถูกต้อง");
    if (!/^[A-Za-z0-9-]{8,80}$/.test(input.operationKey)) return fail("คำขอไม่ถูกต้อง");
    if (input.ticketId && !UUID_RE.test(input.ticketId)) return fail("ตั๋วไม่ถูกต้อง");

    const tableRes = await getTable(input.tableId, ctx.storeId);
    if (!tableRes.data) return fail("ไม่พบโต๊ะ");
    const tableLabel = tableRes.data.label ?? String(tableRes.data.number);

    const openRes = await listActiveQrOrders(ctx.storeId);
    if (openRes.error) return fail(openRes.error.userMessage);
    const waiting = (openRes.data ?? []).filter((o) => o.tableId === input.tableId && o.prepStatus === "new");
    if (waiting.length > 0) {
      return fail(`ยังมีออเดอร์ที่ครัวยังไม่รับ (${waiting.map((o) => `#${o.orderNumber}`).join(", ")}) — ให้ครัวรับหรือปฏิเสธก่อนเช็คบิล`);
    }

    let ticketUpdatedAt: string | null = null;
    let cart: Cart | null = null;
    if (input.ticketId) {
      const ticketRes = await getSavedTicket(input.ticketId, ctx.storeId);
      if (ticketRes.error) return fail(ticketRes.error.userMessage);
      const ticket = ticketRes.data;
      if (!ticket || ticket.tableId !== input.tableId) return fail("ตั๋วของโต๊ะไม่ถูกต้อง");
      ticketUpdatedAt = ticket.updatedAt;
      cart = ticket.cart.items.length > 0 ? ticket.cart : null;
    }

    let posOrderId: string | null = null;
    if (cart) {
      if (cart.storeId !== ctx.storeId) return fail("ตะกร้าไม่ตรงกับร้าน");
      const canDiscount = !cartRequestsDiscount(cart) || resolved.can("pos.discount");
      const created = await createPosOrderCore(user, ctx, canDiscount, cart, {
        tableId: input.tableId,
        tableNumber: tableLabel,
        // ผูกกับเวอร์ชันของตั๋ว: ตั๋วเปลี่ยน = ออเดอร์ใหม่ (RPC ตรวจเวอร์ชันซ้ำอีกชั้น)
        idempotencyKey: `tblpos-${input.operationKey}-${Date.parse(ticketUpdatedAt ?? "") || 0}`,
      });
      if (created.error || !created.orderId) return fail(created.error ?? "สร้างรายการจากตั๋วไม่สำเร็จ");
      posOrderId = created.orderId;
    }

    const supabase = await createSupabaseServerClient();
    const { data: billId, error: rpcError } = await supabase.rpc("consolidate_table_bill", {
      p_store_id: ctx.storeId,
      p_table_id: input.tableId,
      p_table_bill_key: `tbl-${input.operationKey}`,
      p_order_number: generateOrderNumber({ timeZone: ctx.storeTimezone }),
      p_pos_order_id: posOrderId,
      p_ticket_id: input.ticketId ?? null,
      p_ticket_updated_at: ticketUpdatedAt,
    });
    if (rpcError || !billId) {
      // ออเดอร์ POS จากตั๋วยังไม่ถูกรวม/ตัดสต๊อก → ยกเลิกทิ้ง ไม่ให้ค้างเป็นบิลลอย
      if (posOrderId) {
        await supabase
          .from("orders")
          .update({ status: "cancelled", updated_at: new Date().toISOString() })
          .eq("id", posOrderId)
          .eq("store_id", ctx.storeId)
          .in("status", ["open", "pending_payment"])
          .is("merged_into_order_id", null);
      }
      const message = rpcError?.message ?? "รวมบิลไม่สำเร็จ";
      await safeLog({
        level: "warn",
        source: "pos.table_bill",
        action: "consolidate",
        message: `รวมบิลโต๊ะ ${tableLabel} ไม่สำเร็จ: ${message}`,
        organizationId: ctx.organizationId,
        storeId: ctx.storeId,
        actorUserId: user.id,
        context: { tableId: input.tableId, posOrderId },
      });
      return fail(message);
    }

    const orderRes = await getOrder(billId);
    if (orderRes.error || !orderRes.data) return fail(orderRes.error?.userMessage ?? "อ่านบิลรวมไม่สำเร็จ");
    const order = orderRes.data;
    await safeLog({
      level: "info",
      source: "pos.table_bill",
      action: "consolidate",
      message: `รวมบิลโต๊ะ ${tableLabel} เป็น #${order.orderNumber} ยอด ${order.total.toFixed(2)}`,
      organizationId: ctx.organizationId,
      storeId: ctx.storeId,
      actorUserId: user.id,
      context: { tableId: input.tableId, billOrderId: billId, posOrderId, itemCount: order.items.length },
    });
    revalidatePath("/pos", "page");
    return { order: { orderId: order.id, orderNumber: order.orderNumber }, cart: orderToBillCart(order), error: null };
  } catch (e) {
    return fail(e instanceof Error ? e.message : "เกิดข้อผิดพลาด");
  }
}

export interface TableBillFinish {
  closed: boolean;
  notice: string | null;
  error: string | null;
}

/**
 * หลังเก็บเงินบิลรวมสำเร็จ: ปิดโต๊ะ + ลบตั๋วว่างของโต๊ะ
 * - เฉพาะออเดอร์ที่เป็นบิลรวม (table_bill_key) และจ่ายแล้วจริง
 * - มีออเดอร์/ตั๋วค้างใหม่ = ไม่ปิดโต๊ะ · อ่านไม่ได้ = ไม่ปิด (fail closed)
 * - idempotent: เรียกซ้ำได้ (โต๊ะปิดแล้วก็ปิดซ้ำได้)
 */
async function finishTableBillIfConsolidated(
  ctx: { storeId: string; organizationId: string; userId: string },
  orderId: string,
): Promise<TableBillFinish | null> {
  const supabase = await createSupabaseServerClient();
  const { data: bill, error: billError } = await supabase
    .from("orders")
    .select("id, status, table_id, table_bill_key")
    .eq("id", orderId)
    .eq("store_id", ctx.storeId)
    .maybeSingle();
  if (billError) return { closed: false, notice: null, error: "อ่านบิลรวมไม่สำเร็จ — ปิดโต๊ะเองที่ \"เปิดโต๊ะ\"" };
  if (!bill?.table_bill_key || !bill.table_id) return null;
  if (bill.status !== "paid") return { closed: false, notice: null, error: "บิลโต๊ะยังไม่ได้ชำระ" };
  const tableId = bill.table_id;

  const unpaid = await findTableUnpaidContext(supabase, ctx.storeId, tableId);
  if (!unpaid.ok) {
    await safeLog({
      level: "warn",
      source: "pos.table_bill",
      action: "finish",
      message: `ชำระบิลรวมแล้ว แต่ตรวจบิลค้างไม่ได้ — ไม่ปิดโต๊ะ`,
      organizationId: ctx.organizationId,
      storeId: ctx.storeId,
      actorUserId: ctx.userId,
      context: { tableId, orderId },
    });
    return { closed: false, notice: null, error: `${unpaid.error} — โต๊ะยังเปิดอยู่` };
  }
  if (unpaid.hasUnpaid) {
    await safeLog({
      level: "warn",
      source: "pos.table_bill",
      action: "finish",
      message: `ชำระบิลรวมแล้ว แต่โต๊ะยังมีบิลค้าง (${describeTableUnpaid(unpaid)}) — ไม่ปิดโต๊ะ`,
      organizationId: ctx.organizationId,
      storeId: ctx.storeId,
      actorUserId: ctx.userId,
      context: { tableId, orderId, openOrders: unpaid.openOrders, nonEmptyTickets: unpaid.nonEmptyTickets },
    });
    // โต๊ะยังใช้งานต่อ → เก็บตั๋วอัตโนมัติไว้ให้ออเดอร์ใหม่แสดงในตั๋วเดิม
    return {
      closed: false,
      notice: `ลูกค้าสั่งเพิ่มระหว่างเช็คบิล (${describeTableUnpaid(unpaid)}) — โต๊ะยังเปิดอยู่`,
      error: null,
    };
  }

  const close = await closeTableSession(ctx.storeId, tableId);
  await deleteEmptyTableTickets(ctx, tableId, "tableBillPaid");
  await safeLog({
    level: close.error ? "warn" : "info",
    source: "pos.table_bill",
    action: "finish",
    message: close.error ? `ชำระบิลรวมแล้ว แต่ปิดโต๊ะไม่สำเร็จ: ${close.error.userMessage}` : "ชำระบิลรวมแล้ว ปิดโต๊ะ",
    organizationId: ctx.organizationId,
    storeId: ctx.storeId,
    actorUserId: ctx.userId,
    context: { tableId, orderId },
  });
  revalidatePath("/pos", "page");
  return close.error
    ? { closed: false, notice: null, error: close.error.userMessage }
    : { closed: true, notice: null, error: null };
}

/** ปิดโต๊ะหลังเก็บเงินบิลรวม (สำรอง/สั่งซ้ำด้วยมือ — ปกติ collectPaymentAction ทำให้แล้ว) */
export async function finishTableBillAction(orderId: string): Promise<TableBillFinish> {
  try {
    const { user, ctx, resolved } = await getResolvedCurrentPermissions();
    if (!resolved.can("pos.use")) return { closed: false, notice: null, error: "ไม่มีสิทธิ์ใช้งาน POS" };
    if (!UUID_RE.test(orderId)) return { closed: false, notice: null, error: "ข้อมูลไม่ถูกต้อง" };
    const result = await finishTableBillIfConsolidated(
      { storeId: ctx.storeId, organizationId: ctx.organizationId, userId: user.id },
      orderId,
    );
    return result ?? { closed: false, notice: null, error: "ออเดอร์นี้ไม่ใช่บิลรวมโต๊ะ" };
  } catch (e) {
    return { closed: false, notice: null, error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}

/** แก้ไขก่อนจ่าย: ยกเลิกรายการ QR ของโต๊ะจากหน้า POS (คืนสต๊อก/ยอดจอง ผ่าน void_qr_order_item) */
export async function voidTableQrItemAction(
  orderId: string,
  itemId: string,
  reason?: string,
): Promise<{ error: string | null }> {
  try {
    const { user, ctx, resolved } = await getResolvedCurrentPermissions();
    if (!resolved.can("pos.use")) return { error: "ไม่มีสิทธิ์ใช้งาน POS" };
    if (!UUID_RE.test(orderId) || !UUID_RE.test(itemId)) return { error: "รายการไม่ถูกต้อง" };
    const trimmed = reason?.trim().slice(0, 100) || "แก้ไขก่อนชำระ";
    const res = await voidQrOrderItem(ctx.storeId, orderId, itemId, trimmed);
    await safeLog({
      level: res.error ? "warn" : "info",
      source: "pos.table_bill",
      action: "voidQrItem",
      message: res.error ? `ยกเลิกรายการ QR ไม่สำเร็จ: ${res.error.userMessage}` : "ยกเลิกรายการ QR ก่อนชำระ",
      organizationId: ctx.organizationId,
      storeId: ctx.storeId,
      actorUserId: user.id,
      context: { orderId, itemId, reason: trimmed },
    });
    if (res.error) return { error: res.error.userMessage };
    revalidatePath("/pos", "page");
    return { error: null };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}

// --- Unified table bill: รวมออร์เดอร์ QR + ตั๋ว POS ที่พักไว้ ต่อโต๊ะ เป็นบิลเดียว ---

export interface TableBillTicketItem {
  name: string;
  variantName?: string;
  unitName?: string;
  modifierNames: string[];
  quantity: number;
  unitPrice: number;
  totalPrice: number;
  note?: string;
}

export interface TableBillTicket {
  id: string;
  label: string;
  total: number;
  itemCount: number;
  /** รายการในตั๋ว (ใช้พิมพ์ใบแจ้งยอด/ใบเสร็จรวมของโต๊ะ) */
  items: TableBillTicketItem[];
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
      listTableSavedTickets(ctx.storeId),
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
      // ตั๋วว่าง (เปิดรอไว้ตอนเปิดโต๊ะ) ไม่ใช่บิลค้าง
      if (!ticket.tableId || isEmptyTicket(ticket)) continue;
      const bill = ensure(ticket.tableId, ticket.tableNumber ?? "-");
      bill.tickets.push({
        id: ticket.id,
        label: ticket.label || ticket.ticketNumber,
        total: ticket.cart.total,
        itemCount: ticket.cart.items.length,
        items: ticket.cart.items.map((item) => ({
          name: item.productName,
          variantName: item.variant?.name,
          unitName: item.unit?.name,
          modifierNames: item.modifiers.map((m) => m.option.name),
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          totalPrice: item.totalPrice,
          note: item.note,
        })),
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
 *
 * U7 (v0.35.7): ร้านที่เปิด flag unified_pos_enabled → เส้นทาง governed:
 *   ตั๋ว POS ก่อน (checkoutAndPayAction — ขั้นชำระ routing governed เอง) แล้วชำระ
 *   ทุกบิล QR ของโต๊ะ + ปิด session ใน RPC เดียว (unified_pos_settle_table_order,
 *   mode whole_table) แบบ atomic + idempotent + rewards exactly-once โดยยอดรวม
 *   อ่านจาก DB ฝั่ง server; ร้านที่ยังไม่เปิด flag ใช้เส้นทางเดิมทุกอย่าง
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
      listTableSavedTickets(ctx.storeId, tableId),
    ]);
    if (ordersRes.error) return fail(ordersRes.error.userMessage);
    if (ticketsRes.error) return fail(ticketsRes.error.userMessage);

    const qrOrders = (ordersRes.data ?? []).filter((o) => o.tableId === tableId);
    const tableTickets = (ticketsRes.data ?? []).filter((t) => t.tableId === tableId);
    // ตั๋วว่างไม่มีอะไรให้คิดเงิน (checkout ตะกร้าว่าง = error) → ลบทิ้งตอนปิดโต๊ะ
    const tickets = tableTickets.filter((t) => !isEmptyTicket(t));
    if (qrOrders.length === 0 && tickets.length === 0) {
      return fail("โต๊ะนี้ไม่มีบิลค้างชำระ");
    }

    // U7: flags-gated whole-table — ตั๋ว POS ก่อน (ขั้นชำระของ checkoutAndPayAction
    // routing governed เองเมื่อ flag on) เพื่อให้ความล้มเหลวของตั๋วไม่ทิ้งบิล QR ที่
    // ชำระไปแล้ว แล้วปิดทุกบิล QR ของโต๊ะ + ปิด session ใน RPC เดียวแบบ atomic
    // (ยอดรวมทั้งโต๊ะอ่านฝั่ง server ใน RPC — ไม่เชื่อยอด client)
    const unifiedFlag = await getUnifiedPosStoreFlag(ctx.storeId);
    if (unifiedFlag.enabled && unifiedFlag.organizationId) {
      let settledCount = 0;
      let total = 0;

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

      const settled = await settleOrdersGoverned({
        organizationId: unifiedFlag.organizationId,
        storeId: ctx.storeId,
        mode: "whole_table",
        tableId,
        method,
        actorUserId: ctx.userId,
      });
      if (!settled.ok) {
        if (settled.error.code === "up_not_found") {
          // โต๊ะไม่มีบิล QR เปิดอยู่ (มีแต่ตั๋ว) → ปิด session ตามพฤติกรรม legacy
          const close = await closeTableSession(ctx.storeId, tableId);
          await deleteEmptyTableTickets(ctx, tableId, "settleWholeTable", tableTickets);
          revalidatePath("/pos", "page");
          return { error: null, settledCount, total, closed: !close.error };
        }
        return { error: settled.error.userMessage, settledCount, total, closed: false };
      }
      settledCount += settled.result.order_ids.length;
      total += settled.result.grand_total;
      if (settled.result.table_closed) await deleteEmptyTableTickets(ctx, tableId, "settleWholeTable", tableTickets);
      revalidatePath("/pos", "page");
      return { error: null, settledCount, total, closed: settled.result.table_closed };
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

    // 3) ปิดโต๊ะ (คืนโต๊ะว่าง) + ลบตั๋วว่างที่เปิดรอไว้
    const close = await closeTableSession(ctx.storeId, tableId);
    await deleteEmptyTableTickets(ctx, tableId, "settleWholeTable", tableTickets);
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

/**
 * แก้ช่องทางชำระของบิลที่จ่ายแล้ว — เคสจริงคือ "ลูกค้าโอนแต่พนักงานกดเงินสด"
 * ซึ่งเดิมต้องยกเลิกบิลแล้วออกใหม่ทั้งใบ (เลขบิล/แต้ม/สต๊อกรวนโดยไม่จำเป็น)
 *
 * สิทธิ์เท่ากับการยกเลิกบิล และ RPC จะยอมเฉพาะบิลในรอบเงินสดที่เปิดอยู่เท่านั้น
 * ทุกครั้งที่แก้ต้องมี log เพราะเป็นการแตะตัวเลขเงินสดของร้านย้อนหลัง
 */
export async function changeOrderPaymentMethodAction(input: {
  orderId: string;
  method: PaymentMethod;
  reason?: string;
  receivedAmount?: number;
  changeAmount?: number;
  reference?: string;
}): Promise<{ error: string | null; order: Order | null }> {
  try {
    await requirePermission("pos.delete_bill");
    const { user, ctx } = await getStoreContext();

    const result = await changeOrderPaymentMethod({
      orderId: input.orderId,
      storeId: ctx.storeId,
      actorUserId: user.id,
      method: input.method,
      reason: input.reason ?? null,
      receivedAmount: input.receivedAmount ?? null,
      changeAmount: input.changeAmount ?? null,
      reference: input.reference ?? null,
    });
    if (result.error) {
      await logSystemEvent({
        level: "warn",
        source: "pos.payment",
        action: "changeOrderPaymentMethod",
        message: `แก้ช่องทางชำระไม่สำเร็จ: ${result.error.userMessage}`,
        organizationId: ctx.organizationId,
        storeId: ctx.storeId,
        context: { orderId: input.orderId, method: input.method },
      });
      return { error: result.error.userMessage, order: null };
    }

    await logSystemEvent({
      level: "info",
      source: "pos.payment",
      action: "changeOrderPaymentMethod",
      message: `แก้ช่องทางชำระเป็น ${input.method}`,
      organizationId: ctx.organizationId,
      storeId: ctx.storeId,
      context: {
        orderId: input.orderId,
        method: input.method,
        reason: input.reason ?? null,
      },
    });

    // คืนบิลที่อัปเดตแล้วให้ POS พิมพ์ใบใหม่ต่อได้ทันที — ใบที่ลูกค้าถืออยู่ยังบอกช่องทางเก่า
    const updated = await getOrder(input.orderId);
    return { error: null, order: updated.data ?? null };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด", order: null };
  }
}

/**
 * QR รับแต้มท้ายใบเสร็จ — เรียกตอนจะพิมพ์/แสดงใบเสร็จของบิลที่เพิ่งจ่าย
 *
 * คืน null เมื่อบิลนั้นไม่ควรมี QR (ผูกลูกค้าไว้แล้ว = ได้แต้มไปตั้งแต่จ่ายเงิน,
 * ร้านปิดสะสมแต้ม, หรือคำนวณแล้วได้ 0 แต้ม) — เรียกซ้ำได้รหัสเดิมเสมอ
 */
export async function getReceiptLoyaltyClaimAction(orderId: string): Promise<{
  error: string | null;
  claim: { url: string; code: string; points: number; expiresAt: string } | null;
}> {
  try {
    await requirePermission("pos.use");
    const { ctx } = await getStoreContext();
    if (!UUID_RE.test(orderId)) return { error: "ออร์เดอร์ไม่ถูกต้อง", claim: null };

    const codeRes = await ensureLoyaltyClaimCode(ctx.storeId, orderId);
    if (codeRes.error) return { error: codeRes.error.userMessage, claim: null };
    if (!codeRes.data || codeRes.data.claimed) return { error: null, claim: null };

    const storeRes = await getStore(ctx.storeId);
    if (storeRes.error) return { error: storeRes.error.userMessage, claim: null };
    const slug = storeRes.data?.slug;
    if (!slug) return { error: "ร้านค้ายังไม่มี slug สำหรับ QR รับแต้ม", claim: null };

    // ลิงก์สมาชิกของร้าน (get-or-create) — QR ต้องพาลูกค้าเข้าหน้าร้านที่ถูกต้อง
    const portal = await generateMemberPortalLink({
      organizationId: ctx.organizationId,
      storeId: ctx.storeId,
    });
    if (portal.error) return { error: portal.error.userMessage, claim: null };
    if (!portal.data?.token) return { error: "ไม่สามารถสร้างลิงก์สมาชิกสำหรับ QR รับแต้มได้", claim: null };

    const h = await headers();
    const host = h.get("host") ?? "";
    const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
    const baseUrl = host ? `${proto}://${host}` : "";
    if (!baseUrl) return { error: "ไม่สามารถระบุ URL สำหรับ QR รับแต้มได้", claim: null };

    return {
      error: null,
      claim: {
        url: buildLoyaltyClaimUrl({
          baseUrl,
          storeSlug: slug,
          portalToken: portal.data.token,
          code: codeRes.data.code,
        }),
        code: codeRes.data.code,
        points: codeRes.data.points,
        expiresAt: codeRes.data.expiresAt,
      },
    };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด", claim: null };
  }
}

/**
 * แคชเชียร์ตัดสินผลของงานพิมพ์ที่ระบบไม่รู้ผล (สถานะ unknown)
 *
 * สิทธิ์ที่ใช้คือ pos.use ไม่ใช่สิทธิ์ตั้งค่าเครื่องพิมพ์ เพราะคนที่ตอบได้ว่า
 * "กระดาษออกมาแล้วหรือยัง" คือคนที่ยืนอยู่หน้าเครื่องพิมพ์ตอนนั้น ถ้าบังคับให้เฉพาะ
 * ผู้จัดการกดได้ ร้านเล็กที่มีพนักงานคนเดียวจะไม่มีใครเคลียร์งานค้างได้เลย
 * ทุกครั้งที่กดมีบันทึกว่าใครเป็นคนตัดสิน
 */
export async function resolveUnknownPrintJobFromPosAction(input: {
  jobId: string;
  resolution: "printed_confirmed" | "retried";
}): Promise<{ error: string | null; status?: "printed" | "pending" }> {
  try {
    await requirePermission("pos.use");
    const { user, ctx } = await getStoreContext();

    const jobId = input.jobId?.trim();
    if (!jobId) return { error: "ไม่พบงานพิมพ์ที่ต้องการจัดการ" };
    if (input.resolution !== "printed_confirmed" && input.resolution !== "retried") {
      return { error: "ตัวเลือกไม่ถูกต้อง" };
    }

    const result = await resolveUnknownPrintJob({
      jobId,
      storeId: ctx.storeId,
      resolution: input.resolution,
      userId: user.id,
    });
    if (result.error || !result.data) {
      return { error: result.error?.userMessage ?? "จัดการงานพิมพ์ไม่สำเร็จ" };
    }

    await logSystemEvent({
      level: "info",
      source: "printing.hub",
      action: "resolveUnknownPrintJobFromPos",
      message:
        input.resolution === "printed_confirmed"
          ? "แคชเชียร์ยืนยันว่าใบพิมพ์ออกแล้ว — ปิดงานที่ไม่ทราบผล"
          : "แคชเชียร์สั่งพิมพ์งานที่ไม่ทราบผลใหม่",
      organizationId: ctx.organizationId,
      storeId: ctx.storeId,
      context: { jobId, resolution: input.resolution, newStatus: result.data.status },
    });

    return { error: null, status: result.data.status };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}


export async function getTrueMoneyPosStatusAction(): Promise<{
  enabled: boolean;
  configured: boolean;
}> {
  try {
    const { ctx } = await getResolvedCurrentPermissions();
    const billing =
      (await getOrganizationBillingState(ctx.organizationId)) ?? DEFAULT_BILLING_STATE;
    if (!canUseFeature(billing, "byoPaymentGateway")) {
      return { enabled: false, configured: false };
    }
    const config = await getEnabledTrueMoneyManualConfig(ctx.storeId);
    const configured = Boolean(config.data?.staticEmvPayload);
    return { enabled: configured, configured };
  } catch {
    return { enabled: false, configured: false };
  }
}

export async function prepareTrueMoneyQrAction(
  amount: number,
): Promise<{ payload: string | null; error: string | null }> {
  try {
    const { ctx, resolved } = await getResolvedCurrentPermissions();
    if (!resolved.can("pos.use")) return { payload: null, error: "ไม่มีสิทธิ์ใช้งาน POS" };
    await requireFeature("byoPaymentGateway");
    const prepared = await prepareTrueMoneyManualQr({
      storeId: ctx.storeId,
      amountMajor: amount,
    });
    if (!prepared.ok) return { payload: null, error: prepared.error };
    return { payload: prepared.injectedPayload, error: null };
  } catch (e) {
    return { payload: null, error: e instanceof Error ? e.message : "สร้าง QR ไม่สำเร็จ" };
  }
}

/** Whether the POS should offer "Beam QR" (plan feature + store has Beam keys enabled). */
export async function getBeamPosStatusAction(): Promise<{ enabled: boolean }> {
  try {
    const { ctx } = await getResolvedCurrentPermissions();
    const billing =
      (await getOrganizationBillingState(ctx.organizationId)) ?? DEFAULT_BILLING_STATE;
    if (!canUseFeature(billing, "byoPaymentGateway")) return { enabled: false };
    return { enabled: await isBeamReadyForStore(ctx.storeId) };
  } catch {
    return { enabled: false };
  }
}

export async function prepareBeamQrAction(
  amount: number,
  clientRequestId: string,
): Promise<{ qr: BeamQrForPos | null; error: string | null }> {
  try {
    const { user, ctx, resolved } = await getResolvedCurrentPermissions();
    if (!resolved.can("pos.use")) return { qr: null, error: "ไม่มีสิทธิ์ใช้งาน POS" };
    if (!UUID_RE.test(clientRequestId)) return { qr: null, error: "คำขอไม่ถูกต้อง" };
    await requireFeature("byoPaymentGateway");
    const res = await createBeamQrPayment({
      organizationId: ctx.organizationId,
      storeId: ctx.storeId,
      amountMajor: amount,
      clientRequestId,
      actorUserId: user.id,
    });
    if (!res.ok) return { qr: null, error: res.error };
    return { qr: res.qr, error: null };
  } catch (e) {
    return { qr: null, error: e instanceof Error ? e.message : "สร้าง QR Beam ไม่สำเร็จ" };
  }
}

export async function getBeamPaymentStatusAction(
  gatewayPaymentId: string,
): Promise<{ status: GatewayPaymentStatus | null; error: string | null }> {
  try {
    const { ctx, resolved } = await getResolvedCurrentPermissions();
    if (!resolved.can("pos.use")) return { status: null, error: "ไม่มีสิทธิ์ใช้งาน POS" };
    if (!UUID_RE.test(gatewayPaymentId)) return { status: null, error: "คำขอไม่ถูกต้อง" };
    const res = await refreshBeamPayment({ storeId: ctx.storeId, gatewayPaymentId });
    if (!res.ok) return { status: null, error: res.error };
    return { status: res.status, error: null };
  } catch (e) {
    return { status: null, error: e instanceof Error ? e.message : "ตรวจสถานะ Beam ไม่สำเร็จ" };
  }
}

export async function cancelBeamQrAction(gatewayPaymentId: string): Promise<{ error: string | null }> {
  try {
    const { user, ctx, resolved } = await getResolvedCurrentPermissions();
    if (!resolved.can("pos.use")) return { error: "ไม่มีสิทธิ์ใช้งาน POS" };
    if (!UUID_RE.test(gatewayPaymentId)) return { error: null };
    return await cancelBeamQrPayment({ storeId: ctx.storeId, gatewayPaymentId, actorUserId: user.id });
  } catch (e) {
    return { error: e instanceof Error ? e.message : "ยกเลิก QR ไม่สำเร็จ" };
  }
}
