"use server";

// หน้าคนส่ง (R4) — พนักงาน (pos.use) รับงาน/ส่งงานออนไลน์ส่งถึงบ้านของตัวเอง
// กติกาเงินทั้งหมดอยู่ใน transition-service (เดียวกับหน้า สั่งออนไลน์/POS) — ที่นี่แค่จำกัดว่าทำได้เฉพาะงานของตัวเอง

import { getResolvedCurrentPermissions } from "@/modules/auth/guards";
import { getOrganizationBillingState } from "@/modules/billing/billing-service";
import { DEFAULT_BILLING_STATE, getPlanFeatures } from "@/modules/billing/types";
import { canUseMemberPrivileges } from "@/modules/members/access";
import { STATUS_LABEL, type CodCollectMethod, type OnlineOrderStatus } from "@/modules/online-orders/core";
import {
  getOnlineOrderForStore,
  getOnlineOrderSettingsWithOrigin,
  isOnlineOrderingEnabled,
  listOnlineOrdersForStore,
  type OnlineOrder,
} from "@/modules/online-orders/repository";
import { createSupabaseServiceClient } from "@/server/integrations/supabase/server";
import { computeDeliveryRoute, googleMapsNavUrl, type DeliveryRoute } from "@/modules/online-orders/route-google";
import { performOnlineOrderTransition, type TransitionActor } from "@/modules/online-orders/transition-service";
import { logSystemEvent } from "@/modules/system/event-log";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type ActionResult = { ok: boolean; error: string | null };

/** g จาก getResolvedCurrentPermissions มีรูปตรง TransitionActor (resolved.can รับ PermissionKey) */
function actor(g: { user: { id: string }; ctx: { organizationId: string; storeId: string }; resolved: unknown }): TransitionActor {
  return g as unknown as TransitionActor;
}

async function riderGuard() {
  const { user, ctx, resolved } = await getResolvedCurrentPermissions();
  if (!resolved.can("pos.use")) return { error: "ต้องมีสิทธิ์ใช้ POS" as const };
  const billing = (await getOrganizationBillingState(ctx.organizationId)) ?? DEFAULT_BILLING_STATE;
  if (!canUseMemberPrivileges(billing) || !getPlanFeatures(billing).byoPaymentGateway) {
    return { error: "หน้าคนส่งใช้ได้เฉพาะแพ็กเกจ Enterprise" as const };
  }
  return { user, ctx, resolved, error: null };
}

export interface RiderJobVM {
  id: string;
  orderCode: string;
  status: OnlineOrderStatus;
  statusLabel: string;
  customerName: string;
  customerPhone: string;
  address: string | null;
  addressNote: string | null;
  note: string | null;
  dest: { lat: number; lng: number } | null;
  navUrl: string | null;
  items: string[];
  total: number;
  paymentMethod: "beam" | "cod";
  /** เงินสดเก็บปลายทางที่ฉันถือไว้ (ยังไม่คืนร้าน) */
  cashHeld: number | null;
  riderPayAmount: number | null;
  mine: boolean;
}

function toJob(o: OnlineOrder, me: string): RiderJobVM {
  const dest = o.lat !== null && o.lng !== null ? { lat: o.lat, lng: o.lng } : null;
  return {
    id: o.id,
    orderCode: o.orderCode,
    status: o.status,
    statusLabel: STATUS_LABEL[o.status],
    customerName: o.customerName,
    customerPhone: o.customerPhone,
    address: o.address,
    addressNote: o.addressNote,
    note: o.note,
    dest,
    navUrl: dest ? googleMapsNavUrl(dest) : null,
    items: o.items.map((l) => `${l.quantity}× ${l.productName}`),
    total: o.total,
    paymentMethod: o.paymentMethod,
    cashHeld: o.paymentMethod === "cod" && o.codCollectedMethod === "cash" && !o.codSettledAt ? (o.codCashHeld ?? o.total) : null,
    riderPayAmount: o.riderPayAmount,
    mine: o.riderUserId === me,
  };
}

