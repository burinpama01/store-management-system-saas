"use server";

import { createSupabaseServiceClient } from "@/server/integrations/supabase/server";
import { getOrganizationBillingState } from "@/modules/billing/billing-service";
import {
  DEFAULT_BILLING_STATE,
  getPlanFeatures,
} from "@/modules/billing/types";
import { generateOrderNumber } from "@/modules/pos/order-number";
import { notifyOwnerSafely } from "@/modules/notifications/dispatcher";
import type { Json } from "@/server/integrations/supabase/database.types";
import type { SelectedModifier } from "@/modules/pos/types";
import type { QrOrderView, ServiceRequestType } from "@/modules/qr-ordering/types";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUUID(s: string): boolean {
  return UUID_RE.test(s);
}

export interface QrOrderItem {
  productId: string;
  variantId?: string;
  modifierOptionIds: string[];
  quantity: number;
  note?: string;
}

export async function submitQrOrderAction(
  storeId: string,
  tableId: string,
  items: QrOrderItem[],
): Promise<{ orderId: string | null; orderNumber: string | null; error: string | null }> {
  // --- Input validation ---
  if (!isUUID(storeId) || !isUUID(tableId)) {
    return { orderId: null, orderNumber: null, error: "Invalid request" };
  }
  if (!items.length || items.length > 50) {
    return { orderId: null, orderNumber: null, error: items.length === 0 ? "Cart is empty" : "Too many items" };
  }
  for (const item of items) {
    if (!isUUID(item.productId)) return { orderId: null, orderNumber: null, error: "Invalid request" };
    if (item.variantId !== undefined && !isUUID(item.variantId)) {
      return { orderId: null, orderNumber: null, error: "Invalid request" };
    }
    if (item.modifierOptionIds.length > 20) {
      return { orderId: null, orderNumber: null, error: "Invalid request" };
    }
    for (const id of item.modifierOptionIds) {
      if (!isUUID(id)) return { orderId: null, orderNumber: null, error: "Invalid request" };
    }
    if (!Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 99) {
      return { orderId: null, orderNumber: null, error: "Invalid quantity" };
    }
    if (item.note && item.note.length > 200) {
      return { orderId: null, orderNumber: null, error: "Note is too long" };
    }
  }

  const supabase = await createSupabaseServiceClient();

  // Verify store
  const { data: store, error: storeErr } = await supabase
    .from("stores")
    .select("id, organization_id, qr_ordering_enabled, is_active, timezone, qr_ordering_mode, table_open_policy")
    .eq("id", storeId)
    .single();
  if (storeErr || !store) return { orderId: null, orderNumber: null, error: "Store not found" };
  if (!store.is_active) return { orderId: null, orderNumber: null, error: "Store is closed" };
  const billingState =
    (await getOrganizationBillingState(store.organization_id)) ??
    DEFAULT_BILLING_STATE;
  const features = getPlanFeatures(billingState);
  if (!features.qrOrdering) {
    return {
      orderId: null,
      orderNumber: null,
      error: "QR ordering is not available in the current package",
    };
  }
  if (!store.qr_ordering_enabled) {
    return { orderId: null, orderNumber: null, error: "QR ordering is disabled for this store" };
  }

  // Verify table — fetch number from DB, not from client
  const { data: table, error: tableErr } = await supabase
    .from("tables")
    .select("id, store_id, number, qr_enabled, is_active, session_expires_at, current_session_id")
    .eq("id", tableId)
    .single();
  if (tableErr || !table) return { orderId: null, orderNumber: null, error: "Table not found" };
  if (table.store_id !== storeId) return { orderId: null, orderNumber: null, error: "Invalid table" };
  if (!table.is_active || !table.qr_enabled) {
    return { orderId: null, orderNumber: null, error: "Table is not available for QR ordering" };
  }
  // Timed session gate: orders need an active table session. For stores that let
  // customers open the table themselves (table_bound + customer_self), the first
  // order opens the session automatically; otherwise reject (staff must open it).
  const sessionExpiry = table.session_expires_at ? Date.parse(table.session_expires_at) : null;
  const sessionActive = sessionExpiry !== null && sessionExpiry > Date.now();
  if (!sessionActive) {
    const canSelfOpen =
      store.qr_ordering_mode === "table_bound" && store.table_open_policy === "customer_self";
    if (!canSelfOpen) {
      return { orderId: null, orderNumber: null, error: "หมดเวลาสั่งอาหารของโต๊ะนี้แล้ว กรุณาแจ้งพนักงาน" };
    }
    const { error: openErr } = await supabase.rpc("open_table_session_self", {
      p_store_id: storeId,
      p_table_id: tableId,
    });
    if (openErr) {
      return { orderId: null, orderNumber: null, error: "ไม่สามารถเปิดโต๊ะได้ กรุณาแจ้งพนักงาน" };
    }
  }

  // Batch-fetch products
  const productIds = [...new Set(items.map((i) => i.productId))];
  const { data: productRows, error: productsErr } = await supabase
    .from("products")
    .select("id, store_id, name, base_price, is_active, available_for_qr, kitchen_station_id")
    .in("id", productIds);
  if (productsErr) return { orderId: null, orderNumber: null, error: "Failed to verify menu items" };

  const productMap = new Map((productRows ?? []).map((p) => [p.id, p]));
  const kitchenStationIds = [
    ...new Set((productRows ?? []).map((p) => p.kitchen_station_id).filter((id): id is string => Boolean(id))),
  ];
  const { data: activeStationRows, error: stationsErr } = kitchenStationIds.length > 0
    ? await supabase
        .from("kitchen_stations")
        .select("id")
        .eq("store_id", storeId)
        .eq("is_active", true)
        .in("id", kitchenStationIds)
    : { data: [], error: null };
  if (stationsErr) {
    return { orderId: null, orderNumber: null, error: "Failed to verify menu items" };
  }
  const activeKitchenStationIds = new Set((activeStationRows ?? []).map((station) => station.id));
  for (const id of productIds) {
    const p = productMap.get(id);
    if (!p || p.store_id !== storeId) return { orderId: null, orderNumber: null, error: "Menu item not found" };
    if (!p.is_active || !p.available_for_qr) {
      return { orderId: null, orderNumber: null, error: "Menu item is not available" };
    }
    if (!p.kitchen_station_id || !activeKitchenStationIds.has(p.kitchen_station_id)) {
      return {
        orderId: null,
        orderNumber: null,
        error: "QR menu item must be assigned to a kitchen station",
      };
    }
  }

  // Batch-fetch all active variants for selected products so server can enforce required size choices.
  const variantMap = new Map<string, {
    id: string;
    product_id: string;
    name: string;
    price_adjustment: number;
    stock_quantity: number | null;
    track_stock: boolean;
    is_active: boolean;
  }>();
  const variantsByProduct = new Map<string, Array<{
    id: string;
    product_id: string;
    name: string;
    price_adjustment: number;
    stock_quantity: number | null;
    track_stock: boolean;
    is_active: boolean;
  }>>();
  {
    const { data: variantRows, error: varErr } = await supabase
      .from("product_variants")
      .select("id, product_id, name, price_adjustment, stock_quantity, track_stock, is_active")
      .in("product_id", productIds)
      .eq("is_active", true);
    if (varErr) return { orderId: null, orderNumber: null, error: "Failed to verify variants" };
    for (const v of (variantRows ?? [])) {
      variantMap.set(v.id, v);
      const next = variantsByProduct.get(v.product_id) ?? [];
      next.push(v);
      variantsByProduct.set(v.product_id, next);
    }
  }

  // Batch-fetch modifier groups/options for selected products so required/min/max rules are server-enforced.
  const { data: groupRows, error: groupErr } = await supabase
    .from("modifier_groups")
    .select("id, product_id, name, selection_type, is_required, min_selections, max_selections")
    .in("product_id", productIds);
  if (groupErr) return { orderId: null, orderNumber: null, error: "Failed to verify modifiers" };
  const groupMap = new Map<string, { id: string; product_id: string; name: string; selection_type: string; is_required: boolean; min_selections: number; max_selections: number }>();
  const groupsByProduct = new Map<string, { id: string; product_id: string; name: string; selection_type: string; is_required: boolean; min_selections: number; max_selections: number }[]>();
  for (const g of (groupRows ?? [])) {
    groupMap.set(g.id, g);
    const next = groupsByProduct.get(g.product_id) ?? [];
    next.push(g);
    groupsByProduct.set(g.product_id, next);
  }

  const groupIds = (groupRows ?? []).map((g) => g.id);
  const optionIds = [...new Set(items.flatMap((i) => i.modifierOptionIds))];
  const optionMap = new Map<string, { id: string; modifier_group_id: string; name: string; price_adjustment: number; is_active: boolean }>();
  const optionsByGroup = new Map<string, { id: string; modifier_group_id: string; name: string; price_adjustment: number; is_active: boolean }[]>();
  if (groupIds.length > 0) {
    const { data: optionRows, error: optErr } = await supabase
      .from("modifier_options")
      .select("id, modifier_group_id, name, price_adjustment, is_active")
      .in("modifier_group_id", groupIds)
      .eq("is_active", true);
    if (optErr) return { orderId: null, orderNumber: null, error: "Failed to verify modifiers" };
    for (const o of (optionRows ?? [])) {
      optionMap.set(o.id, o);
      const next = optionsByGroup.get(o.modifier_group_id) ?? [];
      next.push(o);
      optionsByGroup.set(o.modifier_group_id, next);
    }
  }
  for (const id of optionIds) {
    if (!optionMap.has(id)) {
      return { orderId: null, orderNumber: null, error: "Invalid modifier selection" };
    }
  }

  // Compute order lines with server-side prices
  let subtotal = 0;
  type OrderLine = {
    productId: string;
    productName: string;
    variantId: string | null;
    variantName: string | null;
    modifiersJson: Json;
    quantity: number;
    unitPrice: number;
    totalPrice: number;
    note: string | null;
  };
  const orderLines: OrderLine[] = [];
  const requestedStockByVariant = new Map<string, { requested: number; available: number }>();

  for (const item of items) {
    const product = productMap.get(item.productId)!;
    let unitPrice = product.base_price;
    let variantId: string | null = null;
    let variantName: string | null = null;

    if (item.variantId) {
      const variant = variantMap.get(item.variantId);
      if (!variant || variant.product_id !== item.productId || !variant.is_active) {
        return { orderId: null, orderNumber: null, error: "Invalid variant selection" };
      }
      unitPrice += variant.price_adjustment;
      variantId = variant.id;
      variantName = variant.name;
      if (variant.track_stock && typeof variant.stock_quantity === "number") {
        const current = requestedStockByVariant.get(variant.id) ?? {
          requested: 0,
          available: variant.stock_quantity,
        };
        current.requested += item.quantity;
        requestedStockByVariant.set(variant.id, current);
        if (current.requested > current.available) {
          return { orderId: null, orderNumber: null, error: "สินค้าเหลือไม่พอ" };
        }
      }
    } else if ((variantsByProduct.get(item.productId) ?? []).length > 0) {
      return { orderId: null, orderNumber: null, error: "Variant selection is required" };
    }

    const modifiersJson: {
      modifierGroupId: string;
      modifierGroupName: string;
      option: { id: string; name: string; priceAdjustment: number };
    }[] = [];
    const seenOptions = new Set<string>();
    const selectedByGroup = new Map<string, string[]>();

    for (const optId of item.modifierOptionIds) {
      if (seenOptions.has(optId)) return { orderId: null, orderNumber: null, error: "Duplicate modifier selection" };
      seenOptions.add(optId);
      const opt = optionMap.get(optId);
      if (!opt || !opt.is_active) {
        return { orderId: null, orderNumber: null, error: "Invalid modifier selection" };
      }
      const group = groupMap.get(opt.modifier_group_id);
      if (!group || group.product_id !== item.productId) {
        return { orderId: null, orderNumber: null, error: "Modifier does not belong to the product" };
      }
      const next = selectedByGroup.get(group.id) ?? [];
      next.push(opt.id);
      selectedByGroup.set(group.id, next);
      unitPrice += opt.price_adjustment;
      modifiersJson.push({
        modifierGroupId: group.id,
        modifierGroupName: group.name,
        option: { id: opt.id, name: opt.name, priceAdjustment: opt.price_adjustment },
      });
    }
    for (const group of groupsByProduct.get(item.productId) ?? []) {
      const selectedCount = (selectedByGroup.get(group.id) ?? []).length;
      const minSelections = group.is_required ? Math.max(1, group.min_selections) : group.min_selections;
      if (selectedCount < minSelections) {
        return { orderId: null, orderNumber: null, error: "Required modifier selection is missing" };
      }
      if (selectedCount > group.max_selections) {
        return { orderId: null, orderNumber: null, error: "Too many modifier selections" };
      }
      if (group.selection_type === "single" && selectedCount > 1) {
        return { orderId: null, orderNumber: null, error: "Invalid single-choice modifier selection" };
      }
      for (const optId of selectedByGroup.get(group.id) ?? []) {
        if (!(optionsByGroup.get(group.id) ?? []).some((opt) => opt.id === optId)) {
          return { orderId: null, orderNumber: null, error: "Invalid modifier selection" };
        }
      }
    }

    const totalPrice = unitPrice * item.quantity;
    subtotal += totalPrice;

    orderLines.push({
      productId: item.productId,
      productName: product.name,
      variantId,
      variantName,
      modifiersJson: modifiersJson as unknown as Json,
      quantity: item.quantity,
      unitPrice,
      totalPrice,
      note: item.note?.trim() ?? null,
    });
  }

  const orderNumber = generateOrderNumber({ timeZone: store.timezone });
  const rpcItems = orderLines.map((line) => ({
    product_id: line.productId,
    product_name: line.productName,
    variant_id: line.variantId,
    variant_name: line.variantName,
    modifiers: line.modifiersJson,
    quantity: line.quantity,
    unit_price: line.unitPrice,
    total_price: line.totalPrice,
    note: line.note,
  })) as unknown as Json;

  const { data: orderId, error: orderErr } = await supabase.rpc("create_qr_order_with_items", {
    p_organization_id: store.organization_id,
    p_store_id: storeId,
    p_table_id: tableId,
    p_order_number: orderNumber,
    p_subtotal: subtotal,
    p_items: rpcItems,
  });

  if (orderErr || !orderId) {
    return { orderId: null, orderNumber: null, error: orderErr?.message ?? "Failed to create order" };
  }

  if (table.current_session_id) {
    notifyOwnerSafely({
      type: "new_buffet_order",
      organizationId: store.organization_id,
      storeId,
      title: "มีออเดอร์บุฟเฟต์ใหม่",
      message: `โต๊ะ ${table.number} ส่งออเดอร์ ${orderNumber} ยอด ${subtotal.toFixed(2)}`,
      metadata: {
        orderId,
        orderNumber,
        tableId,
        tableNumber: table.number,
        total: subtotal,
        source: "qr",
      },
    });
  } else {
    notifyOwnerSafely({
      type: "new_qr_order",
      organizationId: store.organization_id,
      storeId,
      title: "มีออเดอร์ QR ใหม่",
      message: `โต๊ะ ${table.number} ส่งออเดอร์ ${orderNumber} ยอด ${subtotal.toFixed(2)}`,
      metadata: {
        orderId,
        orderNumber,
        tableId,
        tableNumber: table.number,
        total: subtotal,
        source: "qr",
      },
    });
  }

  return { orderId, orderNumber, error: null };
}

