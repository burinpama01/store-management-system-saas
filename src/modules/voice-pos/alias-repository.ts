/**
 * U16 — Voice aliases (R2, v0.38.3)
 *
 * แผนอ้างอิง: Plan/QR Order Voice Unified POS Implementation Plan v2.html
 *   - "voice_aliases เก็บ owner-authored aliases เท่านั้น"
 *   - "owner aliases have explicit create/approve/disable audit; no auto-learning"
 *
 * กฎที่บังคับในชั้นนี้:
 *   - alias ถูก "พิมพ์" โดยผู้จัดการเท่านั้น — ห้ามมีเส้นทางใดสร้าง alias จากคำพูดที่ได้ยิน
 *     (ไม่มีฟังก์ชันรับ transcript ในไฟล์นี้ และ createVoiceAlias รับเฉพาะข้อความที่ผู้ใช้พิมพ์)
 *   - ปิดใช้งาน (is_active=false) แทนการลบ เพื่อให้ยังตรวจย้อนหลังได้ว่าใครสร้าง/ปิดเมื่อไร
 *   - intent ที่ผูกได้ต้องอยู่ใน allowlist ของ Tier A เท่านั้น (นำทาง) — ห้ามผูกคำสั่งเงิน/ตะกร้า
 */
import type { AppError } from "@/shared/utils/error";
import { mapError } from "@/shared/utils/error";
import { createSupabaseServerClient } from "@/server/integrations/supabase/server";

/**
 * intent ที่ alias ผูกได้
 *   navigate = เปิดหน้าในระบบ (Tier A)
 *   product  = คำเรียกเมนู เช่น "มัจฉะลาเต้" → สินค้า "Matcha latte" (U22)
 * ยังคงหลัก "เสียงห้ามแตะเงิน/สต๊อก" — ไม่มี intent ที่ผูกกับการเงิน
 */
export const VOICE_ALIAS_INTENT_TYPES = ["navigate", "product"] as const;
export type VoiceAliasIntentType = (typeof VOICE_ALIAS_INTENT_TYPES)[number];

export interface VoiceAlias {
  readonly id: string;
  readonly storeId: string;
  /** ข้อความที่ผู้จัดการพิมพ์เอง (ไม่ใช่คำพูดที่ระบบได้ยิน) */
  readonly aliasText: string;
  readonly intentType: VoiceAliasIntentType;
  /** เป้าหมายของ alias เช่น { query: "รายงาน" } */
  readonly slots: Record<string, string>;
  readonly isActive: boolean;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateVoiceAliasInput {
  readonly organizationId: string;
  readonly storeId: string;
  readonly aliasText: string;
  readonly intentType: VoiceAliasIntentType;
  /** navigate = คำค้นหน้าปลายทาง */
  readonly targetQuery?: string;
  /** product = สินค้าที่ต้องการ */
  readonly productId?: string;
  readonly createdBy: string;
}

/** สร้าง slots ให้ตรงชนิด intent — คืน null เมื่อข้อมูลไม่ครบ */
function buildAliasSlots(input: CreateVoiceAliasInput): Record<string, string> | null {
  if (input.intentType === "product") {
    const productId = input.productId?.trim();
    return productId ? { product_id: productId } : null;
  }
  const query = normalizeAliasText(input.targetQuery ?? "");
  return query ? { query } : null;
}

function toSlots(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") return {};
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === "string") out[key] = raw;
  }
  return out;
}

function isAliasIntentType(value: string): value is VoiceAliasIntentType {
  return (VOICE_ALIAS_INTENT_TYPES as readonly string[]).includes(value);
}

/** normalize ข้อความ alias — trim + ยุบช่องว่าง (ไม่แปลงความหมาย ไม่เดา) */
export function normalizeAliasText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

