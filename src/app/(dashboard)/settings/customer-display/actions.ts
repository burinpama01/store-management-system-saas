"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { requireFeature, requirePermission } from "@/modules/auth/guards";
import { getCurrentUser, getUserStores, resolveCurrentStore } from "@/modules/auth/session";
import { CUSTOMER_DISPLAY_SLIDE_LIMIT, normalizeCustomerDisplaySettingsInput } from "@/modules/settings/customer-display";
import { upsertCustomerDisplaySettings } from "@/modules/settings/repository";
import { createSupabaseServiceClient } from "@/server/integrations/supabase/server";

const CUSTOMER_DISPLAY_UPLOAD_BUCKET = "product-images";
const customerDisplayUploadExtensions = new Set(["jpg", "jpeg", "png", "gif", "webp", "apng", "mp4", "mov", "webm"]);

interface CreateCustomerDisplayMediaUploadInput {
  organizationId?: string;
  storeId?: string;
  extension?: string | null;
}

interface CreateCustomerDisplayMediaUploadResult {
  error: string | null;
  path?: string;
  token?: string;
  publicUrl?: string;
}

async function getStoreContext() {
  const user = await getCurrentUser();
  if (!user) throw new Error("ไม่มีสิทธิ์เข้าถึง");
  const { organizations, stores, memberships } = await getUserStores();
  const ctx = await resolveCurrentStore(stores, organizations, memberships);
  if (!ctx) throw new Error("ไม่พบข้อมูลร้านค้า");
  return { user, ctx };
}

export async function upsertCustomerDisplaySettingsAction(
  _prev: { error: string | null; saved?: boolean },
  formData: FormData,
): Promise<{ error: string | null; saved?: boolean }> {
  try {
    await requirePermission("settings.manage_store");
    await requireFeature("customerDisplay");
    const { ctx } = await getStoreContext();

    const slideIntervalSeconds = Number.parseInt(String(formData.get("slideIntervalSeconds") ?? ""), 10);
    const topSlides = parseSlidesJson(formData.get("topSlidesJson"));
    const bottomSlides = parseSlidesJson(formData.get("bottomSlidesJson"));
    if (topSlides.length > CUSTOMER_DISPLAY_SLIDE_LIMIT || bottomSlides.length > CUSTOMER_DISPLAY_SLIDE_LIMIT) {
      return { error: `สไลด์ต่อช่องต้องไม่เกิน ${CUSTOMER_DISPLAY_SLIDE_LIMIT} รายการ` };
    }
    const normalized = normalizeCustomerDisplaySettingsInput({
      adEnabled: formData.get("adEnabled") === "1",
      adLayout: String(formData.get("adLayout") ?? "single"),
      topSlotEnabled: formData.get("topSlotEnabled") === "1",
      bottomSlotEnabled: formData.get("bottomSlotEnabled") === "1",
      slideIntervalSeconds,
      topSlides,
      bottomSlides,
    });

    if (normalized.adEnabled && !normalized.topSlotEnabled && !normalized.bottomSlotEnabled) {
      return { error: "ต้องเปิดอย่างน้อยหนึ่งช่องโฆษณา หรือปิดโฆษณาทั้งหมด" };
    }

    const result = await upsertCustomerDisplaySettings(ctx.storeId, ctx.organizationId, normalized);
    if (result.error) return { error: result.error.userMessage };

    revalidatePath("/settings/customer-display");
    revalidatePath("/pos/display");
    revalidatePath("/pos/grocery/display");
    return { error: null, saved: true };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}

export async function createCustomerDisplayMediaUploadAction(
  input: CreateCustomerDisplayMediaUploadInput = {},
): Promise<CreateCustomerDisplayMediaUploadResult> {
  try {
    await requirePermission("settings.manage_store");
    await requireFeature("customerDisplay");
    const { ctx } = await getStoreContext();
    if (input.organizationId !== ctx.organizationId || input.storeId !== ctx.storeId) {
      return { error: "ร้านค้าที่อัพโหลดไม่ตรงกับสิทธิ์ปัจจุบัน" };
    }

    const extension = normalizeCustomerDisplayUploadExtension(input.extension);
    if (!extension) return { error: "ชนิดไฟล์นี้ไม่รองรับสำหรับจอลูกค้า" };

    const fileName = `${randomUUID()}.${extension}`;
    const path = `${ctx.organizationId}/${ctx.storeId}/customer-display/${fileName}`;
    const supabase = await createSupabaseServiceClient();
    const { data: signedUpload, error: signedUploadError } = await supabase.storage
      .from(CUSTOMER_DISPLAY_UPLOAD_BUCKET)
      .createSignedUploadUrl(path);
    if (signedUploadError || !signedUpload?.token) {
      return { error: "เตรียมอัพโหลดไฟล์ไม่สำเร็จ" };
    }

    const { data } = supabase.storage.from(CUSTOMER_DISPLAY_UPLOAD_BUCKET).getPublicUrl(path);
    return { error: null, path, token: signedUpload.token, publicUrl: data.publicUrl };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "เกิดข้อผิดพลาด" };
  }
}

function parseSlidesJson(value: FormDataEntryValue | null) {
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizeCustomerDisplayUploadExtension(value: string | null | undefined) {
  const extension = typeof value === "string" ? value.trim().toLowerCase().replace(/^\./, "") : "";
  return customerDisplayUploadExtensions.has(extension) ? extension : null;
}
