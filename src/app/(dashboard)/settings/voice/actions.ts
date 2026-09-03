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
