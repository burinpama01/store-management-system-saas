/**
 * ลงโฆษณาผ่าน QR — Supabase queries ฝั่งร้าน (client ของผู้ใช้ → RLS)
 * store_ad_offers: อ่าน=สมาชิกร้าน แก้=settings.manage_store
 */
import { createSupabaseServerClient } from "@/server/integrations/supabase/server";
import { mapStoreAdOfferRow, type StoreAdOffer } from "./rules";
import {
  STORE_AD_REVIEW_TRANSITIONS,
  mapStoreAdOrderRow,
  type StoreAdOrder,
  type StoreAdReviewAction,
} from "./orders";

// ตารางใหม่ยังไม่อยู่ใน database.types (แบบเดียวกับ tax/repository.ts)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LooseClient = any;

type Result<T> = { data: T; error: null } | { data: null; error: string };

export function storeAdErrorMessage(raw: string | undefined | null): string {
  const message = raw ?? "";
  if (message.includes("row-level security") || message.includes("permission denied")) {
    return "ไม่มีสิทธิ์แก้การตั้งค่ารับลงโฆษณา";
  }
  if (message.includes("store_ad_offers") && message.includes("does not exist")) {
    return "ระบบรับลงโฆษณายังไม่พร้อม (ยังไม่ได้อัปเดตฐานข้อมูล)";
  }
  if (message.includes("check constraint")) return "ข้อมูลไม่ถูกต้องตามเงื่อนไข";
  return "บันทึกไม่สำเร็จ ลองใหม่อีกครั้ง";
}

export async function getStoreAdOffer(storeId: string, organizationId: string): Promise<Result<StoreAdOffer>> {
  const supabase = (await createSupabaseServerClient()) as LooseClient;
  const { data, error } = await supabase
    .from("store_ad_offers")
    .select("*")
    .eq("store_id", storeId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (error) return { data: null, error: storeAdErrorMessage(error.message) };
  return { data: mapStoreAdOfferRow(data), error: null };
}

export async function saveStoreAdOffer(
  storeId: string,
  organizationId: string,
  offer: StoreAdOffer,
): Promise<Result<StoreAdOffer>> {
  const supabase = (await createSupabaseServerClient()) as LooseClient;
  const { data, error } = await supabase
    .from("store_ad_offers")
    .upsert(
      {
        organization_id: organizationId,
        store_id: storeId,
        enabled: offer.enabled,
        auto_publish: offer.autoPublish,
        slot: offer.slot,
        max_concurrent: offer.maxConcurrent,
        max_video_seconds: offer.maxVideoSeconds,
        allow_video: offer.allowVideo,
        allow_image: offer.allowImage,
        terms: offer.terms,
        packages: offer.packages,
      },
      { onConflict: "store_id" },
    )
    .select("*")
    .single();
  if (error) return { data: null, error: storeAdErrorMessage(error.message) };
  return { data: mapStoreAdOfferRow(data), error: null };
}

/** รายการโฆษณาที่ลูกค้าลง (หลังร้าน) — ไม่รวมคำสั่งที่ยังไม่จ่าย/ยกเลิก · RLS: settings.manage_store */
export async function listStoreAdOrders(storeId: string, organizationId: string, limit = 50): Promise<Result<StoreAdOrder[]>> {
  const supabase = (await createSupabaseServerClient()) as LooseClient;
  const { data, error } = await supabase
    .from("store_ad_orders")
    .select("*")
    .eq("store_id", storeId)
    .eq("organization_id", organizationId)
    .not("status", "in", "(pending_payment,cancelled)")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) return { data: null, error: storeAdErrorMessage(error.message) };
  return { data: ((data ?? []) as Record<string, unknown>[]).map(mapStoreAdOrderRow), error: null };
}

/**
 * ร้านอนุมัติ / ไม่อนุมัติ / ถอด — เปลี่ยนได้เฉพาะจากสถานะที่กำหนด (กันกดซ้ำ/สองเครื่องพร้อมกัน)
 * อนุมัติ = เริ่มนับวันแสดงตอนนี้ · อนุมัติด้วยมือ = ร้านตัดสินเอง ไม่ติดโควตาพร้อมกัน (ตั้งใจ)
 */
export async function reviewStoreAdOrder(input: {
  storeId: string;
  organizationId: string;
  orderId: string;
  action: StoreAdReviewAction;
  reason: string | null;
  userId: string;
}): Promise<Result<StoreAdOrder>> {
  const supabase = (await createSupabaseServerClient()) as LooseClient;
  const rule = STORE_AD_REVIEW_TRANSITIONS[input.action];
  const { data: current, error: readError } = await supabase
    .from("store_ad_orders")
    .select("*")
    .eq("id", input.orderId)
    .eq("store_id", input.storeId)
    .eq("organization_id", input.organizationId)
    .maybeSingle();
  if (readError) return { data: null, error: storeAdErrorMessage(readError.message) };
  if (!current) return { data: null, error: "ไม่พบโฆษณานี้" };
  const order = mapStoreAdOrderRow(current);
  if (!(rule.from as readonly string[]).includes(order.status)) return { data: null, error: "สถานะเปลี่ยนไปแล้ว ลองโหลดหน้าใหม่" };

  const now = new Date();
  const patch: Record<string, unknown> = {
    status: rule.to,
    reviewed_at: now.toISOString(),
    reviewed_by: input.userId,
    updated_at: now.toISOString(),
  };
  if (input.action === "approve") {
    patch.starts_at = now.toISOString();
    patch.ends_at = new Date(now.getTime() + order.days * 24 * 60 * 60 * 1000).toISOString();
    patch.status_reason = null;
  } else {
    patch.status_reason = input.reason;
  }
  const { data, error } = await supabase
    .from("store_ad_orders")
    .update(patch)
    .eq("id", order.id)
    .eq("store_id", input.storeId)
    .eq("status", order.status)
    .select("*")
    .maybeSingle();
  if (error) return { data: null, error: storeAdErrorMessage(error.message) };
  if (!data) return { data: null, error: "สถานะเปลี่ยนไปแล้ว ลองโหลดหน้าใหม่" };
  return { data: mapStoreAdOrderRow(data), error: null };
}
