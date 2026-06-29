"use server";

import { revalidatePath } from "next/cache";
import { AuthorizationError, requireSystemAccess } from "@/modules/auth/guards";
import { updateMusicLicense } from "@/modules/music-requests/license-repository";
import type { MusicLicenseStatus } from "@/modules/stores/types";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SETTABLE: MusicLicenseStatus[] = ["approved", "rejected", "expired", "pending"];

export async function updateMusicLicenseAction(fd: FormData): Promise<void> {
  try {
    await requireSystemAccess();
  } catch (e) {
    if (e instanceof AuthorizationError) return;
    throw e;
  }

  const storeId = (fd.get("storeId") as string | null) ?? "";
  const status = (fd.get("status") as string | null) ?? "";
  const note = ((fd.get("note") as string | null) ?? "").trim() || null;
  if (!UUID_RE.test(storeId)) return;
  if (!SETTABLE.includes(status as MusicLicenseStatus)) return;

  await updateMusicLicense(storeId, status as MusicLicenseStatus, note);
  revalidatePath("/system/music-licenses");
}
