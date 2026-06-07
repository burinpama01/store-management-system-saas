"use server";

import { revalidatePath } from "next/cache";
import { AuthorizationError, getResolvedCurrentPermissions } from "@/modules/auth/guards";
import { createBuffetPackage, setBuffetPackageActive } from "@/modules/buffet/repository";

export interface BuffetSettingsState {
  error: string | null;
  ok: boolean;
}

export async function createBuffetPackageAction(
  _prev: BuffetSettingsState,
  fd: FormData,
): Promise<BuffetSettingsState> {
  try {
    const { ctx, resolved } = await getResolvedCurrentPermissions();
    if (!resolved.can("settings.manage_store")) return { ok: false, error: "ไม่มีสิทธิ์แก้ไขร้าน" };

    const name = ((fd.get("name") as string | null) ?? "").trim();
    const pricePerGuest = Number(fd.get("pricePerGuest"));
    const durationRaw = (fd.get("durationMinutes") as string | null) ?? "";
    const durationMinutes = durationRaw.trim() ? Number(durationRaw) : null;
    if (!name) return { ok: false, error: "กรุณากรอกชื่อแพ็กเกจ" };
    if (!Number.isFinite(pricePerGuest) || pricePerGuest < 0) return { ok: false, error: "ราคาต่อหัวไม่ถูกต้อง" };
    if (durationMinutes != null && (!Number.isInteger(durationMinutes) || durationMinutes < 15 || durationMinutes > 600)) {
      return { ok: false, error: "ระยะเวลาต้องอยู่ระหว่าง 15–600 นาที" };
    }

    const res = await createBuffetPackage({
      organizationId: ctx.organizationId,
      storeId: ctx.storeId,
      name,
      pricePerGuest,
      durationMinutes,
    });
    if (!res.ok) return { ok: false, error: res.error?.userMessage ?? "บันทึกไม่สำเร็จ" };
    revalidatePath("/settings/buffet");
    return { ok: true, error: null };
  } catch (e) {
    if (e instanceof AuthorizationError) return { ok: false, error: "ไม่มีสิทธิ์" };
    throw e;
  }
}

export async function toggleBuffetPackageAction(fd: FormData): Promise<void> {
  try {
    const { ctx, resolved } = await getResolvedCurrentPermissions();
    if (!resolved.can("settings.manage_store")) return;
    const id = (fd.get("id") as string | null) ?? "";
    const active = fd.get("active") === "1";
    if (!id) return;
    await setBuffetPackageActive(id, ctx.storeId, active);
    revalidatePath("/settings/buffet");
  } catch (e) {
    if (e instanceof AuthorizationError) return;
    throw e;
  }
}
