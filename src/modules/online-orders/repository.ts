import { createSupabaseServiceClient } from "@/server/integrations/supabase/server";
import { parseOrderingHours, type OrderingHours, type OrderingSchedule } from "./hours";
import {
  DEFAULT_ONLINE_ORDER_SETTINGS,
  PAYMENT_GRACE_MS,
  onlineOrderSettingsSchema,
  type Fulfillment,
  type OnlineOrderSettings,
  type OnlineOrderStatus,
  type PricedLine,
} from "./core";

/** ตารางสั่งออนไลน์ใช้ service client เท่านั้น — ผู้เรียกต้องตรวจสิทธิ์/ร้านก่อนเสมอ */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- ตารางใหม่ยังไม่อยู่ใน database.types
type LooseClient = any;

export interface OnlineOrder {
  id: string;
  organizationId: string;
  storeId: string;
  publicToken: string;
  clientRequestId: string;
  orderCode: string;
  fulfillment: Fulfillment;
  status: OnlineOrderStatus;
  customerName: string;
  customerPhone: string;
  address: string | null;
  addressNote: string | null;
  lat: number | null;
  lng: number | null;
  distanceKm: number | null;
  pickupAt: string | null;
  note: string | null;
  items: PricedLine[];
  subtotal: number;
  deliveryFee: number;
  total: number;
  gatewayPaymentId: string | null;
  orderId: string | null;
  cancelReason: string | null;
  expiresAt: string;
  paidAt: string | null;
  acceptedAt: string | null;
  completedAt: string | null;
  notifiedAt: string | null;
  createdAt: string;
  riderUserId: string | null;
  riderName: string | null;
  riderPayAmount: number | null;
  /** R3 */
  paymentMethod: "beam" | "cod";
  codCollectedMethod: "cash" | "bank_transfer" | "beam" | null;
  codCashHeld: number | null;
  codSettledAt: string | null;
  failureReason: string | null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- แถวดิบจาก service client
function toOrder(row: any): OnlineOrder {
  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  return {
    id: row.id,
    organizationId: row.organization_id,
    storeId: row.store_id,
    publicToken: row.public_token,
    clientRequestId: row.client_request_id,
    orderCode: row.order_code,
    fulfillment: row.fulfillment,
    status: row.status,
    customerName: row.customer_name,
    customerPhone: row.customer_phone,
    address: row.address ?? null,
    addressNote: row.address_note ?? null,
    lat: num(row.lat),
    lng: num(row.lng),
    distanceKm: num(row.distance_km),
    pickupAt: row.pickup_at ?? null,
    note: row.note ?? null,
    items: Array.isArray(row.items) ? (row.items as PricedLine[]) : [],
    subtotal: Number(row.subtotal),
    deliveryFee: Number(row.delivery_fee),
    total: Number(row.total),
    gatewayPaymentId: row.gateway_payment_id ?? null,
    orderId: row.order_id ?? null,
    cancelReason: row.cancel_reason ?? null,
    expiresAt: row.expires_at,
    paidAt: row.paid_at ?? null,
    acceptedAt: row.accepted_at ?? null,
    completedAt: row.completed_at ?? null,
    notifiedAt: row.notified_at ?? null,
    createdAt: row.created_at,
    riderUserId: row.rider_user_id ?? null,
    riderName: row.rider_name ?? null,
    riderPayAmount: num(row.rider_pay_amount),
    paymentMethod: row.payment_method === "cod" ? "cod" : "beam",
    codCollectedMethod: row.cod_collected_method ?? null,
    codCashHeld: num(row.cod_cash_held),
    codSettledAt: row.cod_settled_at ?? null,
    failureReason: row.failure_reason ?? null,
  };
}

/** cod_tier_caps (jsonb) → { "<rank>": ยอด } — ค่าที่อ่านไม่ออกตัดทิ้ง */
function parseTierCaps(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, number> = {};
  for (const [rank, cap] of Object.entries(value as Record<string, unknown>)) {
    const n = Number(cap);
    if (/^[0-9]{1,2}$/.test(rank) && Number.isFinite(n) && n >= 0 && n <= 100000) out[rank] = n;
  }
  return out;
}

// ---------- ตั้งค่า ----------

/** พิกัดร้านจากตั้งค่าลงเวลาเข้างาน (จุดศูนย์กลาง geofence) — ใช้เป็นพิกัดร้านของการส่งเสมอถ้ามี */
export async function getAttendanceOrigin(storeId: string): Promise<{ lat: number; lng: number } | null> {
  const db: LooseClient = await createSupabaseServiceClient();
  const { data } = await db
    .from("attendance_settings")
    .select("geofence_center_lat, geofence_center_lng")
    .eq("store_id", storeId)
    .not("geofence_center_lat", "is", null)
    .not("geofence_center_lng", "is", null)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data) return null;
  const lat = Number(data.geofence_center_lat);
  const lng = Number(data.geofence_center_lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

/**
 * ตั้งค่าสั่งออนไลน์ที่ใช้งานจริง — พิกัดร้าน = พิกัดลงเวลาเข้างาน (ถ้าตั้งไว้) แทนค่าที่บันทึกเอง
 * ร้านย้าย/แก้จุดลงเวลา ค่าส่งก็คิดจากจุดใหม่ทันที ไม่ต้องตั้งสองที่
 */
export async function getOnlineOrderSettings(storeId: string): Promise<OnlineOrderSettings> {
  return (await getOnlineOrderSettingsWithOrigin(storeId)).settings;
}

/** เหมือน getOnlineOrderSettings แต่บอกด้วยว่าพิกัดมาจากจุดลงเวลาเข้างานไหม (หน้าตั้งค่า) */
export async function getOnlineOrderSettingsWithOrigin(
  storeId: string,
): Promise<{ settings: OnlineOrderSettings; originFromAttendance: boolean }> {
  const [settings, origin] = await Promise.all([getStoredOnlineOrderSettings(storeId), getAttendanceOrigin(storeId)]);
  return origin
    ? { settings: { ...settings, originLat: origin.lat, originLng: origin.lng }, originFromAttendance: true }
    : { settings, originFromAttendance: false };
}

/** เมนูหลังร้าน: อ่านแค่สวิตช์ (query เดียว) */
export async function isOnlineOrderingEnabled(storeId: string): Promise<boolean> {
  return (await getStoredOnlineOrderSettings(storeId)).enabled;
}

async function getStoredOnlineOrderSettings(storeId: string): Promise<OnlineOrderSettings> {
  const db: LooseClient = await createSupabaseServiceClient();
  const { data } = await db.from("store_online_order_settings").select("*").eq("store_id", storeId).maybeSingle();
  if (!data) return DEFAULT_ONLINE_ORDER_SETTINGS;
  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  const parsed = onlineOrderSettingsSchema.safeParse({
    enabled: Boolean(data.enabled),
    pickupEnabled: Boolean(data.pickup_enabled),
    deliveryEnabled: Boolean(data.delivery_enabled),
    originLat: num(data.origin_lat),
    originLng: num(data.origin_lng),
    deliveryRadiusKm: Number(data.delivery_radius_km),
    deliveryBaseFee: Number(data.delivery_base_fee),
    deliveryFeePerKm: Number(data.delivery_fee_per_km),
    deliveryFreeOver: num(data.delivery_free_over),
    // คอลัมน์ใหม่ (20261212120000) — ยังไม่มี = 0 ไม่ทำให้ตั้งค่าทั้งแถวเสีย
    deliveryFreeKm: Number(data.delivery_free_km ?? 0) || 0,
    // คอลัมน์ R2 (20261213120000) — ยังไม่มี = ปิด
    riderPayEnabled: Boolean(data.rider_pay_enabled ?? false),
    riderPayRate: data.rider_pay_rate === undefined || data.rider_pay_rate === null ? 10 : Number(data.rider_pay_rate),
    riderPayIncludeFee: data.rider_pay_include_fee === undefined || data.rider_pay_include_fee === null ? true : Boolean(data.rider_pay_include_fee),
    // คอลัมน์ R3 (20261214120000) — ยังไม่มี = ปิด COD (ห้ามทำให้ทั้งแถวเสีย ไม่งั้นร้านปิดสั่งออนไลน์ทั้งหมด)
    codEnabled: Boolean(data.cod_enabled ?? false),
    codMaxPerBill: data.cod_max_per_bill === undefined || data.cod_max_per_bill === null ? 500 : Number(data.cod_max_per_bill),
    codTierCaps: parseTierCaps(data.cod_tier_caps),
    codRequireOtp: data.cod_require_otp === undefined || data.cod_require_otp === null ? true : Boolean(data.cod_require_otp),
    minOrder: Number(data.min_order),
    prepMinutes: Number(data.prep_minutes),
  });
  // แถวเสีย = ปิดไว้ก่อน (ไม่เปิดรับเงินด้วยค่าที่อ่านไม่ออก)
  return parsed.success ? parsed.data : { ...DEFAULT_ONLINE_ORDER_SETTINGS, enabled: false };
}

export async function saveOnlineOrderSettings(input: {
  storeId: string;
  organizationId: string;
  settings: OnlineOrderSettings;
  userId: string;
}): Promise<string | null> {
  const db: LooseClient = await createSupabaseServiceClient();
  const s = input.settings;
  const { error } = await db.from("store_online_order_settings").upsert(
    {
      store_id: input.storeId,
      organization_id: input.organizationId,
      enabled: s.enabled,
      pickup_enabled: s.pickupEnabled,
      delivery_enabled: s.deliveryEnabled,
      origin_lat: s.originLat,
      origin_lng: s.originLng,
      delivery_radius_km: s.deliveryRadiusKm,
      delivery_base_fee: s.deliveryBaseFee,
      delivery_fee_per_km: s.deliveryFeePerKm,
      delivery_free_over: s.deliveryFreeOver,
      delivery_free_km: s.deliveryFreeKm,
      rider_pay_enabled: s.riderPayEnabled,
      rider_pay_rate: s.riderPayRate,
      rider_pay_include_fee: s.riderPayIncludeFee,
      cod_enabled: s.codEnabled,
      cod_max_per_bill: s.codMaxPerBill,
      cod_tier_caps: s.codTierCaps,
      cod_require_otp: s.codRequireOtp,
      min_order: s.minOrder,
      prep_minutes: s.prepMinutes,
      updated_by: input.userId,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "store_id" },
  );
  return error ? error.message : null;
}

// ---------- เวลารับออเดอร์ + ปิดด่วน ----------

/** อ่านเวลารับออเดอร์/ปิดด่วน — select("*") เพื่อให้ยังทำงานก่อน migration 20261218120000 ขึ้น (ไม่มีคอลัมน์ = เปิดตลอด) */
export async function getOrderingSchedule(storeId: string): Promise<OrderingSchedule> {
  const db: LooseClient = await createSupabaseServiceClient();
  const { data } = await db.from("store_online_order_settings").select("*").eq("store_id", storeId).maybeSingle();
  return {
    hours: parseOrderingHours(data?.ordering_hours ?? null),
    pausedUntil: typeof data?.paused_until === "string" ? data.paused_until : null,
    pausedReason: typeof data?.paused_reason === "string" ? data.paused_reason : null,
  };
}

export async function saveOrderingHours(input: { storeId: string; organizationId: string; hours: OrderingHours; userId: string }): Promise<string | null> {
  const db: LooseClient = await createSupabaseServiceClient();
  const { error } = await db.from("store_online_order_settings").upsert(
    {
      store_id: input.storeId,
      organization_id: input.organizationId,
      ordering_hours: input.hours,
      updated_by: input.userId,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "store_id" },
  );
  return error ? error.message : null;
}

/** ปิดด่วน (until = ISO) หรือเปิดกลับ (until = null) */
export async function setOrderingPause(input: {
  storeId: string;
  organizationId: string;
  until: string | null;
  reason: string | null;
  userId: string;
}): Promise<string | null> {
  const db: LooseClient = await createSupabaseServiceClient();
  const { error } = await db.from("store_online_order_settings").upsert(
    {
      store_id: input.storeId,
      organization_id: input.organizationId,
      paused_until: input.until,
      paused_reason: input.until ? input.reason : null,
      paused_by: input.until ? input.userId : null,
      updated_by: input.userId,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "store_id" },
  );
  return error ? error.message : null;
}

// ---------- คำสั่งซื้อ ----------

export async function findOnlineOrderByRequest(storeId: string, clientRequestId: string): Promise<OnlineOrder | null> {
  const db: LooseClient = await createSupabaseServiceClient();
  const { data } = await db
    .from("online_orders")
    .select("*")
    .eq("store_id", storeId)
    .eq("client_request_id", clientRequestId)
    .maybeSingle();
  return data ? toOrder(data) : null;
}

export async function insertOnlineOrder(row: Record<string, unknown>): Promise<{ order: OnlineOrder | null; error: string | null }> {
  const db: LooseClient = await createSupabaseServiceClient();
  const { data, error } = await db.from("online_orders").insert(row).select("*").single();
  if (error || !data) return { order: null, error: error?.message ?? "insert failed" };
  return { order: toOrder(data), error: null };
}

export async function setOnlineOrderGateway(orderId: string, gatewayPaymentId: string): Promise<void> {
  const db: LooseClient = await createSupabaseServiceClient();
  await db
    .from("online_orders")
    .update({ gateway_payment_id: gatewayPaymentId, updated_at: new Date().toISOString() })
    .eq("id", orderId)
    .is("gateway_payment_id", null);
}

export async function getOnlineOrderByToken(token: string): Promise<OnlineOrder | null> {
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(token)) return null;
  const db: LooseClient = await createSupabaseServiceClient();
  const { data } = await db.from("online_orders").select("*").eq("public_token", token).maybeSingle();
  return data ? toOrder(data) : null;
}

export async function getOnlineOrderForStore(storeId: string, id: string): Promise<OnlineOrder | null> {
  const db: LooseClient = await createSupabaseServiceClient();
  const { data } = await db.from("online_orders").select("*").eq("store_id", storeId).eq("id", id).maybeSingle();
  return data ? toOrder(data) : null;
}

export async function listOnlineOrdersForStore(storeId: string, limit = 60): Promise<OnlineOrder[]> {
  const db: LooseClient = await createSupabaseServiceClient();
  const { data } = await db
    .from("online_orders")
    .select("*")
    .eq("store_id", storeId)
    .neq("status", "awaiting_payment")
    .neq("status", "expired")
    .order("created_at", { ascending: false })
    .limit(limit);
  return ((data ?? []) as unknown[]).map(toOrder);
}

/** เปลี่ยนสถานะแบบมีเงื่อนไข (สถานะเดิมต้องตรง) — กันกดซ้ำ/สองเครื่องแย่งกัน */
export async function transitionOnlineOrder(input: {
  storeId: string;
  id: string;
  from: OnlineOrderStatus;
  to: OnlineOrderStatus;
  userId: string | null;
  patch?: Record<string, unknown>;
}): Promise<boolean> {
  const db: LooseClient = await createSupabaseServiceClient();
  const now = new Date().toISOString();
  const { data } = await db
    .from("online_orders")
    .update({ ...(input.patch ?? {}), status: input.to, updated_by: input.userId, updated_at: now })
    .eq("store_id", input.storeId)
    .eq("id", input.id)
    .eq("status", input.from)
    .select("id")
    .maybeSingle();
  return Boolean(data);
}

export async function getOnlineOrderById(id: string): Promise<OnlineOrder | null> {
  const db: LooseClient = await createSupabaseServiceClient();
  const { data } = await db.from("online_orders").select("*").eq("id", id).maybeSingle();
  return data ? toOrder(data) : null;
}

/** ตั้ง notified_at ครั้งเดียว — คืน true เฉพาะผู้ที่ตั้งได้ (ส่งแจ้งเตือนครั้งเดียว) */
export async function claimOnlineOrderNotification(id: string): Promise<boolean> {
  const db: LooseClient = await createSupabaseServiceClient();
  const { data } = await db
    .from("online_orders")
    .update({ notified_at: new Date().toISOString() })
    .eq("id", id)
    .is("notified_at", null)
    .neq("status", "awaiting_payment")
    .neq("status", "expired")
    .select("id")
    .maybeSingle();
  return Boolean(data);
}

/** รายการรอจ่ายที่เลยเวลาชำระ + เผื่อ webhook → expired (เงินเข้าทีหลัง trigger ทำ LATE_PAID) */
export async function expireStaleOnlineOrders(storeId: string): Promise<void> {
  const db: LooseClient = await createSupabaseServiceClient();
  const cutoff = new Date(Date.now() - PAYMENT_GRACE_MS).toISOString();
  await db
    .from("online_orders")
    .update({ status: "expired", updated_at: new Date().toISOString() })
    .eq("store_id", storeId)
    .eq("status", "awaiting_payment")
    .lt("expires_at", cutoff);
}

/** กันสแปม: จำนวนรายการรอจ่ายต่อเบอร์ (15 นาที) และทั้งร้าน */
export async function countPendingOnlineOrders(storeId: string, phone: string): Promise<{ byPhone: number; byStore: number }> {
  const db: LooseClient = await createSupabaseServiceClient();
  const since = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const [phoneRes, storeRes] = await Promise.all([
    db
      .from("online_orders")
      .select("id", { count: "exact", head: true })
      .eq("store_id", storeId)
      .eq("customer_phone", phone)
      .eq("status", "awaiting_payment")
      .gte("created_at", since),
    db
      .from("online_orders")
      .select("id", { count: "exact", head: true })
      .eq("store_id", storeId)
      .eq("status", "awaiting_payment")
      .gte("created_at", since),
  ]);
  return { byPhone: phoneRes.count ?? 0, byStore: storeRes.count ?? 0 };
}

// ---------- คนส่ง + รายได้คนส่ง (R2) ----------

export interface RiderCandidate {
  userId: string;
  name: string;
  /** ลงเวลาเข้างานอยู่ตอนนี้ */
  onShift: boolean;
}

/**
 * คนที่เลือกเป็นคนส่งได้: มีโปรไฟล์พนักงานในสาขานี้ + ยังไม่ลาออก · คนที่ลงเวลาอยู่ขึ้นก่อน
 * (ต้องมีโปรไฟล์พนักงาน เพราะรายได้คนส่งเข้าเงินเดือนผ่านโปรไฟล์นี้)
 */
export async function listRiderCandidates(storeId: string): Promise<RiderCandidate[]> {
  const db: LooseClient = await createSupabaseServiceClient();
  const { listResignedUserIds } = await import("@/modules/hr/employment-status");
  const [profRes, activeRes, resigned] = await Promise.all([
    db.from("employee_profiles").select("user_id, display_name").eq("store_id", storeId),
    db.from("attendance_records").select("user_id").eq("store_id", storeId).eq("status", "active"),
    listResignedUserIds(storeId).catch(() => new Set<string>()),
  ]);
  const onShift = new Set(((activeRes.data ?? []) as { user_id: string }[]).map((r) => r.user_id));
  const profiles = ((profRes.data ?? []) as { user_id: string; display_name: string | null }[]).filter((p) => !resigned.has(p.user_id));
  // โปรไฟล์ไม่ได้ตั้งชื่อ → ใช้ชื่อบัญชี/อีเมล (ไม่งั้นแคชเชียร์เห็นแค่ "พนักงาน" แยกไม่ออกว่าใคร)
  const missing = profiles.filter((p) => !(p.display_name ?? "").trim()).map((p) => p.user_id);
  const accountName = new Map<string, string>();
  await Promise.all(
    missing.map(async (userId) => {
      const { data } = await db.auth.admin.getUserById(userId).catch(() => ({ data: null }));
      const user = data?.user;
      const meta = (user?.user_metadata ?? {}) as Record<string, unknown>;
      const name = [meta.full_name, meta.name, meta.display_name].find((v) => typeof v === "string" && v.trim()) as string | undefined;
      const fromEmail = typeof user?.email === "string" ? user.email.split("@")[0] : "";
      if (name || fromEmail) accountName.set(userId, (name ?? fromEmail).trim());
    }),
  );
  return profiles
    .map((p) => ({
      userId: p.user_id,
      name: (p.display_name ?? "").trim() || accountName.get(p.user_id) || "พนักงาน",
      onShift: onShift.has(p.user_id),
    }))
    .sort((a, b) => Number(b.onShift) - Number(a.onShift) || a.name.localeCompare(b.name, "th"));
}

/**
 * บันทึกรายได้คนส่งเข้าเงินเดือน (payroll_adjustments ชนิด delivery_pay) — 1 ออเดอร์ 1 แถว (unique online_order_id)
 * วันที่ = วันที่กด "สำเร็จ" ตามเวลาร้าน (ตกงวดของวันนั้น)
 * คืน "created" | "exists" | ข้อความ error
 */
export async function recordRiderPayAdjustment(input: {
  organizationId: string;
  storeId: string;
  onlineOrderId: string;
  orderCode: string;
  riderUserId: string;
  riderName: string;
  amount: number;
  createdByUserId: string;
}): Promise<"created" | "exists" | string> {
  const db: LooseClient = await createSupabaseServiceClient();
  const { data: store } = await db.from("stores").select("timezone").eq("id", input.storeId).maybeSingle();
  const { storeLocalDate } = await import("@/modules/hr/employment-status");
  const { error } = await db.from("payroll_adjustments").insert({
    organization_id: input.organizationId,
    store_id: input.storeId,
    user_id: input.riderUserId,
    employee_name: input.riderName.slice(0, 120),
    date: storeLocalDate(new Date(), store?.timezone ?? null),
    type: "delivery_pay",
    amount: input.amount,
    note: `ส่งออนไลน์ ${input.orderCode}`.slice(0, 200),
    created_by_user_id: input.createdByUserId,
    online_order_id: input.onlineOrderId,
  });
  if (!error) return "created";
  if (error.code === "23505") return "exists";
  return error.message ?? "บันทึกรายได้คนส่งไม่สำเร็จ";
}

// ---------- เก็บเงินปลายทาง (R3) ----------

/** ระดับสมาชิกของเบอร์นี้ในร้าน (null = ไม่ใช่สมาชิก/ร้านไม่ได้เปิดระดับ) */
export async function findMemberTierRankByPhone(storeId: string, phone: string): Promise<number | null> {
  const db: LooseClient = await createSupabaseServiceClient();
  const { data } = await db
    .from("customers")
    .select("id")
    .eq("store_id", storeId)
    .eq("phone", phone)
    .not("member_identity_id", "is", null)
    .limit(1);
  const customerId = (data as { id: string }[] | null)?.[0]?.id;
  if (!customerId) return null;
  const { getMemberTierForCustomer } = await import("@/modules/member-tiers/repository");
  const tier = await getMemberTierForCustomer(storeId, customerId).catch(() => null);
  return tier ? tier.rank : null;
}

/** เก็บปลายทางแล้วส่งไม่สำเร็จกี่ครั้งในช่วงหลัง (ใช้ปิด COD ของเบอร์ที่ไม่รับของ) */
export async function countFailedCodOrders(storeId: string, phone: string, days: number): Promise<number> {
  const db: LooseClient = await createSupabaseServiceClient();
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const { count } = await db
    .from("online_orders")
    .select("id", { count: "exact", head: true })
    .eq("store_id", storeId)
    .eq("customer_phone", phone)
    .eq("payment_method", "cod")
    .eq("status", "delivery_failed")
    // failed_at = เวลาที่ส่งไม่สำเร็จจริง (updated_at เปลี่ยนได้จากเหตุอื่น ทำให้หน้าต่าง 90 วันเลื่อน)
    .gte("failed_at", since);
  return count ?? 0;
}

export interface CodOtpRow {
  id: string;
  codeHash: string | null;
  channel: "campaigns" | "otp_v2";
  attempts: number;
  expiresAt: string;
  verifiedAt: string | null;
  consumedAt: string | null;
  createdAt: string;
}

export async function countCodOtpRequests(input: { storeId: string; phone: string; ipHash: string | null }): Promise<{
  lastAt: string | null;
  phoneToday: number;
  ip10min: number;
}> {
  const db: LooseClient = await createSupabaseServiceClient();
  const dayAgo = new Date(Date.now() - 86_400_000).toISOString();
  const tenMin = new Date(Date.now() - 10 * 60_000).toISOString();
  const [phoneRes, ipRes] = await Promise.all([
    db.from("online_order_otps").select("created_at").eq("store_id", input.storeId).eq("phone", input.phone).gte("created_at", dayAgo).order("created_at", { ascending: false }),
    input.ipHash
      ? db.from("online_order_otps").select("id", { count: "exact", head: true }).eq("ip_hash", input.ipHash).gte("created_at", tenMin)
      : Promise.resolve({ count: 0 }),
  ]);
  const rows = (phoneRes.data ?? []) as { created_at: string }[];
  return { lastAt: rows[0]?.created_at ?? null, phoneToday: rows.length, ip10min: (ipRes as { count: number | null }).count ?? 0 };
}

export async function insertCodOtp(row: {
  storeId: string;
  phone: string;
  codeHash: string | null;
  channel: "campaigns" | "otp_v2";
  ipHash: string | null;
  expiresAt: string;
}): Promise<boolean> {
  const db: LooseClient = await createSupabaseServiceClient();
  const { error } = await db.from("online_order_otps").insert({
    store_id: row.storeId,
    phone: row.phone,
    code_hash: row.codeHash,
    channel: row.channel,
    ip_hash: row.ipHash,
    expires_at: row.expiresAt,
  });
  return !error;
}

/** OTP ล่าสุดที่ยังไม่ใช้ของเบอร์นี้ */
export async function getLatestCodOtp(storeId: string, phone: string): Promise<CodOtpRow | null> {
  const db: LooseClient = await createSupabaseServiceClient();
  const { data } = await db
    .from("online_order_otps")
    .select("*")
    .eq("store_id", storeId)
    .eq("phone", phone)
    .is("consumed_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data) return null;
  return {
    id: data.id,
    codeHash: data.code_hash ?? null,
    channel: data.channel,
    attempts: Number(data.attempts ?? 0),
    expiresAt: data.expires_at,
    verifiedAt: data.verified_at ?? null,
    consumedAt: data.consumed_at ?? null,
    createdAt: data.created_at,
  };
}

export async function bumpCodOtpAttempts(id: string, attempts: number): Promise<void> {
  const db: LooseClient = await createSupabaseServiceClient();
  await db.from("online_order_otps").update({ attempts }).eq("id", id);
}

/** ใช้ OTP ครั้งเดียว — คืน true เฉพาะผู้ที่จองได้ (กันใช้ซ้ำจากสองแท็บ) */
export async function consumeCodOtp(id: string): Promise<boolean> {
  const db: LooseClient = await createSupabaseServiceClient();
  const now = new Date().toISOString();
  const { data } = await db
    .from("online_order_otps")
    .update({ verified_at: now, consumed_at: now })
    .eq("id", id)
    .is("consumed_at", null)
    .select("id")
    .maybeSingle();
  return Boolean(data);
}

/** ออเดอร์เก็บปลายทางที่ยังไม่จบของเบอร์นี้ (กันสั่งรัวโดยไม่ต้องจ่าย) */
export async function countActiveCodOrders(storeId: string, phone: string): Promise<number> {
  const db: LooseClient = await createSupabaseServiceClient();
  const { count } = await db
    .from("online_orders")
    .select("id", { count: "exact", head: true })
    .eq("store_id", storeId)
    .eq("customer_phone", phone)
    .eq("payment_method", "cod")
    .in("status", ["cod_pending", "accepted", "preparing", "out_for_delivery"]);
  return count ?? 0;
}

/** ออเดอร์ออนไลน์ที่รอร้านกดรับ (จ่ายแล้ว / เก็บปลายทาง) — query เบาสำหรับ POS ถามทุก 15 วิ */
export async function listAwaitingOnlineOrders(storeId: string): Promise<{ id: string; orderCode: string }[]> {
  const db: LooseClient = await createSupabaseServiceClient();
  const { data } = await db
    .from("online_orders")
    .select("id, order_code")
    .eq("store_id", storeId)
    .in("status", ["paid", "cod_pending"])
    .order("created_at", { ascending: true })
    .limit(20);
  return ((data ?? []) as { id: string; order_code: string }[]).map((r) => ({ id: r.id, orderCode: r.order_code }));
}
