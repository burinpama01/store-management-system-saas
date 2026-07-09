"use server";

import { revalidatePath } from "next/cache";
import { getOrganizationBillingState } from "@/modules/billing/billing-service";
import {
  DEFAULT_BILLING_STATE,
  getPlanFeatures,
} from "@/modules/billing/types";
import { requirePermission } from "@/modules/auth/guards";
import { getCurrentUser, getUserStores, resolveCurrentStore } from "@/modules/auth/session";
import { updateStore, getStore, updateStoreServiceButtons } from "@/modules/stores/repository";
import { resolveThemeSelection } from "@/modules/theme/presets";
import {
  DEFAULT_SERVICE_BUTTONS,
  SERVICE_REQUEST_TYPES,
  type ServiceButtonConfig,
  type ServiceRequestType,
} from "@/modules/qr-ordering/types";

const ALLOWED_TIMEZONES = new Set([
  "Asia/Bangkok",
  "Asia/Singapore",
  "Asia/Kuala_Lumpur",
  "Asia/Jakarta",
  "Asia/Kolkata",
  "Asia/Tokyo",
  "UTC",
]);

const ALLOWED_CURRENCIES = new Set(["THB", "USD", "SGD", "JPY", "EUR", "MYR", "IDR"]);

const ALLOWED_LOCALES = new Set(["th-TH", "en-US", "en-GB", "ja-JP", "zh-CN", "ms-MY", "id-ID"]);

async function getStoreContext() {
  const user = await getCurrentUser();
  if (!user) throw new Error("ไม่มีสิทธิ์เข้าถึง");
  const { organizations, stores, memberships } = await getUserStores();
  const ctx = await resolveCurrentStore(stores, organizations, memberships);
  if (!ctx) throw new Error("ไม่พบข้อมูลร้านค้า");
  return { user, ctx };
}

