"use server";

import { getCurrentUser, getUserStores, resolveCurrentStore } from "@/modules/auth/session";
import { requirePermission } from "@/modules/auth/guards";
import { listProducts } from "@/modules/catalog/repository";
import { createOrderWithItems, addPaymentAndClose, voidOrder } from "@/modules/pos/order-repository";
import { buildTrustedCartFromCatalog } from "@/modules/pos/server-cart";
import type { Cart } from "@/modules/pos/types";
import type { AddPaymentInput } from "@/modules/pos/order-repository";

async function getStoreContext() {
  const user = await getCurrentUser();
  if (!user) throw new Error("ไม่มีสิทธิ์เข้าถึง");
  const { organizations, stores, memberships } = await getUserStores();
  const ctx = await resolveCurrentStore(stores, organizations, memberships);
  if (!ctx) throw new Error("ไม่พบข้อมูลร้านค้า");
  return { user, ctx };
}

export async function submitOrderAction(
  cart: Cart,
  opts?: { tableId?: string; tableNumber?: string; note?: string },
): Promise<{ orderId: string | null; orderNumber: string | null; error: string | null }> {
  try {
    await requirePermission("pos.use");
    const { user, ctx } = await getStoreContext();

    if (cart.items.length === 0) return { orderId: null, orderNumber: null, error: "ไม่มีรายการในออร์เดอร์" };
    const canDiscount = cart.discount <= 0 || await requirePermission("pos.discount").then(() => true).catch(() => false);
    const productsRes = await listProducts(ctx.storeId, { includeInactive: false });
    if (productsRes.error || !productsRes.data) {
      return { orderId: null, orderNumber: null, error: productsRes.error?.userMessage ?? "ไม่สามารถตรวจสอบสินค้าได้" };
    }
    const trustedCart = buildTrustedCartFromCatalog(cart, productsRes.data, {
      storeId: ctx.storeId,
      canDiscount,
    });

    const result = await createOrderWithItems({
      storeId: ctx.storeId,
      organizationId: ctx.organizationId,
      cashierId: user.id,
      storeTimezone: ctx.storeTimezone,
      cart: trustedCart,
      tableId: opts?.tableId,
      tableNumber: opts?.tableNumber,
      note: opts?.note,
    });

    if (result.error) return { orderId: null, orderNumber: null, error: result.error.userMessage };
    return { orderId: result.data.id, orderNumber: result.data.orderNumber, error: null };
  } catch (e) {
    return { orderId: null, orderNumber: null, error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}

export async function collectPaymentAction(
  orderId: string,
  payment: AddPaymentInput,
): Promise<{ error: string | null }> {
  try {
    await requirePermission("pos.use");
    const { user, ctx } = await getStoreContext();

    const result = await addPaymentAndClose(orderId, ctx.storeId, user.id, payment);

    if (result.error) return { error: result.error.userMessage };
    return { error: null };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
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
    return { error: null };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}
