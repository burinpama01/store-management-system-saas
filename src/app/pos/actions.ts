"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
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
  consumeProductRewardVoucher,
  findProductRewardVoucher,
} from "@/modules/loyalty/repository";
import {
  createOrderWithItems,
  addPaymentAndClose,
  closePosOrderPaymentWithRewards,
  createPosOrderWithCustomerRewards,
  getOrder,
  listOrdersHistory,
  listTodayOrders,
  voidOrder,
} from "@/modules/pos/order-repository";
import { listSavedTickets, saveSavedTicket, deleteSavedTicket, deleteSavedTicketAndCloseTable } from "@/modules/pos/saved-ticket-repository";
import { buildTrustedCartFromCatalog } from "@/modules/pos/server-cart";
import { cartRequestsDiscount } from "@/modules/pos/discount-policy";
import { openTableSession, closeTableSession, getStore, getTable, listManagedTables } from "@/modules/stores/repository";
import { listActiveQrOrders } from "@/modules/qr-ordering/repository";
import { notifyOwnerSafely } from "@/modules/notifications/dispatcher";
import { getOpenCashSession } from "@/modules/cashflow/repository";
import type { Cart, Order, SavedOrderTicket } from "@/modules/pos/types";
import type { AddPaymentInput } from "@/modules/pos/order-repository";
import type { QrOrderView } from "@/modules/qr-ordering/types";

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
    const productsRes = await listProducts(ctx.storeId, { includeInactive: false });
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
    revalidatePath("/pos", "page");
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
    revalidatePath("/pos", "page");
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

    const productsRes = await listProducts(ctx.storeId, { includeInactive: false });
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
    await requirePermission("pos.use");
    const { user, ctx } = await getStoreContext();

    if (cart.items.length === 0) return { orderId: null, orderNumber: null, error: "ไม่มีรายการในออร์เดอร์" };
    const rewardItems = cart.items.filter((item) => item.rewardVoucherCode);
    const normalCart: Cart = { ...cart, items: cart.items.filter((item) => !item.rewardVoucherCode) };
    const canDiscount = !cartRequestsDiscount(cart) || await requirePermission("pos.discount").then(() => true).catch(() => false);
    const productsRes = await listProducts(ctx.storeId, { includeInactive: false });
    if (productsRes.error || !productsRes.data) {
      return { orderId: null, orderNumber: null, error: productsRes.error?.userMessage ?? "ไม่สามารถตรวจสอบสินค้าได้" };
    }
    const trustedCart = buildTrustedCartFromCatalog(normalCart, productsRes.data, {
      storeId: ctx.storeId,
      canDiscount,
    });

    // Product reward vouchers: validate the voucher + catalog server-side, then append a ฿0
    // line (stock still deducts via the order RPC). Consumed single-use after the order exists.
    const rewardConsumptions: { redemptionId: string }[] = [];
    const rewardLines: Cart["items"] = [];
    if (rewardItems.length > 0) {
      await requireFeature("loyaltyPoints");
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
        rewardConsumptions.push({ redemptionId: voucherRes.data.redemptionId });
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

          return createPosOrderWithCustomerRewards({
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
      : await createOrderWithItems({
          storeId: ctx.storeId,
          organizationId: ctx.organizationId,
          cashierId: user.id,
          storeTimezone: ctx.storeTimezone,
          cart: finalCart,
          tableId: opts?.tableId,
          tableNumber: opts?.tableNumber,
          note: opts?.note,
        });

    if (result.error) return { orderId: null, orderNumber: null, error: result.error.userMessage };

    // Burn product reward vouchers now that the order (with the ฿0 reward line) exists.
    for (const consumption of rewardConsumptions) {
      const consumed = await consumeProductRewardVoucher(ctx.storeId, consumption.redemptionId, result.data.id);
      if (consumed.error || !consumed.consumed) {
        console.warn("[pos] reward voucher consume issue", {
          storeId: ctx.storeId,
          orderId: result.data.id,
          redemptionId: consumption.redemptionId,
          consumed: consumed.consumed,
          error: consumed.error?.userMessage ?? null,
        });
      }
    }
    if (buffetSessionId) {
      notifyOwnerSafely({
        type: "new_buffet_order",
        organizationId: ctx.organizationId,
        storeId: ctx.storeId,
        title: "มีออเดอร์บุฟเฟต์ใหม่",
        message: `ออเดอร์ ${result.data.orderNumber} ยอด ${result.data.total.toFixed(2)}`,
        metadata: {
          orderId: result.data.id,
          orderNumber: result.data.orderNumber,
          buffetSessionId,
          total: result.data.total,
          source: "pos",
        },
      });
    } else {
      notifyOwnerSafely({
        type: "new_pos_order",
        organizationId: ctx.organizationId,
        storeId: ctx.storeId,
        title: "มีออเดอร์ POS ใหม่",
        message: `ออเดอร์ ${result.data.orderNumber} ยอด ${result.data.total.toFixed(2)}`,
        metadata: {
          orderId: result.data.id,
          orderNumber: result.data.orderNumber,
          total: result.data.total,
          source: "pos",
        },
      });
    }
    return { orderId: result.data.id, orderNumber: result.data.orderNumber, error: null };
  } catch (e) {
    return { orderId: null, orderNumber: null, error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}

export async function collectPaymentAction(
  orderId: string,
  payment: AddPaymentInput,
  opts?: { idempotencyKey?: string | null },
): Promise<{ order: Order | null; error: string | null }> {
  try {
    await requirePermission("pos.use");
    const { user, ctx } = await getStoreContext();

    if (payment.method === "cash") {
      const cashSession = await getOpenCashSession(ctx.storeId);
      if (cashSession.error) return { order: null, error: cashSession.error.userMessage };
      if (!cashSession.data) return { order: null, error: "ต้องเปิดรอบเงินสดก่อนรับเงินสด" };
    }

    if (payment.method === "qr_promptpay" && payment.qrPaymentVerified !== true) {
      return { order: null, error: "กรุณายืนยันว่าได้รับเงิน QR แล้ว" };
    }

    const orderRes = await getOrder(orderId);
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
    return { order: paidOrder, error: null };
  } catch (e) {
    return { order: null, error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface OpenTableStatus {
  id: string;
  number: string;
  label: string | null;
  occupied: boolean;
  currentSessionId: string | null;
  expiresAt: string | null;
  /** Unpaid open QR orders still attached to this table. */
  unpaidCount: number;
  unpaidTotal: number;
}

/** Tables with their open-session status + unpaid-bill info, for the POS open-table picker. */
export async function listTablesForOpenAction(): Promise<{ tables: OpenTableStatus[]; error: string | null }> {
  try {
    await requirePermission("pos.use");
    const { ctx } = await getStoreContext();
    const [tablesRes, ordersRes] = await Promise.all([
      listManagedTables(ctx.storeId),
      listActiveQrOrders(ctx.storeId),
    ]);
    if (tablesRes.error) return { tables: [], error: tablesRes.error.userMessage };

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
        return {
          id: t.id,
          number: t.number,
          label: t.label ?? null,
          occupied: !!t.sessionExpiresAt && Date.parse(t.sessionExpiresAt) > now,
          currentSessionId: t.currentSessionId ?? null,
          expiresAt: t.sessionExpiresAt ?? null,
          unpaidCount: u.count,
          unpaidTotal: u.total,
        };
      });
    return { tables, error: null };
  } catch (e) {
    return { tables: [], error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}

/** Open an à la carte table session using the store's default duration. Returns the slug + expiry for the receipt. */
export async function openTableAction(
  tableId: string,
  minutesOverride?: number,
): Promise<{ error: string | null; expiresAt: string | null; storeSlug: string | null }> {
  try {
    await requirePermission("pos.use");
    const { ctx } = await getStoreContext();
    if (!UUID_RE.test(tableId)) return { error: "โต๊ะไม่ถูกต้อง", expiresAt: null, storeSlug: null };

    const storeRes = await getStore(ctx.storeId);
    const minutes = Number.isInteger(minutesOverride)
      ? minutesOverride!
      : storeRes.data?.dineInDurationMinutes ?? 120;

    const res = await openTableSession(ctx.storeId, tableId, minutes);
    if (res.error) return { error: res.error.userMessage, expiresAt: null, storeSlug: null };

    revalidatePath("/pos", "page");
    return { error: null, expiresAt: res.data, storeSlug: storeRes.data?.slug ?? null };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด", expiresAt: null, storeSlug: null };
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
