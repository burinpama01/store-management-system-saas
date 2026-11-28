/**
 * ลงโฆษณาผ่าน QR — ฝั่ง server ที่ใช้ service role (หน้าสาธารณะไม่มี session / จอลูกค้า / cron)
 * ทุกฟังก์ชันกรองด้วย store_id ที่ตรวจแล้วเสมอ (service role ข้าม RLS)
 */
import { cache } from "react";
import { getOrganizationBillingState } from "@/modules/billing/billing-service";
import { DEFAULT_BILLING_STATE, getPlanFeatures } from "@/modules/billing/types";
import { isSlip2goConfigured } from "@/modules/billing/slip2go";
import { isBeamReadyForStore } from "@/modules/payments/beam-service";
import { getCustomerDisplaySettings } from "@/modules/settings/repository";
import { DEFAULT_CUSTOMER_DISPLAY_SETTINGS, type CustomerDisplaySettings } from "@/modules/settings/customer-display";
import { logSystemEvent } from "@/modules/system/event-log";
import { createSupabaseServiceClient } from "@/server/integrations/supabase/server";
import { canUseAdSelfServe, mapStoreAdOfferRow, type StoreAdOffer } from "./rules";
import {
  canDisplayCustomerAds,
  countStoreAdSlotsInUse,
  isStoreAdLive,
  mapStoreAdOrderRow,
  mergeStoreAdsIntoDisplay,
  nextStoreAdFreeAt,
  type StoreAdOrder,
} from "./orders";

// ตารางใหม่ยังไม่อยู่ใน database.types
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LooseClient = any;

export const STORE_AD_MEDIA_BUCKET = "product-images";

export interface AdStore {
  storeId: string;
  organizationId: string;
  storeName: string;
  slug: string;
  offer: StoreAdOffer;
  /** Beam ของร้านพร้อม (ยืนยันอัตโนมัติ) */
  beam: boolean;
  /** ไม่มี Beam → พร้อมเพย์ของร้าน + ตรวจสลิป */
  promptpayId: string | null;
  slip: boolean;
  slotsInUse: number;
  nextFreeAt: string | null;
}

export type AdStoreResult = { ok: true; store: AdStore } | { ok: false; reason: string };

export async function serviceDb(): Promise<LooseClient> {
  return createSupabaseServiceClient();
}

/** คำสั่งที่จองช่องอยู่ของร้าน (กำลังแสดง + รออนุมัติ) */
export async function listSlotOrders(storeId: string, db?: LooseClient): Promise<StoreAdOrder[]> {
  const client = db ?? (await serviceDb());
  const { data } = await client
    .from("store_ad_orders")
    .select("*")
    .eq("store_id", storeId)
    .in("status", ["active", "pending_review"])
    .limit(100);
  return ((data ?? []) as Record<string, unknown>[]).map(mapStoreAdOrderRow);
}

/**
 * ร้านรับลงโฆษณาได้เมื่อ: ร้านเปิดอยู่, แพ็กมี adSelfServe + จอลูกค้า, ร้านเปิดสวิตช์,
 * จอโฆษณาเปิดอยู่ และมีช่องทางรับเงิน (Beam หรือ พร้อมเพย์ + ตัวตรวจสลิป) — ตรวจใหม่ทุกครั้ง
 */
async function resolveAdStoreUncached(slug: string): Promise<AdStoreResult> {
  const clean = decodeURIComponent(slug).trim().toLowerCase();
  if (!/^[a-z0-9-]{1,100}$/.test(clean)) return { ok: false, reason: "ไม่พบร้าน" };
  const db = await serviceDb();
  const { data: store } = await db
    .from("stores")
    .select("id, organization_id, name, slug, is_active")
    .eq("slug", clean)
    .maybeSingle();
  if (!store) return { ok: false, reason: "ไม่พบร้าน" };
  if (!store.is_active) return { ok: false, reason: "ร้านปิดให้บริการชั่วคราว" };

  const billing = (await getOrganizationBillingState(store.organization_id)) ?? DEFAULT_BILLING_STATE;
  const features = getPlanFeatures(billing);
  if (!canUseAdSelfServe(features)) return { ok: false, reason: "ร้านนี้ยังไม่เปิดรับลงโฆษณา" };

  const [{ data: offerRow }, displayRes, { data: receipt }, slotOrders] = await Promise.all([
    db.from("store_ad_offers").select("*").eq("store_id", store.id).maybeSingle(),
    getCustomerDisplaySettings(store.id, store.organization_id, db),
    db.from("receipt_settings").select("promptpay_id").eq("store_id", store.id).maybeSingle(),
    listSlotOrders(store.id, db),
  ]);
  const offer = mapStoreAdOfferRow(offerRow);
  if (!offerRow || !offer.enabled) return { ok: false, reason: "ร้านนี้ยังไม่เปิดรับลงโฆษณา" };
  const display = displayRes.data ?? DEFAULT_CUSTOMER_DISPLAY_SETTINGS;
  if (!canDisplayCustomerAds(display)) return { ok: false, reason: "ร้านปิดจอโฆษณาอยู่ชั่วคราว" };

  const beam = features.byoPaymentGateway && (await isBeamReadyForStore(store.id, db));
  const promptpayId = typeof receipt?.promptpay_id === "string" && receipt.promptpay_id.trim() ? receipt.promptpay_id.trim() : null;
  const slip = !beam && Boolean(promptpayId) && isSlip2goConfigured();
  if (!beam && !slip) return { ok: false, reason: "ร้านยังไม่พร้อมรับชำระค่าโฆษณา" };

  const nowMs = Date.now();
  return {
    ok: true,
    store: {
      storeId: store.id,
      organizationId: store.organization_id,
      storeName: store.name,
      slug: clean,
      offer,
      beam,
      promptpayId: slip ? promptpayId : null,
      slip,
      slotsInUse: countStoreAdSlotsInUse(slotOrders, nowMs),
      nextFreeAt: nextStoreAdFreeAt(slotOrders, nowMs),
    },
  };
}

