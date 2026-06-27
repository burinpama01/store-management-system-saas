"use server";

import { after } from "next/server";
import { AuthorizationError, getResolvedCurrentPermissions } from "@/modules/auth/guards";
import {
  createEnterpriseRequest,
  validateEnterpriseRequest,
} from "@/modules/enterprise/repository";
import { sendEnterpriseSubmittedEmail } from "@/modules/enterprise/email";

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
  // Enterprise requests require a logged-in tenant so we can attach the org and
  // track status in their dashboard. Middleware already gates the page; re-check here.
  let organizationId: string;
  try {
    const { ctx } = await getResolvedCurrentPermissions();
    organizationId = ctx.organizationId;
  } catch (e) {
    if (e instanceof AuthorizationError) {
      return { error: "กรุณาเข้าสู่ระบบก่อนส่งคำขอ Enterprise", notice: null };
    }
    throw e;
  }

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

  const result = await createEnterpriseRequest({ ...input, organizationId });
  if (!result.ok) {
    return { error: "ส่งคำขอไม่สำเร็จ กรุณาลองใหม่อีกครั้ง", notice: null };
  }

  // Best-effort confirmation email; never block or fail the submission on it.
  after(async () => {
    try {
      await sendEnterpriseSubmittedEmail({ to: input.email, companyName: input.companyName });
    } catch {
      // email is non-critical
    }
  });

  return {
    error: null,
    notice: "ส่งคำขอเรียบร้อยแล้ว เราได้ส่งอีเมลยืนยันถึงคุณ และทีมงาน StoreOS จะติดต่อกลับโดยเร็วที่สุด",
  };
}
