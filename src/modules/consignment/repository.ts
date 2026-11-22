/**
 * สินค้าซื้อขาด/ฝากขาย — Supabase queries (เฟส C0)
 * สวิตช์สาขาเปลี่ยนผ่าน RPC consignment_set_enabled (owner/admin + Enterprise ตรวจใน DB อีกชั้น)
 */
import { logSystemEvent } from "@/modules/system/event-log";
import { createSupabaseServerClient, createSupabaseServiceClient } from "@/server/integrations/supabase/server";

// คอลัมน์/RPC ใหม่ยังไม่อยู่ใน database.types (แบบเดียวกับ inventory/repository.ts)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LooseClient = any;

type Result<T> = { data: T; error: null } | { data: null; error: string };

export function consignmentErrorMessage(raw: string | undefined | null): string {
  const message = raw ?? "";
  if (message.includes("only owner/admin")) return "เปิด/ปิดได้เฉพาะเจ้าของหรือแอดมิน";
  if (message.includes("enterprise plan")) return "สินค้าซื้อขาด/ฝากขาย ใช้ได้เฉพาะแพ็กเกจ Enterprise";
  if (message.includes("store not found")) return "ไม่พบสาขานี้";
  return "บันทึกไม่สำเร็จ ลองใหม่อีกครั้ง";
}

export async function isConsignmentEnabled(storeId: string): Promise<boolean> {
  const db: LooseClient = await createSupabaseServiceClient();
  const { data, error } = await db.from("stores").select("consignment_enabled").eq("id", storeId).maybeSingle();
  if (error) {
    // ไม่ล้มทั้งหน้า (ถือว่าปิด) แต่ห้ามเงียบ — ทิ้ง log ให้ตามได้
    await logSystemEvent({
      level: "warn",
      source: "consignment",
      action: "isConsignmentEnabledFailed",
      message: `อ่านสวิตช์ฝากขายไม่สำเร็จ: ${error.message}`,
      storeId,
    }).catch(() => undefined);
    return false;
  }
  return data?.consignment_enabled === true;
}

export async function setConsignmentEnabled(storeId: string, enabled: boolean): Promise<Result<boolean>> {
  const db: LooseClient = await createSupabaseServerClient();
  const { data, error } = await db.rpc("consignment_set_enabled", { p_store_id: storeId, p_enabled: enabled });
  if (error) return { data: null, error: consignmentErrorMessage(error.message) };
  return { data: data === true, error: null };
}