/** dedupe ภายใน request เดียว (generateMetadata + หน้า) */
export const resolveAdStore = cache(resolveAdStoreUncached);

export async function getAdOrderByToken(token: string): Promise<StoreAdOrder | null> {
  if (!/^[A-Za-z0-9_-]{32,64}$/.test(token)) return null;
  const db = await serviceDb();
  const { data } = await db.from("store_ad_orders").select("*").eq("public_token", token).maybeSingle();
  return data ? mapStoreAdOrderRow(data) : null;
}

export async function getAdOrderById(id: string): Promise<StoreAdOrder | null> {
  const db = await serviceDb();
  const { data } = await db.from("store_ad_orders").select("*").eq("id", id).maybeSingle();
  return data ? mapStoreAdOrderRow(data) : null;
}

/** ยกเลิกคำสั่งที่เลยเวลาจ่ายของร้าน (ทางสำรองของ cron — เรียกก่อนนับโควตา) */
export async function cancelStaleAdOrders(storeId: string, db?: LooseClient): Promise<void> {
  const client = db ?? (await serviceDb());
  await client
    .from("store_ad_orders")
    .update({ status: "cancelled", status_reason: "ไม่ชำระภายในเวลา", updated_at: new Date().toISOString() })
    .eq("store_id", storeId)
    .eq("status", "pending_payment")
    .lt("expires_at", new Date().toISOString());
}

/** แจ้งร้านครั้งเดียวต่อคำสั่ง (claim notified_at) */
export async function claimAdOrderNotification(id: string): Promise<boolean> {
  const db = await serviceDb();
  const { data } = await db
    .from("store_ad_orders")
    .update({ notified_at: new Date().toISOString() })
    .eq("id", id)
    .is("notified_at", null)
    .in("status", ["active", "pending_review"])
    .select("id");
  return Array.isArray(data) && data.length > 0;
}

/**
 * จอลูกค้า: ค่าโฆษณาร้าน + โฆษณาลูกค้าที่กำลังแสดง (สลับ 1:1)
 * โฆษณาลูกค้าดึงผิดพลาด → คืนโฆษณาร้านอย่างเดียว (จอต้องไม่ดับ)
 */
export async function withLiveStoreAds(
  settings: CustomerDisplaySettings | null,
  storeId: string,
  organizationId: string,
): Promise<CustomerDisplaySettings | null> {
  try {
    const base = settings ?? DEFAULT_CUSTOMER_DISPLAY_SETTINGS;
    if (!canDisplayCustomerAds(base)) return settings;
    const db = await serviceDb();
    const nowIso = new Date().toISOString();
    const { data, error } = await db
      .from("store_ad_orders")
      .select("id, organization_id, store_id, status, media_type, media_url, slot, starts_at, ends_at, package_id, package_name, days, amount, advertiser_name, advertiser_phone, created_at")
      .eq("store_id", storeId)
      .eq("organization_id", organizationId)
      .eq("status", "active")
      .gt("ends_at", nowIso)
      .order("starts_at", { ascending: true })
      .limit(12);
    if (error) throw new Error(error.message);
    const nowMs = Date.now();
    const live = ((data ?? []) as Record<string, unknown>[]).map(mapStoreAdOrderRow).filter((o) => isStoreAdLive(o, nowMs));
    if (live.length === 0) return settings;
    return mergeStoreAdsIntoDisplay(base, live);
  } catch (e) {
    void logSystemEvent({
      level: "warn",
      source: "ad-self-serve",
      action: "withLiveStoreAds",
      message: `ดึงโฆษณาลูกค้าสำหรับจอไม่สำเร็จ: ${e instanceof Error ? e.message : String(e)}`,
      storeId,
      organizationId,
    });
    return settings;
  }
}
