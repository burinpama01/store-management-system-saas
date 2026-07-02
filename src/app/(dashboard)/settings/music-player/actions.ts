"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/modules/auth/guards";
import { getCurrentUser, getUserStores, resolveCurrentStore } from "@/modules/auth/session";
import { getOrganizationBillingState } from "@/modules/billing/billing-service";
import { DEFAULT_BILLING_STATE, getPlanFeatures } from "@/modules/billing/types";
import { getStore } from "@/modules/stores/repository";
import { upsertMusicPlayerSettings } from "@/modules/music-requests/repository";
import { parseBasePlaylist } from "@/modules/music-requests/youtube";

async function getStoreContext() {
  const user = await getCurrentUser();
  if (!user) throw new Error("ไม่มีสิทธิ์เข้าถึง");
  const { organizations, stores, memberships } = await getUserStores();
  const ctx = await resolveCurrentStore(stores, organizations, memberships);
  if (!ctx) throw new Error("ไม่พบข้อมูลร้านค้า");
  return { user, ctx };
}

export async function updateMusicPlayerSettingsAction(
  _prev: { error: string | null },
  formData: FormData,
): Promise<{ error: string | null }> {
  try {
    await requirePermission("settings.manage_store");
    const { ctx } = await getStoreContext();

    const billing =
      (await getOrganizationBillingState(ctx.organizationId)) ?? DEFAULT_BILLING_STATE;
    if (!getPlanFeatures(billing).musicRequest) {
      return { error: "ฟีเจอร์เครื่องเล่นเพลงสำหรับแพ็กเกจ Enterprise เท่านั้น" };
    }
    const storeRes = await getStore(ctx.storeId);
    if (storeRes.data?.musicLicenseStatus !== "approved") {
      return { error: "ต้องได้รับการอนุมัติ Music License ก่อน" };
    }

    const licensingAcknowledged = formData.get("licensingAcknowledged") === "1";
    const playerEnabled = formData.get("playerEnabled") === "1";
    if (playerEnabled && !licensingAcknowledged) {
      return { error: "กรุณายอมรับเงื่อนไขลิขสิทธิ์เพลงก่อนเปิดเครื่องเล่น" };
    }

    const autoApprove = formData.get("autoApprove") === "1";
    const donationEnabled = formData.get("donationEnabled") === "1";

    const minRaw = parseFloat((formData.get("minDonation") as string | null) ?? "");
    const minDonation = Number.isFinite(minRaw) && minRaw >= 0 ? Math.round(minRaw * 100) / 100 : 10;

    const playNowRaw = parseFloat((formData.get("playNowPrice") as string | null) ?? "");
    const playNowPrice =
      Number.isFinite(playNowRaw) && playNowRaw >= 0 ? Math.round(playNowRaw * 100) / 100 : 100;

    const durRaw = parseInt((formData.get("maxDurationSeconds") as string | null) ?? "", 10);
    const maxDurationSeconds =
      Number.isInteger(durRaw) && durRaw >= 60 && durRaw <= 1800 ? durRaw : 600;

    const basePlaylist = parseBasePlaylist((formData.get("basePlaylist") as string | null) ?? "");

    const res = await upsertMusicPlayerSettings(ctx.storeId, ctx.organizationId, {
      playerEnabled,
      autoApprove,
      donationEnabled,
      minDonation,
      playNowPrice,
      maxDurationSeconds,
      basePlaylist,
      licensingAcknowledged,
    });
    if (res.error) return { error: res.error.userMessage };

    revalidatePath("/settings/music-player");
    return { error: null };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}
