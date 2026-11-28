import { cache } from "react";
import { createSupabaseServiceClient } from "@/server/integrations/supabase/server";
import { getOrganizationBillingState } from "@/modules/billing/billing-service";
import { DEFAULT_BILLING_STATE, getPlanFeatures } from "@/modules/billing/types";
import { canUseMemberPrivileges } from "@/modules/members/access";
import { isBeamReadyForStore } from "@/modules/payments/beam-service";
import type { OnlineOrderSettings } from "./core";
import { evaluateOrderingAvailability, type OrderingAvailability } from "./hours";
import { getOnlineOrderSettings, getOrderingSchedule } from "./repository";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- store_websites ยังไม่อยู่ใน database.types
type LooseClient = any;

export interface OrderingStore {
  storeId: string;
  organizationId: string;
  storeName: string;
  slug: string;
  phone: string | null;
  address: string | null;
  settings: OnlineOrderSettings;
  timeZone: string;
  /** เวลารับออเดอร์/ปิดด่วน ณ ตอนโหลด — ปิดอยู่ยังดูเมนูได้ แต่สั่ง/จ่ายไม่ได้ (ตรวจซ้ำตอนกดสั่ง) */
  availability: OrderingAvailability;
}

export type OrderingStoreResult = { ok: true; store: OrderingStore } | { ok: false; reason: string };

/**
 * ร้านรับสั่งออนไลน์ได้เมื่อ: เว็บเปิด+เผยแพร่แล้ว, ร้านเปิดอยู่, ยัง Enterprise (มี Payment Gateway),
 * ร้านเปิดสวิตช์สั่งออนไลน์ และ Beam พร้อม — ตรวจใหม่ทุกครั้งฝั่ง server
 * เวลารับออเดอร์/ปิดด่วนไม่ทำให้ ok=false (ลูกค้ายังดูเมนูได้) — ด่านสั่ง/จ่ายต้องเช็ก availability.open เอง
 */
async function resolveOrderingStoreUncached(slug: string): Promise<OrderingStoreResult> {
  const clean = slug.toLowerCase();
  if (!/^[a-z0-9-]{3,40}$/.test(clean)) return { ok: false, reason: "ไม่พบร้าน" };
  const db: LooseClient = await createSupabaseServiceClient();
  const { data: site } = await db
    .from("store_websites")
    .select("store_id, organization_id, slug, is_enabled, published_document")
    .eq("slug", clean)
    .maybeSingle();
  if (!site?.is_enabled || !site.published_document) return { ok: false, reason: "ร้านนี้ยังไม่เปิดเว็บไซต์" };

  const billing = (await getOrganizationBillingState(site.organization_id)) ?? DEFAULT_BILLING_STATE;
  if (!canUseMemberPrivileges(billing) || !getPlanFeatures(billing).byoPaymentGateway) {
    return { ok: false, reason: "ร้านนี้ยังไม่เปิดสั่งออนไลน์" };
  }
  const [{ data: store }, settings, schedule] = await Promise.all([
    db.from("stores").select("id, name, phone, address, is_active, timezone").eq("id", site.store_id).maybeSingle(),
    getOnlineOrderSettings(site.store_id),
    getOrderingSchedule(site.store_id),
  ]);
  if (!store?.is_active) return { ok: false, reason: "ร้านปิดให้บริการชั่วคราว" };
  if (!settings.enabled) return { ok: false, reason: "ร้านนี้ยังไม่เปิดสั่งออนไลน์" };
  if (!(await isBeamReadyForStore(site.store_id, db))) return { ok: false, reason: "ร้านยังไม่พร้อมรับชำระออนไลน์" };

  return {
    ok: true,
    store: {
      storeId: site.store_id,
      organizationId: site.organization_id,
      storeName: store.name,
      slug: clean,
      phone: store.phone ?? null,
      address: store.address ?? null,
      settings,
      timeZone: store.timezone || "Asia/Bangkok",
      availability: evaluateOrderingAvailability(schedule, new Date(), store.timezone || "Asia/Bangkok"),
    },
  };
}

/** dedupe ภายใน request เดียว (generateMetadata + หน้า) */
export const resolveOrderingStore = cache(resolveOrderingStoreUncached);

/** stores.slug (หน้าสมาชิก) → slug เว็บร้าน (store_websites.slug ที่หน้าสั่งออนไลน์ใช้) */
export async function websiteSlugForStoreSlug(storeSlug: string): Promise<{ storeId: string; websiteSlug: string } | null> {
  const clean = storeSlug.toLowerCase();
  if (!/^[a-z0-9-]{1,100}$/.test(clean)) return null;
  const db: LooseClient = await createSupabaseServiceClient();
  const { data: store } = await db.from("stores").select("id").eq("slug", clean).maybeSingle();
  if (!store) return null;
  const { data: site } = await db.from("store_websites").select("slug").eq("store_id", store.id).maybeSingle();
  if (!site?.slug) return null;
  return { storeId: store.id, websiteSlug: site.slug };
}