export async function listVoiceAliases(
  storeId: string,
): Promise<{ data: VoiceAlias[]; error: AppError | null }> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("voice_aliases")
    .select("id, store_id, alias_text, intent_type, slots, is_active, created_by, created_at, updated_at")
    .eq("store_id", storeId)
    .order("created_at", { ascending: false });
  if (error) return { data: [], error: mapError(error) };

  const rows = (data ?? []).filter((row) => isAliasIntentType(row.intent_type));
  return {
    data: rows.map((row) => ({
      id: row.id,
      storeId: row.store_id,
      aliasText: row.alias_text,
      intentType: row.intent_type as VoiceAliasIntentType,
      slots: toSlots(row.slots),
      isActive: row.is_active,
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
    error: null,
  };
}

/**
 * สร้าง alias ใหม่ — ต้องมาจากฟอร์มที่ผู้จัดการพิมพ์เองเท่านั้น
 * RLS (manager+) เป็นด่านอนุมัติจริง และ created_by คือหลักฐานว่าใครเป็นคนสร้าง
 */
export async function createVoiceAlias(
  input: CreateVoiceAliasInput,
): Promise<{ data: VoiceAlias | null; error: AppError | null }> {
  const aliasText = normalizeAliasText(input.aliasText);
  const slots = buildAliasSlots(input);
  if (!aliasText || !slots) {
    return {
      data: null,
      error: { code: "validation_error", message: "alias/target ว่าง", userMessage: "กรอกคำเรียกและปลายทางให้ครบ" },
    };
  }

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("voice_aliases")
    .insert({
      organization_id: input.organizationId,
      store_id: input.storeId,
      alias_text: aliasText,
      intent_type: input.intentType,
      slots,
      is_active: true,
      created_by: input.createdBy,
    })
    .select("id, store_id, alias_text, intent_type, slots, is_active, created_by, created_at, updated_at")
    .single();
  if (error || !data) return { data: null, error: mapError(error) };

  return {
    data: {
      id: data.id,
      storeId: data.store_id,
      aliasText: data.alias_text,
      intentType: input.intentType,
      slots: toSlots(data.slots),
      isActive: data.is_active,
      createdBy: data.created_by,
      createdAt: data.created_at,
      updatedAt: data.updated_at,
    },
    error: null,
  };
}

/**
 * U22 — บันทึกคำเรียกหลายคำในครั้งเดียว (มาจากหน้าตรวจสอบข้อเสนออัตโนมัติ)
 * คำที่ซ้ำกับของเดิมจะถูกข้ามอย่างเงียบ ๆ (unique index ต่อร้านเป็นตัวตัดสินสุดท้าย)
 */
export async function createVoiceAliases(
  inputs: readonly CreateVoiceAliasInput[],
): Promise<{ saved: number; error: AppError | null }> {
  const rows = inputs
    .map((input) => {
      const aliasText = normalizeAliasText(input.aliasText);
      const slots = buildAliasSlots(input);
      if (!aliasText || !slots) return null;
      return {
        organization_id: input.organizationId,
        store_id: input.storeId,
        alias_text: aliasText,
        intent_type: input.intentType,
        slots,
        is_active: true,
        created_by: input.createdBy,
      };
    })
    .filter((row): row is NonNullable<typeof row> => row !== null);
  if (rows.length === 0) return { saved: 0, error: null };

  // หมายเหตุ: unique index ของตารางนี้เป็น expression index (store_id, lower(alias_text))
  // จึงใช้ upsert/ON CONFLICT กับคู่คอลัมน์ตรง ๆ ไม่ได้ — insert แล้วข้ามเฉพาะแถวที่ซ้ำแทน
  const supabase = await createSupabaseServerClient();
  const bulk = await supabase.from("voice_aliases").insert(rows).select("id");
  if (!bulk.error) return { saved: bulk.data?.length ?? 0, error: null };
  if (bulk.error.code !== "23505") return { saved: 0, error: mapError(bulk.error) };

  let saved = 0;
  for (const row of rows) {
    const single = await supabase.from("voice_aliases").insert(row).select("id").maybeSingle();
    if (!single.error) {
      saved += 1;
      continue;
    }
    if (single.error.code !== "23505") return { saved, error: mapError(single.error) };
  }
  return { saved, error: null };
}

/**
 * เปิด/ปิดใช้งาน alias (ไม่ลบทิ้ง เพื่อคงร่องรอยการตรวจสอบ)
 * ผูก store_id ไว้ด้วยเสมอ — RLS กันข้ามร้านอยู่แล้ว แต่กันซ้ำอีกชั้นที่ query
 * เพื่อไม่ให้ id ที่หลุดมาจากที่อื่นถูกนำมาใช้แก้แถวของร้านอื่นได้เลย
 */
export async function setVoiceAliasActive(
  aliasId: string,
  storeId: string,
  isActive: boolean,
): Promise<{ error: AppError | null }> {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase
    .from("voice_aliases")
    .update({ is_active: isActive, updated_at: new Date().toISOString() })
    .eq("id", aliasId)
    .eq("store_id", storeId);
  return { error: error ? mapError(error) : null };
}