/** งานรอส่ง (ร้านรับแล้ว ยังไม่มีคนส่ง) + งานของฉัน (กำลังไปส่ง / ถือเงินสดค้าง) */
export async function listRiderJobsAction(): Promise<{
  available: RiderJobVM[];
  mine: RiderJobVM[];
  shop: { lat: number; lng: number } | null;
  error: string | null;
}> {
  const g = await riderGuard();
  if (g.error !== null) return { available: [], mine: [], shop: null, error: g.error };
  const [orders, { settings }] = await Promise.all([listOnlineOrdersForStore(g.ctx.storeId), getOnlineOrderSettingsWithOrigin(g.ctx.storeId)]);
  const me = g.user.id;
  const delivery = orders.filter((o) => o.fulfillment === "delivery");
  const available = delivery.filter((o) => (o.status === "accepted" || o.status === "preparing") && !o.riderUserId).map((o) => toJob(o, me));
  const mine = delivery
    .filter((o) => o.riderUserId === me)
    .map((o) => toJob(o, me))
    .filter((j) => j.status === "out_for_delivery" || j.cashHeld);
  const shop = settings.originLat !== null && settings.originLng !== null ? { lat: settings.originLat, lng: settings.originLng } : null;
  return { available, mine, shop, error: null };
}

async function loadMine(g: { ctx: { storeId: string }; user: { id: string } }, id: string) {
  if (!UUID_RE.test(id)) return { order: null, error: "ไม่พบงาน" };
  const order = await getOnlineOrderForStore(g.ctx.storeId, id);
  if (!order || order.fulfillment !== "delivery") return { order: null, error: "ไม่พบงาน" };
  return { order, error: null };
}

/** รับงานเอง = ฉันเป็นคนส่ง + ออกไปส่ง (ล็อกรายได้คนส่ง ณ ตอนนี้) — กดพร้อมกันได้คนเดียว (เงื่อนไขสถานะ) */
export async function claimRiderJobAction(id: string): Promise<ActionResult> {
  try {
    const g = await riderGuard();
    if (g.error !== null) return { ok: false, error: g.error };
    const { order, error } = await loadMine(g, id);
    if (!order) return { ok: false, error };
    if (order.riderUserId && order.riderUserId !== g.user.id) return { ok: false, error: "มีคนรับงานนี้ไปแล้ว" };
    if (order.status !== "accepted" && order.status !== "preparing") return { ok: false, error: `งานอยู่ในสถานะ "${STATUS_LABEL[order.status]}" แล้ว` };
    // ร้านปิดสั่งออนไลน์แล้ว = ไม่รับงานใหม่ (งานที่กำลังส่งยังส่งสำเร็จ/ไม่สำเร็จได้)
    if (!(await isOnlineOrderingEnabled(g.ctx.storeId))) return { ok: false, error: "ร้านปิดสั่งออนไลน์อยู่ — รับงานใหม่ไม่ได้" };
    return await performOnlineOrderTransition(actor(g), id, "out_for_delivery", { riderUserId: g.user.id, via: "rider" });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "รับงานไม่สำเร็จ" };
  }
}

/** ส่งสำเร็จ (เก็บปลายทางต้องระบุเงินสด/โอน) — เฉพาะงานของฉัน */
export async function completeRiderJobAction(id: string, codMethod?: CodCollectMethod): Promise<ActionResult> {
  try {
    const g = await riderGuard();
    if (g.error !== null) return { ok: false, error: g.error };
    const { order, error } = await loadMine(g, id);
    if (!order) return { ok: false, error };
    if (order.riderUserId !== g.user.id) return { ok: false, error: "งานนี้ไม่ใช่ของคุณ" };
    if (order.status !== "out_for_delivery") return { ok: false, error: `งานอยู่ในสถานะ "${STATUS_LABEL[order.status]}" แล้ว` };
    return await performOnlineOrderTransition(actor(g), id, "completed", { codMethod, via: "rider" });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "บันทึกไม่สำเร็จ" };
  }
}

