"use server";

import { revalidatePath } from "next/cache";
import { getResolvedCurrentPermissions } from "@/modules/auth/guards";
import { getOrganizationBillingState } from "@/modules/billing/billing-service";
import { DEFAULT_BILLING_STATE, getPlanFeatures } from "@/modules/billing/types";
import { saveStoreAdOffer } from "@/modules/ad-self-serve/repository";
import { canUseAdSelfServe, normalizeStoreAdOfferInput } from "@/modules/ad-self-serve/rules";
import { logSystemEvent } from "@/modules/system/event-log";

type ActionResult = { error: string | null; saved?: boolean };

/** บันทึกเงื่อนไข/แพ็กรับลงโฆษณาของร้าน — settings.manage_store + แพ็กต้องมี adSelfServe และ customerDisplay */
export async function saveStoreAdOfferAction(input: Record<string, unknown>): Promise<ActionResult> {
  const { user, ctx, resolved } = await getResolvedCurrentPermissions();
  if (!resolved.can("settings.manage_store")) return { error: "ไม่มีสิทธิ์แก้การตั้งค่าร้าน" };

  const billing = (await getOrganizationBillingState(ctx.organizationId)) ?? DEFAULT_BILLING_STATE;
  if (!canUseAdSelfServe(getPlanFeatures(billing))) {
    return { error: "แพ็กเกจยังไม่รองรับการรับลงโฆษณาผ่าน QR (ต้องมีจอลูกค้าด้วย)" };
  }

  const normalized = normalizeStoreAdOfferInput(input);
  if ("error" in normalized) return { error: normalized.error };

  const result = await saveStoreAdOffer(ctx.storeId, ctx.organizationId, normalized.offer);
  await logSystemEvent({
    level: result.error ? "warn" : "info",
    source: "ad-self-serve",
    action: "saveStoreAdOffer",
    message: result.error
      ? `บันทึกการตั้งค่ารับลงโฆษณาไม่สำเร็จ: ${result.error}`
      : normalized.offer.enabled
        ? "เปิด/อัปเดตการรับลงโฆษณาผ่าน QR"
        : "ปิดการรับลงโฆษณาผ่าน QR",
    organizationId: ctx.organizationId,
    storeId: ctx.storeId,
    actorUserId: user.id,
    context: {
      enabled: normalized.offer.enabled,
      autoPublish: normalized.offer.autoPublish,
      slot: normalized.offer.slot,
      maxConcurrent: normalized.offer.maxConcurrent,
      packages: normalized.offer.packages.map((pkg) => `${pkg.days}d:${pkg.price}`),
    },
  }).catch(() => undefined);
  if (result.error) return { error: result.error };

  revalidatePath("/settings/ad-self-serve");
  return { error: null, saved: true };
}
