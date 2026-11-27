/**
 * ลงโฆษณาผ่าน QR — Supabase queries ฝั่งร้าน (client ของผู้ใช้ → RLS)
 * store_ad_offers: อ่าน=สมาชิกร้าน แก้=settings.manage_store
 */
import { createSupabaseServerClient } from "@/server/integrations/supabase/server";
import { mapStoreAdOfferRow, type StoreAdOffer } from "./rules";

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
