"use server";

import { revalidatePath } from "next/cache";
import { requireFeature, requirePermission } from "@/modules/auth/guards";
import { getCurrentUser, getUserStores, resolveCurrentStore } from "@/modules/auth/session";
import { CUSTOMER_DISPLAY_SLIDE_LIMIT, normalizeCustomerDisplaySettingsInput } from "@/modules/settings/customer-display";
import { upsertCustomerDisplaySettings } from "@/modules/settings/repository";

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

function parseSlidesJson(value: FormDataEntryValue | null) {
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
