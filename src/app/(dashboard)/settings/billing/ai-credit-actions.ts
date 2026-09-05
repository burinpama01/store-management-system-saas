"use server";

import { revalidatePath } from "next/cache";
import { AuthorizationError, getResolvedCurrentPermissions } from "@/modules/auth/guards";
import { getAiUsageSummary, type AiUsageSummary } from "@/modules/ai/quota";
import { getCreditPack, getTopupQr, listCreditPacks, listTopupHistory, type CreditPack, type TopupHistoryRow } from "@/modules/ai/credits";
import type { SubscriptionQr } from "@/modules/billing/promptpay-provider";

export type AiUsageView =
  | { ok: true; summary: AiUsageSummary; packs: CreditPack[]; history: TopupHistoryRow[] }
  | { ok: false; error: string };

/** สรุปการใช้ AI ของทั้งองค์กร (รวมทุกฟีเจอร์) + แพ็กเติมเงิน + ประวัติเติม */
export async function getAiUsageAction(): Promise<AiUsageView> {
  try {
    const { ctx, resolved } = await getResolvedCurrentPermissions();
    if (!resolved.can("settings.view")) return { ok: false, error: "ไม่มีสิทธิ์ดูการใช้งาน AI" };
    const [summary, packs, history] = await Promise.all([
      getAiUsageSummary({ organizationId: ctx.organizationId }),
      listCreditPacks(),
      listTopupHistory(ctx.organizationId),
    ]);
    return { ok: true, summary, packs, history };
  } catch (e) {
    if (e instanceof AuthorizationError) return { ok: false, error: "ไม่มีสิทธิ์" };
    throw e;
  }
}

export type TopupQrView =
  | { ok: true; pack: CreditPack; qr: SubscriptionQr }
  | { ok: false; error: string };

/** QR PromptPay ของแพ็กเติมเครดิตที่เลือก */
export async function getTopupQrAction(packId: string): Promise<TopupQrView> {
  try {
    const { resolved } = await getResolvedCurrentPermissions();
    if (!resolved.can("billing.manage")) return { ok: false, error: "ไม่มีสิทธิ์จัดการการชำระเงิน" };
    const pack = await getCreditPack(packId);
    if (!pack) return { ok: false, error: "ไม่พบแพ็กเติมเงินนี้" };
    return { ok: true, pack, qr: await getTopupQr(pack) };
  } catch (e) {
    if (e instanceof AuthorizationError) return { ok: false, error: "ไม่มีสิทธิ์" };
    throw e;
  }
}

/** เรียกหลังเติมเครดิตสำเร็จ เพื่อให้หน้าอื่นเห็นยอดใหม่ */
export async function revalidateBillingAction(): Promise<void> {
  revalidatePath("/settings/billing");
}
