// StoreOS Connect — ชั้นเข้าถึงข้อมูล (service_role เท่านั้น) สำหรับตาราง connect_*
import { randomBytes } from "node:crypto";
import { createSupabaseServiceClient } from "@/server/integrations/supabase/server";
import { mapError } from "@/shared/utils/error";
import type { FulfillmentStatus } from "./types";
import { CONNECT_CHANNEL_JDC } from "./types";
import type { ProductForDelivery } from "./menu-payload";

export interface ChannelLink {
  id: string;
  organizationId: string;
  storeId: string;
  channel: string;
  externalMerchantId: string;
  status: "active" | "paused" | "disconnected";
  webhookSecret: string;
  autoAccept: boolean;
  createdAt: string;
  updatedAt: string;
}

interface ChannelLinkRow {
  id: string;
  organization_id: string;
  store_id: string;
  channel: string;
  external_merchant_id: string;
  status: "active" | "paused" | "disconnected";
  webhook_secret: string;
  auto_accept: boolean;
  created_at: string;
  updated_at: string;
}

function mapLink(r: ChannelLinkRow): ChannelLink {
  return {
    id: r.id,
    organizationId: r.organization_id,
    storeId: r.store_id,
    channel: r.channel,
    externalMerchantId: r.external_merchant_id,
    status: r.status,
    webhookSecret: r.webhook_secret,
    autoAccept: r.auto_accept,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const LINK_COLS =
  "id, organization_id, store_id, channel, external_merchant_id, status, webhook_secret, auto_accept, created_at, updated_at";

/** สร้าง webhook secret (shared กับฝั่ง JDC) */
export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(24).toString("hex")}`;
}

export async function listChannelLinks(organizationId: string): Promise<ChannelLink[]> {
  const supabase = await createSupabaseServiceClient();
  const { data } = await supabase
    .from("connect_channel_links")
    .select(LINK_COLS)
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false });
  return (data ?? []).map(mapLink);
}

export async function getChannelLinkById(
  organizationId: string,
  id: string,
): Promise<ChannelLink | null> {
  const supabase = await createSupabaseServiceClient();
  const { data } = await supabase
    .from("connect_channel_links")
    .select(LINK_COLS)
    .eq("organization_id", organizationId)
    .eq("id", id)
    .maybeSingle();
  return data ? mapLink(data) : null;
}

/** ใช้ตอน webhook ขาเข้า: หา link จาก merchant_id ฝั่ง JDC */
export async function getActiveLinkByMerchant(
  externalMerchantId: string,
  channel: string = CONNECT_CHANNEL_JDC,
): Promise<ChannelLink | null> {
  const supabase = await createSupabaseServiceClient();
  const { data } = await supabase
    .from("connect_channel_links")
    .select(LINK_COLS)
    .eq("external_merchant_id", externalMerchantId)
    .eq("channel", channel)
    .eq("status", "active")
    .maybeSingle();
  return data ? mapLink(data) : null;
}

export async function createChannelLink(input: {
  organizationId: string;
  storeId: string;
  channel: string;
  externalMerchantId: string;
  autoAccept: boolean;
}): Promise<{ ok: true; link: ChannelLink } | { ok: false; error: string }> {
  const supabase = await createSupabaseServiceClient();
  const { data, error } = await supabase
    .from("connect_channel_links")
    .insert({
      organization_id: input.organizationId,
      store_id: input.storeId,
      channel: input.channel,
      external_merchant_id: input.externalMerchantId,
      webhook_secret: generateWebhookSecret(),
      auto_accept: input.autoAccept,
    })
    .select(LINK_COLS)
    .single();
  if (error || !data) return { ok: false, error: mapError(error).userMessage };
  return { ok: true, link: mapLink(data) };
}

export async function updateChannelLink(
  organizationId: string,
  id: string,
  patch: Partial<{
    status: "active" | "paused" | "disconnected";
    autoAccept: boolean;
    externalMerchantId: string;
  }>,
): Promise<{ ok: boolean; error: string | null }> {
  const supabase = await createSupabaseServiceClient();
  const { error } = await supabase
    .from("connect_channel_links")
    .update({
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.autoAccept !== undefined ? { auto_accept: patch.autoAccept } : {}),
      ...(patch.externalMerchantId !== undefined
        ? { external_merchant_id: patch.externalMerchantId }
        : {}),
      updated_at: new Date().toISOString(),
    })
    .eq("organization_id", organizationId)
    .eq("id", id);
  if (error) return { ok: false, error: mapError(error).userMessage };
  return { ok: true, error: null };
}

// ── สินค้าเดลิเวอรี + หมวด ────────────────────────────────────────────────
export interface DeliveryProduct extends ProductForDelivery {
  categoryName: string | null;
}

export async function getDeliveryProducts(storeId: string): Promise<DeliveryProduct[]> {
  const supabase = await createSupabaseServiceClient();
  const { data: products } = await supabase
    .from("products")
    .select(
      "id, name, description, image_url, base_price, delivery_price, is_active, available_for_delivery, category_id",
    )
    .eq("store_id", storeId)
    .eq("available_for_delivery", true)
    .order("name");
  if (!products || products.length === 0) return [];

  const categoryIds = [...new Set(products.map((p) => p.category_id))];
  const { data: cats } = await supabase
    .from("categories")
    .select("id, name")
    .in("id", categoryIds);
  const nameById = new Map((cats ?? []).map((c) => [c.id, c.name]));

  return products.map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description,
    image_url: p.image_url,
    base_price: p.base_price,
    delivery_price: p.delivery_price,
    is_active: p.is_active,
    available_for_delivery: p.available_for_delivery,
    categoryName: nameById.get(p.category_id) ?? null,
  }));
}

// ── menu map ────────────────────────────────────────────────────────────
export interface MenuMapEntry {
  productId: string;
  externalItemId: string | null;
  syncHash: string | null;
}

export async function getMenuMapForLink(linkId: string): Promise<Map<string, MenuMapEntry>> {
  const supabase = await createSupabaseServiceClient();
  const { data } = await supabase
    .from("connect_menu_map")
    .select("product_id, external_item_id, sync_hash")
    .eq("link_id", linkId);
  return new Map(
    (data ?? []).map((r) => [
      r.product_id,
      { productId: r.product_id, externalItemId: r.external_item_id, syncHash: r.sync_hash },
    ]),
  );
}

export async function upsertMenuMap(
  linkId: string,
  productId: string,
  patch: {
    externalItemId?: string | null;
    syncHash?: string | null;
    lastSyncedAt?: string | null;
    lastError?: string | null;
  },
): Promise<void> {
  const supabase = await createSupabaseServiceClient();
  await supabase
    .from("connect_menu_map")
    .upsert(
      {
        link_id: linkId,
        product_id: productId,
        ...(patch.externalItemId !== undefined ? { external_item_id: patch.externalItemId } : {}),
        ...(patch.syncHash !== undefined ? { sync_hash: patch.syncHash } : {}),
        ...(patch.lastSyncedAt !== undefined ? { last_synced_at: patch.lastSyncedAt } : {}),
        ...(patch.lastError !== undefined ? { last_error: patch.lastError } : {}),
      },
      { onConflict: "link_id,product_id" },
    );
}

/** หา product_id ภายในจาก external_item_id (สำหรับ map ออเดอร์ขาเข้า) — ใช้ id StoreOS ที่ JDC เก็บไว้ */
export async function resolveProductIdByExternalRef(
  storeId: string,
  externalRef: string,
): Promise<string | null> {
  const supabase = await createSupabaseServiceClient();
  // external_ref ฝั่ง JDC = products.id ของ StoreOS (ดู menu-payload.buildMenuItemPayload)
  const { data } = await supabase
    .from("products")
    .select("id")
    .eq("store_id", storeId)
    .eq("id", externalRef)
    .maybeSingle();
  return data?.id ?? null;
}

export interface ResolvedInboundProduct {
  productId: string;
  kitchenStationId: string | null;
  kitchenStationName: string | null;
}

/**
 * map external_ref (= products.id) → ข้อมูลสินค้า + ครัวที่รับผิดชอบ (batch)
 * ใช้ตอนรับออเดอร์ JDC เพื่อสร้าง order_items + route ตั๋วครัวตาม kitchen station
 */
export async function resolveProductsForInbound(
  storeId: string,
  externalRefs: string[],
): Promise<Map<string, ResolvedInboundProduct>> {
  const refs = [...new Set(externalRefs.filter(Boolean))];
  if (refs.length === 0) return new Map();
  const supabase = await createSupabaseServiceClient();
  const { data: products } = await supabase
    .from("products")
    .select("id, kitchen_station_id")
    .eq("store_id", storeId)
    .in("id", refs);
  const stationIds = [
    ...new Set((products ?? []).map((p) => p.kitchen_station_id).filter((v): v is string => Boolean(v))),
  ];
  const stationNames = new Map<string, string>();
  if (stationIds.length > 0) {
    const { data: stations } = await supabase
      .from("kitchen_stations")
      .select("id, name")
      .in("id", stationIds);
    for (const s of stations ?? []) stationNames.set(s.id, s.name);
  }
  return new Map(
    (products ?? []).map((p) => [
      p.id,
      {
        productId: p.id,
        kitchenStationId: p.kitchen_station_id,
        kitchenStationName: p.kitchen_station_id
          ? stationNames.get(p.kitchen_station_id) ?? null
          : null,
      },
    ]),
  );
}

// ── connect_orders ──────────────────────────────────────────────────────
export interface ConnectOrder {
  id: string;
  organizationId: string;
  linkId: string;
  externalOrderId: string;
  internalOrderId: string | null;
  fulfillmentStatus: FulfillmentStatus;
  lastStatusOrigin: string | null;
  receivedAt: string;
}

interface ConnectOrderRow {
  id: string;
  organization_id: string;
  link_id: string;
  external_order_id: string;
  internal_order_id: string | null;
  fulfillment_status: FulfillmentStatus;
  last_status_origin: string | null;
  received_at: string;
}

function mapConnectOrder(r: ConnectOrderRow): ConnectOrder {
  return {
    id: r.id,
    organizationId: r.organization_id,
    linkId: r.link_id,
    externalOrderId: r.external_order_id,
    internalOrderId: r.internal_order_id,
    fulfillmentStatus: r.fulfillment_status,
    lastStatusOrigin: r.last_status_origin,
    receivedAt: r.received_at,
  };
}

const CO_COLS =
  "id, organization_id, link_id, external_order_id, internal_order_id, fulfillment_status, last_status_origin, received_at";

export async function getConnectOrder(
  linkId: string,
  externalOrderId: string,
): Promise<ConnectOrder | null> {
  const supabase = await createSupabaseServiceClient();
  const { data } = await supabase
    .from("connect_orders")
    .select(CO_COLS)
    .eq("link_id", linkId)
    .eq("external_order_id", externalOrderId)
    .maybeSingle();
  return data ? mapConnectOrder(data) : null;
}

export async function getConnectOrderById(
  organizationId: string,
  id: string,
): Promise<ConnectOrder | null> {
  const supabase = await createSupabaseServiceClient();
  const { data } = await supabase
    .from("connect_orders")
    .select(CO_COLS)
    .eq("organization_id", organizationId)
    .eq("id", id)
    .maybeSingle();
  return data ? mapConnectOrder(data) : null;
}

export async function insertConnectOrder(input: {
  organizationId: string;
  linkId: string;
  externalOrderId: string;
  internalOrderId: string | null;
  fulfillmentStatus: FulfillmentStatus;
  lastStatusOrigin: string;
  rawPayload: unknown;
}): Promise<{ ok: true; order: ConnectOrder } | { ok: false; error: string }> {
  const supabase = await createSupabaseServiceClient();
  const { data, error } = await supabase
    .from("connect_orders")
    .insert({
      organization_id: input.organizationId,
      link_id: input.linkId,
      external_order_id: input.externalOrderId,
      internal_order_id: input.internalOrderId,
      fulfillment_status: input.fulfillmentStatus,
      last_status_origin: input.lastStatusOrigin,
      raw_payload: input.rawPayload as never,
    })
    .select(CO_COLS)
    .single();
  if (error || !data) return { ok: false, error: mapError(error).userMessage };
  return { ok: true, order: mapConnectOrder(data) };
}

export async function updateConnectOrderStatus(
  id: string,
  fulfillmentStatus: FulfillmentStatus,
  origin: string,
): Promise<{ ok: boolean; error: string | null }> {
  const supabase = await createSupabaseServiceClient();
  const { error } = await supabase
    .from("connect_orders")
    .update({
      fulfillment_status: fulfillmentStatus,
      last_status_origin: origin,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);
  if (error) return { ok: false, error: mapError(error).userMessage };
  return { ok: true, error: null };
}

export interface ConnectOrderListItem extends ConnectOrder {
  orderNumber: string | null;
  total: number | null;
  rawPayload: unknown;
}

export async function listConnectOrders(
  organizationId: string,
  limit = 50,
): Promise<ConnectOrderListItem[]> {
  const supabase = await createSupabaseServiceClient();
  const { data } = await supabase
    .from("connect_orders")
    .select(CO_COLS + ", raw_payload, orders(order_number, total)")
    .eq("organization_id", organizationId)
    .order("received_at", { ascending: false })
    .limit(limit);
  return (data ?? []).map((r) => {
    const rec = r as unknown as ConnectOrderRow & {
      raw_payload: unknown;
      orders: { order_number: string; total: number } | null;
    };
    return {
      ...mapConnectOrder(rec),
      orderNumber: rec.orders?.order_number ?? null,
      total: rec.orders?.total ?? null,
      rawPayload: rec.raw_payload,
    };
  });
}

// ── connect_events (audit/outbox) ──────────────────────────────────────
export async function recordEvent(input: {
  linkId: string;
  direction: "outbound" | "inbound";
  topic: string;
  payload: unknown;
  status?: "pending" | "sent" | "failed" | "dead";
  lastError?: string | null;
}): Promise<void> {
  const supabase = await createSupabaseServiceClient();
  await supabase.from("connect_events").insert({
    link_id: input.linkId,
    direction: input.direction,
    topic: input.topic,
    payload: input.payload as never,
    status: input.status ?? "pending",
    ...(input.lastError !== undefined ? { last_error: input.lastError } : {}),
  });
}