/** ส่งไม่สำเร็จ (เก็บปลายทางเท่านั้น) — เฉพาะงานของฉัน */
export async function failRiderJobAction(id: string, reason: string): Promise<ActionResult> {
  try {
    const g = await riderGuard();
    if (g.error !== null) return { ok: false, error: g.error };
    const { order, error } = await loadMine(g, id);
    if (!order) return { ok: false, error };
    if (order.riderUserId !== g.user.id) return { ok: false, error: "งานนี้ไม่ใช่ของคุณ" };
    if (order.status !== "out_for_delivery") return { ok: false, error: `งานอยู่ในสถานะ "${STATUS_LABEL[order.status]}" แล้ว` };
    if (order.paymentMethod !== "cod") return { ok: false, error: "ออเดอร์จ่ายแล้ว — แจ้งร้านให้จัดการ" };
    return await performOnlineOrderTransition(actor(g), id, "delivery_failed", { reason, via: "rider" });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "บันทึกไม่สำเร็จ" };
  }
}

/**
 * จำกัดการขอเส้นทางต่อออเดอร์ (คุมค่า Google): นับจาก log riderRoute ในฐานข้อมูล (ข้าม serverless instance)
 * ไม่ใช่ Map ในหน่วยความจำ — ทุก cold start จะได้โควตาใหม่
 */
const ROUTE_LIMIT_PER_HOUR = 20;

async function countRecentRouteCalls(storeId: string, onlineOrderId: string): Promise<number> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- system_event_logs อ่านด้วย service client
  const db: any = await createSupabaseServiceClient();
  const since = new Date(Date.now() - 3_600_000).toISOString();
  const { count } = await db
    .from("system_event_logs")
    .select("id", { count: "exact", head: true })
    .eq("store_id", storeId)
    .eq("action", "riderRoute")
    .gte("occurred_at", since)
    .contains("context", { onlineOrderId });
  return count ?? 0;
}

export async function getRiderRouteAction(
  id: string,
  origin: { lat: number; lng: number } | null,
): Promise<{ route: DeliveryRoute | null; error: string | null }> {
  const g = await riderGuard();
  if (g.error !== null) return { route: null, error: g.error };
  const { order, error } = await loadMine(g, id);
  if (!order) return { route: null, error };
  if (order.riderUserId !== g.user.id) return { route: null, error: "งานนี้ไม่ใช่ของคุณ" };
  if (order.lat === null || order.lng === null) return { route: null, error: "ออเดอร์นี้ไม่มีหมุดจุดส่ง — ใช้ที่อยู่/โทรหาลูกค้า" };
  if ((await countRecentRouteCalls(g.ctx.storeId, id)) >= ROUTE_LIMIT_PER_HOUR) {
    return { route: null, error: "ขอเส้นทางบ่อยเกินไป — ใช้ปุ่มเปิด Google Maps" };
  }
  const validOrigin =
    origin && Number.isFinite(origin.lat) && Number.isFinite(origin.lng) && Math.abs(origin.lat) <= 90 && Math.abs(origin.lng) <= 180 ? origin : null;
  let from = validOrigin;
  if (!from) {
    const { settings } = await getOnlineOrderSettingsWithOrigin(g.ctx.storeId);
    if (settings.originLat !== null && settings.originLng !== null) from = { lat: settings.originLat, lng: settings.originLng };
  }
  if (!from) return { route: null, error: "ไม่รู้ตำแหน่งเริ่มต้น — เปิด GPS" };
  const result = await computeDeliveryRoute(from, { lat: order.lat, lng: order.lng });
  await logSystemEvent({
    level: result.route ? "info" : "warn",
    source: "online-orders",
    action: "riderRoute",
    message: result.route
      ? `ขอเส้นทาง Google ${order.orderCode} (${Math.round(result.route.distanceM)} ม.)`
      : `ขอเส้นทาง Google ไม่สำเร็จ ${order.orderCode}: ${result.error}`,
    organizationId: g.ctx.organizationId,
    storeId: g.ctx.storeId,
    actorUserId: g.user.id,
    context: { onlineOrderId: id, fromGps: Boolean(validOrigin) },
  });
  return result;
}
