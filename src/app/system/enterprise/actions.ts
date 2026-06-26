"use server";

import { revalidatePath } from "next/cache";
import { AuthorizationError, requireSystemAccess } from "@/modules/auth/guards";
import {
  updateEnterpriseRequestStatus,
  type EnterpriseRequestStatus,
} from "@/modules/enterprise/repository";

const VALID_STATUSES: EnterpriseRequestStatus[] = ["new", "contacted", "closed"];

export async function updateEnterpriseStatusAction(fd: FormData): Promise<void> {
  try {
    await requireSystemAccess();
  } catch (e) {
    if (e instanceof AuthorizationError) return;
    throw e;
  }

  const id = (fd.get("id") as string | null) ?? "";
  const status = (fd.get("status") as string | null) ?? "";
  if (!id || !VALID_STATUSES.includes(status as EnterpriseRequestStatus)) return;

  await updateEnterpriseRequestStatus(id, status as EnterpriseRequestStatus);
  revalidatePath("/system/enterprise");
}
