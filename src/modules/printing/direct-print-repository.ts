// วิธีพิมพ์ระดับร้าน + จองตั๋วครัวที่พิมพ์ตรง (แผน POS Launcher Direct IP Printing v2 — เฟส D3)
// service client เท่านั้น — ผู้เรียก (route/server action) ต้องตรวจสิทธิ์และร้านของผู้ใช้แล้ว

import { createSupabaseServiceClient } from "@/server/integrations/supabase/server";

export type StorePrintMode = "hub" | "direct";

/** จองค้างเกินนี้ (จอที่จองปิด/ค้างก่อนรายงานผล) = จอถัดไปจองต่อได้ — นานกว่าเวลาพิมพ์สูงสุดของโปรแกรม (~60 วิ) */
export const DIRECT_CLAIM_STALE_MS = 2 * 60_000;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- ตาราง/คอลัมน์ใหม่ยังไม่อยู่ใน database.types
async function db(): Promise<any> {
  return createSupabaseServiceClient();
}

export function parsePrintMode(value: unknown): StorePrintMode {
  return value === "direct" ? "direct" : "hub";
}

/** อ่านไม่ได้ = "hub" (พฤติกรรมเดิม) — การพิมพ์ต้องไม่พังเพราะอ่านค่าตั้งไม่ได้ */
export async function getStorePrintMode(storeId: string): Promise<StorePrintMode> {
  try {
    const client = await db();
    const { data, error } = await client.from("stores").select("print_mode").eq("id", storeId).maybeSingle();
    if (error) return "hub";
    return parsePrintMode(data?.print_mode);
  } catch {
    return "hub";
  }
}

export async function setStorePrintMode(storeId: string, organizationId: string, mode: StorePrintMode): Promise<{ error: string | null }> {
  const client = await db();
  const { data, error } = await client
    .from("stores")
    .update({ print_mode: mode })
    .eq("id", storeId)
    .eq("organization_id", organizationId)
    .select("id");
  if (error) return { error: error.message };
  if (!data || data.length === 0) return { error: "ไม่พบร้าน" };
  return { error: null };
}

export type DirectClaimResult =
  | { claim: "mine" }
  | { claim: "taken"; status: "claimed" | "printed" | "unknown" };

/**
 * จองตั๋ว (ออเดอร์+สถานี) ให้จอนี้พิมพ์ — unique (store_id, source_key) ทำให้ได้จอเดียวแม้ยิงพร้อมกัน
 * จองค้างเกิน 2 นาทีโดยไม่มีผล = จอเดิมหายไปแล้ว → จองต่อได้
 */
export async function claimDirectStationTicket(input: {
  organizationId: string;
  storeId: string;
  sourceKey: string;
  printerId: string;
  userId: string;
}): Promise<DirectClaimResult> {
  const client = await db();
  const { data: inserted } = await client
    .from("print_direct_claims")
    .upsert(
      {
        organization_id: input.organizationId,
        store_id: input.storeId,
        source_key: input.sourceKey,
        printer_id: input.printerId,
        claimed_by: input.userId,
      },
      { onConflict: "store_id,source_key", ignoreDuplicates: true },
    )
    .select("id");
  if (inserted && inserted.length > 0) return { claim: "mine" };

  const { data: existing } = await client
    .from("print_direct_claims")
    .select("id, status, claimed_at")
    .eq("store_id", input.storeId)
    .eq("source_key", input.sourceKey)
    .maybeSingle();
  if (!existing) return { claim: "taken", status: "claimed" };
  if (existing.status === "claimed" && Date.parse(existing.claimed_at) < Date.now() - DIRECT_CLAIM_STALE_MS) {
    // แย่งจองคืนแบบมีเงื่อนไข (claimed_at เดิม) — สองจอแย่งพร้อมกันได้จอเดียว
    const { data: retaken } = await client
      .from("print_direct_claims")
      .update({ claimed_by: input.userId, claimed_at: new Date().toISOString(), printer_id: input.printerId })
      .eq("id", existing.id)
      .eq("status", "claimed")
      .eq("claimed_at", existing.claimed_at)
      .select("id");
    if (retaken && retaken.length > 0) return { claim: "mine" };
  }
  return { claim: "taken", status: existing.status };
}

/**
 * ผลการพิมพ์ของตั๋วที่จองไว้:
 *   printed → เก็บไว้ (กันซ้ำ) / unknown → เก็บไว้ ห้ามพิมพ์ซ้ำอัตโนมัติ
 *   failed (ยังไม่ได้ส่งอะไร) → ลบการจอง ให้จอไหนก็ลองใหม่ได้
 */
export async function finishDirectStationTicket(input: {
  storeId: string;
  sourceKey: string;
  userId: string;
  outcome: "printed" | "failed" | "unknown";
  error?: string | null;
}): Promise<void> {
  const client = await db();
  if (input.outcome === "failed") {
    await client
      .from("print_direct_claims")
      .delete()
      .eq("store_id", input.storeId)
      .eq("source_key", input.sourceKey)
      .eq("claimed_by", input.userId)
      .eq("status", "claimed");
    return;
  }
  await client
    .from("print_direct_claims")
    .update({ status: input.outcome, finished_at: new Date().toISOString(), error: input.error ? input.error.slice(0, 300) : null })
    .eq("store_id", input.storeId)
    .eq("source_key", input.sourceKey)
    .eq("claimed_by", input.userId)
    .eq("status", "claimed");
}
