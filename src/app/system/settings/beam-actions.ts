"use server";
import { revalidatePath } from "next/cache";
import { requireSystemAccess } from "@/modules/auth/guards";
import { savePlatformBeamSettings } from "@/modules/billing/beam-settings";

export async function saveBeamBillingAction(form: FormData, testOnly = false) {
  await requireSystemAccess();
  try {
    const user = await requireSystemAccess();
    await savePlatformBeamSettings(form, user.id, testOnly);
    if (!testOnly) { revalidatePath("/system/settings"); revalidatePath("/settings/billing"); }
    return { ok: true, message: testOnly ? "เชื่อมต่อ Beam สำเร็จ" : "บันทึก Beam สำหรับค่าแพ็กเกจแล้ว" };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "ดำเนินการไม่สำเร็จ" };
  }
}
