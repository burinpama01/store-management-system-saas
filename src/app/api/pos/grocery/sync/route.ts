import { NextRequest, NextResponse } from "next/server";
import {
  AuthorizationError,
  getOptionalResolvedCurrentPermissions,
  requireFeature,
} from "@/modules/auth/guards";
import { createTrustedGroceryOrder } from "@/modules/grocery-pos/checkout-service";
import { normalizePriceTier } from "@/modules/pos/pricing";
import type { GroceryOfflineOrderOperation } from "@/modules/grocery-pos/offline-sync";
import type { Cart } from "@/modules/pos/types";
import type { Json } from "@/server/integrations/supabase/database.types";

export const dynamic = "force-dynamic";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseOperation(body: unknown): GroceryOfflineOrderOperation | null {
  if (!isRecord(body) || !isRecord(body.operation)) return null;
  const operation = body.operation;
  if (operation.operationType !== "create_order") return null;
  if (typeof operation.operationId !== "string") return null;
  if (typeof operation.storeId !== "string") return null;
  if (typeof operation.deviceId !== "string") return null;
  if (typeof operation.idempotencyKey !== "string") return null;
  if (typeof operation.catalogVersion !== "string") return null;
  if (!isRecord(operation.payload) || !isRecord(operation.payload.cart)) return null;
  return operation as unknown as GroceryOfflineOrderOperation;
}

export async function POST(req: NextRequest) {
  let authz: Awaited<ReturnType<typeof getOptionalResolvedCurrentPermissions>>;
  try {
    authz = await getOptionalResolvedCurrentPermissions();
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 403 });
    }
    throw error;
  }

  if (!authz) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  const { user, ctx, resolved } = authz;
  if (!resolved.can("pos.use")) return NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403 });

  try {
    await requireFeature("groceryPos");
    await requireFeature("offlinePos");
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 403 });
    }
    throw error;
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }

  const operation = parseOperation(body);
  if (!operation) {
    return NextResponse.json({ ok: false, error: "Invalid offline operation" }, { status: 400 });
  }
  if (operation.storeId !== ctx.storeId || operation.payload.cart.storeId !== ctx.storeId) {
    return NextResponse.json({ ok: false, error: "Store mismatch" }, { status: 403 });
  }

  const hasCoupon =
    !!operation.payload.couponCode || (operation.payload.clientCouponDiscountAmount ?? 0) > 0;
  if (hasCoupon) {
    try {
      await requireFeature("couponManagement");
    } catch (error) {
      if (error instanceof AuthorizationError) {
        return NextResponse.json({ ok: false, error: error.message }, { status: 403 });
      }
      throw error;
    }
  }

  const result = await createTrustedGroceryOrder({
    organizationId: ctx.organizationId,
    storeId: ctx.storeId,
    cashierId: user.id,
    storeTimezone: ctx.storeTimezone,
    canDiscount: resolved.can("pos.discount"),
    cart: operation.payload.cart as Cart,
    customerId: operation.payload.customerId ?? null,
    priceTier: normalizePriceTier(operation.payload.priceTier),
    couponCode: operation.payload.couponCode ?? null,
    clientCouponDiscountAmount: operation.payload.clientCouponDiscountAmount ?? 0,
    idempotencyKey: operation.idempotencyKey,
    note: operation.payload.note ?? "Grocery POS offline sync",
    sync: {
      deviceId: operation.deviceId,
      catalogVersion: operation.catalogVersion,
      operationPayload: operation as unknown as Json,
    },
  });

  if (result.error || !result.order) {
    const status = result.error === "catalog_conflict" ? 409 : 422;
    return NextResponse.json({ ok: false, error: result.error ?? "Sync failed" }, { status });
  }

  return NextResponse.json({
    ok: true,
    orderId: result.order.id,
    orderNumber: result.order.orderNumber,
  });
}