export async function updateStoreAction(
  _prev: { error: string | null },
  formData: FormData,
): Promise<{ error: string | null }> {
  try {
    await requirePermission("settings.manage_store");
    const { ctx } = await getStoreContext();

    const name = (formData.get("name") as string | null)?.trim() ?? "";
    const logoUrl = (formData.get("logoUrl") as string | null)?.trim() || null;
    const address = (formData.get("address") as string | null)?.trim() || undefined;
    const phone = (formData.get("phone") as string | null)?.trim() || undefined;
    const timezone = (formData.get("timezone") as string | null)?.trim() ?? "Asia/Bangkok";
    const locale = (formData.get("locale") as string | null)?.trim() ?? "th-TH";
    const currencyCode = (formData.get("currencyCode") as string | null)?.trim() ?? "THB";
    const buffetEnabled = formData.get("buffetEnabled") === "1";
    const qrOrderingEnabled = formData.get("qrOrderingEnabled") === "1";
    const qrOrderingMode =
      formData.get("qrOrderingMode") === "session_printed" ? "session_printed" : "table_bound";
    const musicRequestEnabled = formData.get("musicRequestEnabled") === "1";
    const requestedSelfOpen = formData.get("tableOpenPolicy") === "customer_self";
    const dineInRaw = parseInt((formData.get("dineInDurationMinutes") as string | null) ?? "", 10);
    const dineInDurationMinutes =
      Number.isInteger(dineInRaw) && dineInRaw >= 15 && dineInRaw <= 600 ? dineInRaw : 120;
    const themePresetId = (formData.get("themePresetId") as string | null)?.trim() ?? "";
    const theme = resolveThemeSelection({
      presetId: themePresetId,
      primaryColor: (formData.get("themePrimaryColor") as string | null)?.trim(),
      primaryStrongColor: (formData.get("themePrimaryStrongColor") as string | null)?.trim(),
      primarySoftColor: (formData.get("themePrimarySoftColor") as string | null)?.trim(),
      accentColor: (formData.get("themeAccentColor") as string | null)?.trim(),
    });

    if (!name) return { error: "กรุณาระบุชื่อร้านค้า" };
    if (name.length > 100) return { error: "ชื่อร้านค้ายาวเกิน 100 ตัวอักษร" };
    if (address && address.length > 300) return { error: "ที่อยู่ยาวเกิน 300 ตัวอักษร" };
    if (phone && phone.length > 20) return { error: "เบอร์โทรยาวเกิน 20 ตัวอักษร" };
    if (!ALLOWED_TIMEZONES.has(timezone)) return { error: "Timezone ไม่ถูกต้อง" };
    if (!ALLOWED_CURRENCIES.has(currencyCode)) return { error: "สกุลเงินไม่ถูกต้อง" };
    if (!ALLOWED_LOCALES.has(locale)) return { error: "Locale ไม่ถูกต้อง" };
    if (!theme.ok) return { error: theme.error };

    const billingState =
      (await getOrganizationBillingState(ctx.organizationId)) ??
      DEFAULT_BILLING_STATE;
    const features = getPlanFeatures(billingState);
    if (buffetEnabled && !features.buffetManagement) {
      return { error: "แพ็กเกจปัจจุบันยังไม่รองรับโหมดบุฟเฟต์" };
    }
    if (qrOrderingEnabled && !features.qrOrdering) {
      return { error: "แพ็กเกจปัจจุบันยังไม่รองรับ QR Ordering" };
    }
    // Customer self-open only applies to table_bound à la carte ordering.
    if (requestedSelfOpen && qrOrderingMode !== "table_bound") {
      return { error: "โหมดให้ลูกค้าเปิดโต๊ะเองใช้ได้เฉพาะ QR แบบผูกโต๊ะ (table_bound)" };
    }
    if (requestedSelfOpen && buffetEnabled) {
      return { error: "โหมดบุฟเฟต์ต้องให้พนักงานเปิดโต๊ะ ไม่รองรับให้ลูกค้าเปิดเอง" };
    }
    const tableOpenPolicy = requestedSelfOpen ? "customer_self" : "staff_only";
    // Music can only be turned on by Enterprise stores with an approved license.
    if (musicRequestEnabled) {
      if (!features.musicRequest) {
        return { error: "ฟีเจอร์ขอเพลงสำหรับแพ็กเกจ Enterprise เท่านั้น" };
      }
      const storeRes = await getStore(ctx.storeId);
      if (storeRes.data?.musicLicenseStatus !== "approved") {
        return { error: "ต้องได้รับการอนุมัติ Music License ก่อนจึงจะเปิดการขอเพลงได้" };
      }
    }

    const result = await updateStore(ctx.storeId, ctx.organizationId, {
      name,
      logoUrl,
      address: address ?? null,
      phone: phone ?? null,
      timezone,
      locale,
      currencyCode,
      buffetEnabled,
      qrOrderingEnabled,
      qrOrderingMode,
      tableOpenPolicy,
      musicRequestEnabled,
      dineInDurationMinutes,
      themePresetId: theme.theme.presetId,
      themePrimaryColor: theme.theme.primaryColor,
      themePrimaryStrongColor: theme.theme.primaryStrongColor,
      themePrimarySoftColor: theme.theme.primarySoftColor,
      themeAccentColor: theme.theme.accentColor,
    });

    if (result.error) return { error: result.error.userMessage };

    revalidatePath("/settings/store");
    return { error: null };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}

/** บันทึกปุ่มเรียกบริการ (ข้อความ + เปิด/ปิด) จากหน้าตั้งค่าร้าน */
export async function updateServiceButtonsAction(
  buttons: Array<{ key: string; label: string; enabled: boolean }>,
): Promise<{ error: string | null }> {
  try {
    await requirePermission("settings.manage_store");
    const { ctx } = await getStoreContext();

    // Normalise against the canonical set: keep known keys, sanitise labels.
    const byKey = new Map(buttons.map((b) => [b.key, b]));
    const normalised: ServiceButtonConfig[] = DEFAULT_SERVICE_BUTTONS.map((def) => {
      const incoming = byKey.get(def.key);
      const label =
        typeof incoming?.label === "string" && incoming.label.trim()
          ? incoming.label.trim().slice(0, 40)
          : def.label;
      return {
        key: def.key,
        label,
        enabled: typeof incoming?.enabled === "boolean" ? incoming.enabled : def.enabled,
      };
    });
    // Guard: reject unknown keys entirely (defensive).
    for (const b of buttons) {
      if (!SERVICE_REQUEST_TYPES.includes(b.key as ServiceRequestType)) {
        return { error: "ปุ่มบริการไม่ถูกต้อง" };
      }
    }

    const result = await updateStoreServiceButtons(ctx.storeId, ctx.organizationId, normalised);
    if (result.error) return { error: result.error.userMessage };

    revalidatePath("/settings/store");
    return { error: null };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}
