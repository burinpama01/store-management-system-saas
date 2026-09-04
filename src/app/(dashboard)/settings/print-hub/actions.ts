"use server";

import { revalidatePath } from "next/cache";
import { getResolvedCurrentPermissions } from "@/modules/auth/guards";
import { resolveUnknownPrintJob, rotateHubToken } from "@/modules/printing/print-hub-repository";
import { logSystemEvent } from "@/modules/system/event-log";

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

/**
 * v3 Task 6 — คนตัดสินผลของงานพิมพ์ที่ระบบไม่รู้ผล (สถานะ unknown)
 * ระบบไม่เดาให้เอง: เดาว่า "ออกแล้ว" ผิด = ใบเสร็จหาย, เดาว่า "ไม่ออก" ผิด = พิมพ์ซ้ำ
 * จึงต้องให้คนที่เห็นกระดาษจริงเป็นผู้ตัดสิน แล้วบันทึกไว้ว่าใครตัดสินและตัดสินว่าอะไร
 */
export async function resolveUnknownPrintJobAction(
  _prev: { error: string | null; done?: boolean },
  formData: FormData,
): Promise<{ error: string | null; done?: boolean }> {
  try {
    const ctx = await requirePrinterAccess();
    const jobId = String(formData.get("jobId") ?? "").trim();
    const resolution = String(formData.get("resolution") ?? "");
    if (!jobId) return { error: "ไม่พบงานพิมพ์ที่ต้องการจัดการ" };
    if (resolution !== "printed_confirmed" && resolution !== "retried") {
      return { error: "ตัวเลือกไม่ถูกต้อง" };
    }

    const result = await resolveUnknownPrintJob({
      jobId,
      storeId: ctx.storeId,
      resolution,
      userId: ctx.userId ?? null,
    });
    if (result.error || !result.data) {
      return { error: result.error?.userMessage ?? "จัดการงานพิมพ์ไม่สำเร็จ" };
    }

    await logSystemEvent({
      level: "info",
      source: "printing.hub",
      action: "resolveUnknownPrintJob",
      message:
        resolution === "printed_confirmed"
          ? "ผู้ใช้ยืนยันว่าใบพิมพ์ออกแล้ว — ปิดงานที่ไม่ทราบผล"
          : "ผู้ใช้สั่งพิมพ์งานที่ไม่ทราบผลใหม่",
      organizationId: ctx.organizationId,
      storeId: ctx.storeId,
      context: { jobId, resolution, newStatus: result.data.status },
    });

    revalidatePath("/settings/print-hub");
    return { error: null, done: true };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "เกิดข้อผิดพลาด" };
  }
}
