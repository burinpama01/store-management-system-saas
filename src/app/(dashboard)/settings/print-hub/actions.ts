"use server";

import { revalidatePath } from "next/cache";
import { getResolvedCurrentPermissions } from "@/modules/auth/guards";
import { rotateHubToken } from "@/modules/printing/print-hub-repository";

async function requirePrinterAccess() {
  const { ctx, resolved } = await getResolvedCurrentPermissions();
  if (!resolved.can("settings.manage_printer") && !resolved.can("settings.manage_store")) {
    throw new Error("ไม่มีสิทธิ์จัดการเครื่องพิมพ์");
  }
  return ctx;
}

/** Generates a fresh Hub token and returns it once for the operator to copy. */
export async function rotateHubTokenAction(): Promise<{ error: string | null; token?: string }> {
  try {
    const ctx = await requirePrinterAccess();
    const result = await rotateHubToken(ctx.storeId);
    if (result.error || !result.data) return { error: result.error?.userMessage ?? "สร้างโทเค็นไม่สำเร็จ" };
    revalidatePath("/settings/print-hub");
    return { error: null, token: result.data.token };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "เกิดข้อผิดพลาด" };
  }
}
