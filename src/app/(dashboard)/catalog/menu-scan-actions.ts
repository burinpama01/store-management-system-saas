"use server";

import { redirect } from "next/navigation";
import { getResolvedCurrentPermissions } from "@/modules/auth/guards";
import { listCategories } from "@/modules/catalog/repository";
import { getOrganizationBillingState } from "@/modules/billing/billing-service";
import { canUseFeature } from "@/modules/billing/types";
import { isAiEnabled } from "@/modules/ai/gateway";
import { getQuotaStatus, type QuotaStatus } from "@/modules/ai/quota";

/** รายการหมวดหมู่ปัจจุบันสำหรับ Menu Scan wizard (permission เดิม, scoped เดิม) */
export async function listCategoriesForScan(): Promise<{ ok: true; categories: Array<{ id: string; name: string }> } | { ok: false; error: string }> {
  const { ctx, resolved } = await getResolvedCurrentPermissions();
  if (!ctx) redirect("/login");
  if (!resolved.can("catalog.manage")) return { ok: false, error: "forbidden" };
  const res = await listCategories(ctx.storeId);
  if (res.error) return { ok: false, error: res.error.userMessage };
  return {
    ok: true,
    categories: (res.data ?? []).map((c) => ({ id: c.id, name: c.name })),
  };
}
export type MenuScanQuotaView =
  | ({ ok: true; enabled: true } & QuotaStatus)
  | { ok: true; enabled: false; reason: string }
  | { ok: false; error: string };

/** โควตา AI ที่เหลือของเดือนนี้ + สถานะว่าเปิดใช้ AI ได้หรือไม่ (แสดงบนหัว wizard) */
export async function getMenuScanQuotaAction(): Promise<MenuScanQuotaView> {
  const { ctx, resolved } = await getResolvedCurrentPermissions();
  if (!ctx) redirect("/login");
  if (!resolved.can("catalog.manage")) return { ok: false, error: "forbidden" };
  const billingState = (await getOrganizationBillingState(ctx.organizationId)) ?? undefined;
  if (billingState && !canUseFeature(billingState, "aiVision")) {
    return { ok: true, enabled: false, reason: "แพ็กเกจปัจจุบันยังไม่รวม AI อ่านเมนู" };
  }
  if (!isAiEnabled()) {
    return { ok: true, enabled: false, reason: "ระบบ AI ยังไม่เปิดใช้งาน — เพิ่มเมนูด้วยมือตามปกติ" };
  }
  const status = await getQuotaStatus({ organizationId: ctx.organizationId });
  return { ok: true, enabled: true, ...status };
}
