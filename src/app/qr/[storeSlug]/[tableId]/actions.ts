"use server";

import { createSupabaseServiceClient } from "@/server/integrations/supabase/server";
import { getOrganizationBillingState } from "@/modules/billing/billing-service";
import {
  DEFAULT_BILLING_STATE,
  getPlanFeatures,
} from "@/modules/billing/types";
import { generateOrderNumber } from "@/modules/pos/order-number";
import { notifyOwnerSafely } from "@/modules/notifications/dispatcher";
import { notifyLowStockAfterSaleSafely } from "@/modules/stock/notify";
import { getCurrentUser } from "@/modules/auth/session";
import {
  computeRequestHash,
  createOperationKey,
  isValidOperationKey,
  type UnifiedPosTableOrderRpcOutcome,
} from "@/modules/unified-pos/envelope";
import type { Json } from "@/server/integrations/supabase/database.types";
import type { SelectedModifier } from "@/modules/pos/types";
import {
  SERVICE_REQUEST_LABEL,
  SERVICE_REQUEST_TYPES,
  type QrOrderView,
  type ServiceRequestType,
} from "@/modules/qr-ordering/types";

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

/**
 * Server action สำหรับลูกค้าส่งออร์เดอร์ QR (U4):
 *   - operationKey: key ของ request (client สร้างต่อ 1 ครั้งการกดส่งและ reuse เมื่อ retry
 *     ของ request เดียวกัน — ถ้าไม่ส่งมา server จะสร้างให้ต่อ request lifecycle)
 *   - internalStaffContext: ใช้เฉพาะโดย addItemsToTableAction (POS) เพื่อสลับไปเส้นทาง
 *     staff add-items (qr_order_source=false) — actor ต้องเป็น session user คนเดียวกัน
 *     เสมอ (กันการปลอม actor จากการเรียก action ตรง ๆ) และสิทธิ์ pos.use ถูก enforce
 *     ซ้ำที่ชั้น RPC add_items_to_table_v2
 */
export async function submitQrOrderAction(
  storeId: string,
  tableId: string,
  items: QrOrderItem[],
  operationKey?: string,
  internalStaffContext?: { actorUserId: string },
): Promise<{ orderId: string | null; orderNumber: string | null; error: string | null }> {
  return submitTableOrder(storeId, tableId, items, {
    operationKey,
    staffActorUserId: internalStaffContext?.actorUserId ?? null,
  });
}

