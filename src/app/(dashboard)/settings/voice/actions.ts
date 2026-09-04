"use server";

// U16 — Voice settings actions (R2, v0.38.3)
// alias เป็น "owner-authored" เท่านั้น: ทุกเส้นทางที่นี่รับข้อความที่ผู้จัดการพิมพ์เอง
// ไม่มี action ใดรับ transcript หรือคำที่ระบบได้ยิน (ห้าม auto-learning โดยสิ้นเชิง)

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/modules/auth/guards";
import { getCurrentUser, getUserStores, resolveCurrentStore } from "@/modules/auth/session";
import {
  createVoiceAlias,
  createVoiceAliases,
  setVoiceAliasActive,
  VOICE_ALIAS_INTENT_TYPES,
  type VoiceAliasIntentType,
} from "@/modules/voice-pos/alias-repository";
import {
  ModifierOptionSlotsSchema,
  isOptionOwnedByStore,
} from "@/modules/voice-pos/alias-proposal";
import { listProducts } from "@/modules/catalog/repository";
import { logSystemEvent } from "@/modules/system/event-log";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_ALIAS_LENGTH = 60;

async function getStoreContext() {
  const user = await getCurrentUser();
  if (!user) throw new Error("No active user");
  const { organizations, stores, memberships } = await getUserStores();
  const ctx = await resolveCurrentStore(stores, organizations, memberships);
  if (!ctx) throw new Error("No active store");
  return { ctx, user };
}

function isAliasIntent(value: string): value is VoiceAliasIntentType {
  return (VOICE_ALIAS_INTENT_TYPES as readonly string[]).includes(value);
}

export async function createVoiceAliasAction(
  _prev: { error: string | null; success: string | null },
  formData: FormData,
): Promise<{ error: string | null; success: string | null }> {
  await requirePermission("settings.manage_store");
  const { ctx, user } = await getStoreContext();

  const aliasText = String(formData.get("aliasText") ?? "").trim();
  const targetQuery = String(formData.get("targetQuery") ?? "").trim();
  const intentType = String(formData.get("intentType") ?? "navigate");

  if (!aliasText || !targetQuery) return { error: "กรอกคำเรียกและปลายทางให้ครบ", success: null };
  if (aliasText.length > MAX_ALIAS_LENGTH) return { error: "คำเรียกยาวเกินไป", success: null };
  if (!isAliasIntent(intentType)) return { error: "ชนิดคำสั่งนี้ยังไม่รองรับ", success: null };

  const { error } = await createVoiceAlias({
    organizationId: ctx.organizationId,
    storeId: ctx.storeId,
    aliasText,
    intentType,
    targetQuery,
    createdBy: user.id,
  });
  if (error) return { error: error.userMessage, success: null };

  revalidatePath("/settings/voice", "page");
  return { error: null, success: `เพิ่มคำเรียก "${aliasText}" แล้ว` };
}

export async function setVoiceAliasActiveAction(
  aliasId: string,
  isActive: boolean,
): Promise<{ error: string | null }> {
  await requirePermission("settings.manage_store");
  const { ctx } = await getStoreContext();
  if (!UUID_RE.test(aliasId)) return { error: "รหัสคำเรียกไม่ถูกต้อง" };

  const { error } = await setVoiceAliasActive(aliasId, ctx.storeId, isActive);
  if (error) return { error: error.userMessage };

  revalidatePath("/settings/voice", "page");
  return { error: null };
}

/**
 * U22 — บันทึก "คำเรียกเมนู" ที่ผู้ใช้ติ๊กเลือกจากรายการที่ระบบวิเคราะห์มาให้
 * ระบบไม่บันทึกเองแม้แต่คำเดียว — ต้องผ่านการติ๊กจากผู้จัดการเสมอ
 */
export async function saveProductAliasesAction(
  selections: ReadonlyArray<{ aliasText: string; productId: string }>,
): Promise<{ error: string | null; saved: number }> {
  await requirePermission("settings.manage_store");
  const { ctx, user } = await getStoreContext();

  const cleaned = selections
    .map((item) => ({ aliasText: String(item.aliasText ?? "").trim(), productId: String(item.productId ?? "").trim() }))
    .filter((item) => item.aliasText.length > 0 && item.aliasText.length <= MAX_ALIAS_LENGTH && UUID_RE.test(item.productId));
  if (cleaned.length === 0) return { error: "ยังไม่ได้เลือกคำเรียกที่จะบันทึก", saved: 0 };

  const { saved, error } = await createVoiceAliases(
    cleaned.map((item) => ({
      organizationId: ctx.organizationId,
      storeId: ctx.storeId,
      aliasText: item.aliasText,
      intentType: "product" as const,
      productId: item.productId,
      createdBy: user.id,
    })),
  );
  if (error) return { error: error.userMessage, saved: 0 };

  revalidatePath("/settings/voice", "page");
  revalidatePath("/pos", "page");
  return { error: null, saved };
}

/**
 * P9 — บันทึกคำเรียก "ตัวเลือกสินค้า" ที่ผู้จัดการกดยืนยันเอง
 *
 * ด่านที่ต้องผ่านครบก่อนเขียน:
 *   1. สิทธิ์ settings.manage_store (คนอื่นไม่มีทางมาถึงบรรทัดนี้)
 *   2. slots เป็น uuid ครบสามตัว
 *   3. ตัวเลือกนั้นเป็นของ "สินค้าในร้านนี้" จริง — กัน alias ข้ามร้าน/ข้ามสินค้า
 * ระบบไม่เคยสร้าง alias เองจากคำที่ได้ยิน: action นี้ถูกเรียกจากปุ่มยืนยันเท่านั้น
 */
export async function saveOptionAliasAction(
  _prev: { error: string | null; success: string | null },
  formData: FormData,
): Promise<{ error: string | null; success: string | null }> {
  await requirePermission("settings.manage_store");
  const { ctx, user } = await getStoreContext();

  const aliasText = String(formData.get("aliasText") ?? "").trim();
  if (!aliasText) return { error: "ไม่มีคำเรียกให้บันทึก", success: null };
  if (aliasText.length > MAX_ALIAS_LENGTH) return { error: "คำเรียกยาวเกินไป", success: null };

  const slots = ModifierOptionSlotsSchema.safeParse({
    productId: String(formData.get("productId") ?? ""),
    modifierGroupId: String(formData.get("modifierGroupId") ?? ""),
    optionId: String(formData.get("optionId") ?? ""),
  });
  if (!slots.success) return { error: "ข้อมูลตัวเลือกไม่ถูกต้อง", success: null };

  const products = await listProducts(ctx.storeId, { includeInactive: true });
  if (!isOptionOwnedByStore(slots.data, products.data ?? [])) {
    return { error: "ตัวเลือกนี้ไม่ได้อยู่ในเมนูของร้านนี้", success: null };
  }

  const { error } = await createVoiceAlias({
    organizationId: ctx.organizationId,
    storeId: ctx.storeId,
    aliasText,
    intentType: "modifier_option",
    modifierOptionSlots: slots.data,
    createdBy: user.id,
  });
  if (error) return { error: error.userMessage, success: null };

  await logSystemEvent({
    level: "info",
    source: "voice.alias",
    action: "saveOptionAlias",
    message: `บันทึกคำเรียกตัวเลือก "${aliasText}" แล้ว`,
    organizationId: ctx.organizationId,
    storeId: ctx.storeId,
    actorUserId: user.id,
    context: { ...slots.data },
  });

  revalidatePath("/settings/voice", "page");
  return { error: null, success: `บันทึกคำเรียก "${aliasText}" แล้ว` };
}
