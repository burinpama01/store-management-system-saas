"use server";

import { revalidatePath } from "next/cache";
import { getResolvedCurrentPermissions } from "@/modules/auth/guards";
import { parsePrintMode, setStorePrintMode } from "@/modules/printing/direct-print-repository";
import { logSystemEvent } from "@/modules/system/event-log";

export interface PrintModeState {
  readonly error: string | null;
  readonly saved: boolean;
}

/** เปลี่ยนวิธีพิมพ์ของร้าน (เฟส D3) — ต้องมีสิทธิ์ตั้งค่าเครื่องพิมพ์ */
export async function savePrintModeAction(_prev: PrintModeState, formData: FormData): Promise<PrintModeState> {
  const { ctx, resolved } = await getResolvedCurrentPermissions();
  if (!resolved.can("settings.manage_printer")) return { error: "ต้องมีสิทธิ์ตั้งค่าเครื่องพิมพ์", saved: false };
  const mode = parsePrintMode(formData.get("printMode"));
  const result = await setStorePrintMode(ctx.storeId, ctx.organizationId, mode);
  void logSystemEvent({
    level: result.error ? "error" : "info",
    source: "printing.direct",
    action: "set_print_mode",
    message: result.error ? `เปลี่ยนวิธีพิมพ์ไม่สำเร็จ: ${result.error}` : `เปลี่ยนวิธีพิมพ์ของร้านเป็น ${mode === "direct" ? "พิมพ์ตรงจาก StoreOS POS" : "Print Hub"}`,
    organizationId: ctx.organizationId,
    storeId: ctx.storeId,
    actorUserId: ctx.userId,
    context: { printMode: mode },
  });
  if (result.error) return { error: "บันทึกไม่สำเร็จ ลองใหม่อีกครั้ง", saved: false };
  revalidatePath("/settings/receipt");
  return { error: null, saved: true };
}