/** Core ร่วมของ QR submit + staff add-items (ไม่ export — เรียกผ่าน server action ข้างบน) */
async function submitTableOrder(
  storeId: string,
  tableId: string,
  items: QrOrderItem[],
  opts: { operationKey?: string; staffActorUserId: string | null },
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

  // staff path (add-items จาก POS): actor ต้องเป็น session user คนเดียวกันเสมอ —
  // ป้องกันการปลอม uuid ของพนักงานคนอื่นผ่านการเรียก server action ตรง ๆ
  // (สิทธิ์ pos.use ถูก enforce อีกชั้นที่ RPC add_items_to_table_v2)
  if (opts.staffActorUserId) {
    const sessionUser = await getCurrentUser();
    if (!sessionUser || sessionUser.id !== opts.staffActorUserId) {
      return { orderId: null, orderNumber: null, error: "Invalid request" };
    }
  }

  // Verify store
  const { data: store, error: storeErr } = await supabase
    .from("stores")
    .select("id, organization_id, qr_ordering_enabled, is_active, timezone, qr_ordering_mode, table_open_policy, unified_pos_enabled")
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
    .select("id, store_id, number, qr_enabled, is_active, session_started_at, session_expires_at, current_session_id")
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
  // "ไม่จับเวลา" = session_started_at ถูกเซ็ต แต่ session_expires_at เป็น null → เปิดตลอด
  const sessionExpiry = table.session_expires_at ? Date.parse(table.session_expires_at) : null;
  const sessionStarted = table.session_started_at ? Date.parse(table.session_started_at) : null;
  const sessionActive =
    (sessionExpiry !== null && sessionExpiry > Date.now()) ||
    (sessionStarted !== null && sessionExpiry === null);
  if (!sessionActive) {
    const canSelfOpen =
      store.qr_ordering_mode === "table_bound" && store.table_open_policy === "customer_self";
    if (!canSelfOpen) {
      return { orderId: null, orderNumber: null, error: "หมดเวลาสั่งอาหารของโต๊ะนี้แล้ว กรุณาแจ้งพนักงาน" };
    }
    if (!store.unified_pos_enabled) {
      // เส้นทางเดิม (v1): เปิด session แยกก่อนสร้าง order — เส้นทาง v2 จะ auto-open
      // ใน RPC เองแบบ atomic (lock table row + เปิด session + สร้าง order ใน transaction เดียว)
      const { error: openErr } = await supabase.rpc("open_table_session_self", {
        p_store_id: storeId,
        p_table_id: tableId,
      });
      if (openErr) {
        return { orderId: null, orderNumber: null, error: "ไม่สามารถเปิดโต๊ะได้ กรุณาแจ้งพนักงาน" };
      }
    }
  }

  // Batch-fetch products
  const productIds = [...new Set(items.map((i) => i.productId))];
  const { data: productRows, error: productsErr } = await supabase
    .from("products")
    .select("id, store_id, name, base_price, is_active, available_for_qr, out_of_stock, kitchen_station_id")
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
    if (p.out_of_stock) {
      return { orderId: null, orderNumber: null, error: `${p.name} ของหมดแล้ว` };
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

  const notifyNewOrder = (createdOrderId: string, createdOrderNumber: string) => {
    if (table.current_session_id) {
      notifyOwnerSafely({
        type: "new_buffet_order",
        organizationId: store.organization_id,
        storeId,
        title: "มีออเดอร์บุฟเฟต์ใหม่",
        message: `โต๊ะ ${table.number} ส่งออเดอร์ ${createdOrderNumber} ยอด ${subtotal.toFixed(2)}`,
        metadata: {
          orderId: createdOrderId,
          orderNumber: createdOrderNumber,
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
        message: `โต๊ะ ${table.number} ส่งออเดอร์ ${createdOrderNumber} ยอด ${subtotal.toFixed(2)}`,
        metadata: {
          orderId: createdOrderId,
          orderNumber: createdOrderNumber,
          tableId,
          tableNumber: table.number,
          total: subtotal,
          source: "qr",
        },
      });
    }
  };

  // --- เส้นทาง v2 (U4): atomic + idempotent — เปิดใช้เมื่อร้านเปิด flag unified_pos_enabled ---
  if (store.unified_pos_enabled) {
    const isStaff = opts.staffActorUserId !== null;
    // key ต่อ 1 ครั้งการส่ง — client ส่งมา (reuse ตอน retry ของ request เดียวกัน) จะใช้ค่านั้น
    const key =
      opts.operationKey && isValidOperationKey(opts.operationKey)
        ? opts.operationKey
        : createOperationKey();
    // hash เฉพาะ semantic ของคำขอ — ห้ามรวม orderNumber (ที่ regenerate ตอน retry)
    // มิฉะนั้น retry ที่ถือ key เดิมจะโดน hash_conflict ทั้งที่เป็นคำขอเดียวกัน
    const requestHash = computeRequestHash({ storeId, tableId, subtotal, items });

    const rpcName = isStaff ? "add_items_to_table_v2" : "create_qr_order_with_items_v2";
    const rpcArgs = {
      p_organization_id: store.organization_id,
      p_store_id: storeId,
      p_table_id: tableId,
      p_order_number: orderNumber,
      p_operation_key: key,
      p_request_hash: requestHash,
      p_subtotal: subtotal,
      p_items: rpcItems,
    };

    // เรียก RPC ด้วยชื่อ literal ต่อเส้นทาง (typed client ตรวจชื่อ/args ระดับ type)
    const { data: outcome, error: rpcErr } = opts.staffActorUserId
      ? await supabase.rpc("add_items_to_table_v2", {
          ...rpcArgs,
          p_actor_user_id: opts.staffActorUserId,
        })
      : await supabase.rpc("create_qr_order_with_items_v2", rpcArgs);
    if (rpcErr) {
      return { orderId: null, orderNumber: null, error: rpcErr.message ?? "Failed to create order" };
    }
    const parsed = outcome as UnifiedPosTableOrderRpcOutcome | null;
    if (!parsed) {
      return { orderId: null, orderNumber: null, error: "Failed to create order" };
    }
    if (parsed.status === "error") {
      return { orderId: null, orderNumber: null, error: parsed.message };
    }
    if (parsed.status === "hash_conflict") {
      return {
        orderId: null,
        orderNumber: null,
        error: "คำขอนี้เคยใช้ไปกับรายการที่ต่างกัน กรุณาตรวจรถเข็นและสั่งใหม่อีกครั้ง",
      };
    }
    if (!parsed.result) {
      // replayed แต่ result หมดอายุถูก purge (retention 30 วัน) — tombstone ยังกัน execute ซ้ำ
      return {
        orderId: null,
        orderNumber: null,
        error: "ไม่พบผลลัพธ์เดิมของคำขอนี้ กรุณาสั่งใหม่อีกครั้ง",
      };
    }

    if (parsed.status === "executed") {
      // แจ้งเตือนเฉพาะ executed — replay ต้องไม่แจ้งซ้ำ
      notifyNewOrder(parsed.result.order_id, parsed.result.order_number);
      // low-stock alert ผูกกับ "การหักสต๊อกจริง": QR หักตอนสร้าง (convention 20260607000006)
      // ส่วน staff (qr_order_source=false) หักตอนชำระ จึงไม่เรียกที่นี่
      if (!isStaff) {
        notifyLowStockAfterSaleSafely(
          store.organization_id,
          storeId,
          orderLines.map((line) => ({ variantId: line.variantId, baseQuantity: line.quantity })),
        );
      }
    }
    return { orderId: parsed.result.order_id, orderNumber: parsed.result.order_number, error: null };
  }

  // --- เส้นทางเดิม (unified_pos_enabled=false): RPC v1 ตามพฤติกรรมเดิมทุกอย่าง ---
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

  notifyNewOrder(orderId, orderNumber);

  notifyLowStockAfterSaleSafely(
    store.organization_id,
    storeId,
    orderLines.map((line) => ({ variantId: line.variantId, baseQuantity: line.quantity })),
  );

  return { orderId, orderNumber, error: null };
}

// --- Customer order tracking + service requests ---

/**
 * ออร์เดอร์ของโต๊ะสำหรับหน้าลูกค้า: ทุกออเดอร์ที่ยังเปิดอยู่ของโต๊ะ (รวมที่พนักงาน
 * เพิ่มจาก POS — ลูกค้าต้องเห็นบิลรวมของโต๊ะ) + ออเดอร์ที่เครื่องนี้เคยสั่งตาม id
 * (เก็บใน localStorage เพื่อให้เห็นประวัติที่จ่ายแล้วของตัวเอง)
 *
 * ทุกอย่างถูกจำกัดอยู่ใน "รอบเปิดโต๊ะปัจจุบัน" (created_at >= session_started_at):
 * เปิดโต๊ะรอบใหม่แล้ว ลูกค้าต้องไม่เห็นรายการรอบก่อนที่ชำระ/ค้างไว้
 */
export async function getTableOrdersAction(
  storeId: string,
  tableId: string,
  orderIds: string[],
): Promise<{ orders: QrOrderView[]; error: string | null }> {
  if (!isUUID(storeId) || !isUUID(tableId)) return { orders: [], error: "Invalid request" };
  const ids = [...new Set(orderIds)].filter(isUUID).slice(0, 50);

  const supabase = await createSupabaseServiceClient();

  // ขอบเขตรอบปัจจุบันของโต๊ะ — ไม่มีรอบเปิดอยู่ = ไม่โชว์ออเดอร์เปิดของโต๊ะ
  // (กันลูกค้ารอบใหม่เห็นบิลค้างของรอบก่อนที่ร้านปิดโต๊ะโดยยังไม่เก็บเงิน)
  const { data: tableRow } = await supabase
    .from("tables")
    .select("session_started_at")
    .eq("id", tableId)
    .eq("store_id", storeId)
    .maybeSingle();
  const sessionStartedAt = tableRow?.session_started_at ?? null;

  const ORDER_SELECT =
    "id, order_number, status, prep_status, table_id, table_number, total, note, created_at, paid_at";
  const buildMineQuery = () => {
    let q = supabase
      .from("orders")
      .select(ORDER_SELECT)
      .eq("store_id", storeId)
      .eq("table_id", tableId)
      .in("id", ids)
      .order("created_at", { ascending: false });
    // จำกัดประวัติของเครื่องนี้ให้อยู่ในรอบปัจจุบัน — รอบใหม่ไม่เห็นรายการเก่า
    if (sessionStartedAt) q = q.gte("created_at", sessionStartedAt);
    return q;
  };
  const [openRes, mineRes] = await Promise.all([
    sessionStartedAt
      ? supabase
          .from("orders")
          .select(ORDER_SELECT)
          .eq("store_id", storeId)
          .eq("table_id", tableId)
          .eq("qr_order_source", true)
          .in("status", ["open", "pending_payment"])
          .gte("created_at", sessionStartedAt)
          .order("created_at", { ascending: false })
      : Promise.resolve({ data: [], error: null }),
    ids.length > 0 ? buildMineQuery() : Promise.resolve({ data: [], error: null }),
  ]);

  if (openRes.error && mineRes.error) return { orders: [], error: "ไม่สามารถโหลดออร์เดอร์ได้" };
  const byId = new Map<string, NonNullable<typeof openRes.data>[number]>();
  for (const row of [...(openRes.data ?? []), ...(mineRes.data ?? [])]) byId.set(row.id, row);
  const rows = [...byId.values()].sort((a, b) => b.created_at.localeCompare(a.created_at));
  if (rows.length === 0) return { orders: [], error: null };

  const { data: itemRows } = await supabase
    .from("order_items")
    .select("id, order_id, product_name, variant_name, kitchen_station_id, kitchen_station_name, modifiers, quantity, unit_price, total_price, note, voided, voided_reason")
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
      voided: it.voided,
      voidedReason: it.voided_reason ?? undefined,
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
  if (!SERVICE_REQUEST_TYPES.includes(type)) {
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
  const requestLabel = note ?? SERVICE_REQUEST_LABEL[type];
  notifyOwnerSafely({
    type: "service_request",
    organizationId: store.organization_id,
    storeId,
    title: type === "request_bill" ? "ลูกค้าขอเช็คบิล" : "ลูกค้าเรียกพนักงาน",
    message: `โต๊ะ ${table.number}: ${requestLabel}`,
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

/**
 * Lets a customer cancel their own QR order — but only while the kitchen has not
 * accepted it yet (prep_status = 'new'). Restores the stock deducted at creation.
 */
export async function cancelQrOrderAction(
  storeId: string,
  tableId: string,
  orderId: string,
): Promise<{ ok: boolean; error: string | null }> {
  if (!isUUID(storeId) || !isUUID(tableId) || !isUUID(orderId)) {
    return { ok: false, error: "คำขอไม่ถูกต้อง" };
  }

  const supabase = await createSupabaseServiceClient();

  const { data: store, error: storeErr } = await supabase
    .from("stores")
    .select("id, is_active, qr_ordering_enabled")
    .eq("id", storeId)
    .single();
  if (storeErr || !store) return { ok: false, error: "ไม่พบร้าน" };
  if (!store.is_active || !store.qr_ordering_enabled) {
    return { ok: false, error: "ร้านไม่พร้อมรับ QR order" };
  }

  const { error } = await supabase.rpc("cancel_qr_order_by_customer", {
    p_store_id: storeId,
    p_table_id: tableId,
    p_order_id: orderId,
  });
  if (error) return { ok: false, error: error.message };
  return { ok: true, error: null };
}