// --- Customer order tracking + service requests ---

/** Fetch the customer's own orders by id (ids are held client-side after submitting). */
export async function getTableOrdersAction(
  storeId: string,
  tableId: string,
  orderIds: string[],
): Promise<{ orders: QrOrderView[]; error: string | null }> {
  if (!isUUID(storeId) || !isUUID(tableId)) return { orders: [], error: "Invalid request" };
  const ids = [...new Set(orderIds)].filter(isUUID).slice(0, 50);
  if (ids.length === 0) return { orders: [], error: null };

  const supabase = await createSupabaseServiceClient();
  const { data: orderRows, error } = await supabase
    .from("orders")
    .select("id, order_number, status, prep_status, table_id, table_number, total, note, created_at, paid_at")
    .eq("store_id", storeId)
    .eq("table_id", tableId)
    .in("id", ids)
    .order("created_at", { ascending: false });

  if (error) return { orders: [], error: "ไม่สามารถโหลดออร์เดอร์ได้" };
  const rows = orderRows ?? [];
  if (rows.length === 0) return { orders: [], error: null };

  const { data: itemRows } = await supabase
    .from("order_items")
    .select("id, order_id, product_name, variant_name, kitchen_station_id, kitchen_station_name, modifiers, quantity, unit_price, total_price, note")
    .in("order_id", rows.map((r) => r.id));

  const itemsByOrder = new Map<string, QrOrderView["items"]>();
  for (const it of itemRows ?? []) {
    const next = itemsByOrder.get(it.order_id) ?? [];
    next.push({
      id: it.id,
      productName: it.product_name,
      variantName: it.variant_name ?? undefined,
      kitchenStationId: it.kitchen_station_id ?? undefined,
      kitchenStationName: it.kitchen_station_name ?? undefined,
      modifiers: (it.modifiers as unknown as SelectedModifier[]) ?? [],
      quantity: it.quantity,
      unitPrice: it.unit_price,
      totalPrice: it.total_price,
      note: it.note ?? undefined,
    });
    itemsByOrder.set(it.order_id, next);
  }

  const orders: QrOrderView[] = rows.map((row) => ({
    id: row.id,
    orderNumber: row.order_number,
    status: row.status,
    prepStatus: row.prep_status,
    tableId: row.table_id ?? undefined,
    tableNumber: row.table_number ?? undefined,
    total: row.total,
    note: row.note ?? undefined,
    createdAt: row.created_at,
    paidAt: row.paid_at ?? undefined,
    items: itemsByOrder.get(row.id) ?? [],
  }));

  return { orders, error: null };
}

