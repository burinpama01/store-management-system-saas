"use server";

import { getOptionalResolvedCurrentPermissions } from "@/modules/auth/guards";
import {
  createEnterpriseRequest,
  validateEnterpriseRequest,
} from "@/modules/enterprise/repository";

export interface EnterpriseRequestState {
  error: string | null;
  notice: string | null;
}

function parseBranchCount(value: FormDataEntryValue | null): number | null {
  const raw = ((value as string | null) ?? "").trim();
  if (!raw) return null;
  const n = Number(raw);
  return Number.isInteger(n) ? n : NaN;
}

export async function submitEnterpriseRequest(
  _prev: EnterpriseRequestState,
  formData: FormData,
): Promise<EnterpriseRequestState> {
  const branchCount = parseBranchCount(formData.get("branchCount"));
  const input = {
    companyName: ((formData.get("companyName") as string | null) ?? "").trim(),
    contactName: ((formData.get("contactName") as string | null) ?? "").trim(),
    email: ((formData.get("email") as string | null) ?? "").trim(),
    phone: ((formData.get("phone") as string | null) ?? "").trim() || null,
    branchCount: Number.isNaN(branchCount) ? undefined : branchCount,
    message: ((formData.get("message") as string | null) ?? "").trim() || null,
  };

  if (Number.isNaN(branchCount)) {
    return { error: "จำนวนสาขาไม่ถูกต้อง", notice: null };
  }

  const validation = validateEnterpriseRequest(input);
  if (!validation.valid) {
    return { error: validation.errors.join(" · "), notice: null };
  }

  // Best-effort: link the request to the submitter's organization if they are
  // logged in. Public visitors submit without one.
  let organizationId: string | null = null;
  try {
    const perms = await getOptionalResolvedCurrentPermissions();
    organizationId = perms?.ctx.organizationId ?? null;
  } catch {
    organizationId = null;
  }

  const result = await createEnterpriseRequest({ ...input, organizationId });
  if (!result.ok) {
    return { error: "ส่งคำขอไม่สำเร็จ กรุณาลองใหม่อีกครั้ง", notice: null };
  }

  return {
    error: null,
    notice: "ส่งคำขอเรียบร้อยแล้ว ทีมงาน StoreOS จะติดต่อกลับโดยเร็วที่สุด",
  };
}
