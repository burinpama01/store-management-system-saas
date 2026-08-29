"use server";

import { redirect } from "next/navigation";
import { getResolvedCurrentPermissions } from "@/modules/auth/guards";
import { listCategories } from "@/modules/catalog/repository";

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