export async function requestServiceAction(
  storeId: string,
  tableId: string,
  type: ServiceRequestType,
  reason?: string,
): Promise<{ ok: boolean; error: string | null }> {
  if (!isUUID(storeId) || !isUUID(tableId)) return { ok: false, error: "Invalid request" };
  if (type !== "call_staff" && type !== "request_bill") {
    return { ok: false, error: "Invalid request" };
  }
  const note = reason?.trim().slice(0, 100) || null;

  const supabase = await createSupabaseServiceClient();

  // Verify store is active + QR enabled + plan allows QR ordering.
  const { data: store, error: storeErr } = await supabase
    .from("stores")
    .select("id, organization_id, qr_ordering_enabled, is_active")
    .eq("id", storeId)
    .single();
  if (storeErr || !store) return { ok: false, error: "Store not found" };
  if (!store.is_active || !store.qr_ordering_enabled) {
    return { ok: false, error: "QR ordering is disabled for this store" };
  }
  const { data: table, error: tableErr } = await supabase
    .from("tables")
    .select("id, store_id, number, qr_enabled, is_active")
    .eq("id", tableId)
    .single();
  if (tableErr || !table || table.store_id !== storeId) {
    return { ok: false, error: "Table not found" };
  }
  if (!table.is_active || !table.qr_enabled) {
    return { ok: false, error: "Table is not available for QR ordering" };
  }
  const billingState =
    (await getOrganizationBillingState(store.organization_id)) ?? DEFAULT_BILLING_STATE;
  if (!getPlanFeatures(billingState).qrOrdering) {
    return { ok: false, error: "QR ordering is not available in the current package" };
  }

  const { error } = await supabase.rpc("create_service_request", {
    p_store_id: storeId,
    p_table_id: tableId,
    p_type: type,
    p_note: note,
  });
  if (error) return { ok: false, error: error.message };
  notifyOwnerSafely({
    type: "service_request",
    organizationId: store.organization_id,
    storeId,
    title: type === "request_bill" ? "ลูกค้าขอเช็คบิล" : "ลูกค้าเรียกพนักงาน",
    message: `โต๊ะ ${table.number} ${type === "request_bill" ? "ขอเช็คบิล" : "เรียกพนักงาน"}${note ? `: ${note}` : ""}`,
    metadata: {
      tableId,
      tableNumber: table.number,
      requestType: type,
      note,
      source: "qr",
    },
  });
  return { ok: true, error: null };
}
