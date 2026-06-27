"use server";

import { revalidatePath } from "next/cache";
import { AuthorizationError, requireSystemAccess } from "@/modules/auth/guards";
import {
  getPlatformSettings,
  updatePlatformPromptPay,
  updateEnterpriseFromEmail,
} from "@/modules/billing/platform-settings";
import { sendEnterpriseTestEmail } from "@/modules/enterprise/email";

export interface PlatformSettingsState {
  error: string | null;
  ok: boolean;
}

export interface TestEmailState {
  error: string | null;
  notice: string | null;
}

/** Loosely accepts "email@domain" or "Display Name <email@domain>". */
function looksLikeSender(value: string): boolean {
  const match = value.match(/<([^>]+)>/);
  const addr = (match ? match[1] : value).trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr);
}

export async function updatePlatformSettingsAction(
  _prev: PlatformSettingsState,
  formData: FormData,
): Promise<PlatformSettingsState> {
  let user;
  try {
    user = await requireSystemAccess();
  } catch (e) {
    if (e instanceof AuthorizationError) return { ok: false, error: "ต้องเป็นผู้ดูแลแพลตฟอร์ม" };
    throw e;
  }

  const billingProvider = formData.get("billingProvider") === "stripe" ? "stripe" : "promptpay";
  const promptpayId = ((formData.get("promptpayId") as string | null) ?? "").trim() || null;
  const promptpayName = ((formData.get("promptpayName") as string | null) ?? "").trim() || null;

  // Preserve the decoded static payload (uploaded separately) unless explicitly cleared.
  const existing = await getPlatformSettings();
  const staticPayload =
    formData.get("clearStaticPayload") === "1" ? null : existing.promptpayStaticPayload;

  const res = await updatePlatformPromptPay(
    { billingProvider, promptpayId, promptpayName, promptpayStaticPayload: staticPayload },
    user.id,
  );
  if (!res.ok) return { ok: false, error: res.error?.userMessage ?? "บันทึกไม่สำเร็จ" };

  const enterpriseFromEmail = ((formData.get("enterpriseFromEmail") as string | null) ?? "").trim();
  if (enterpriseFromEmail && !looksLikeSender(enterpriseFromEmail)) {
    return { ok: false, error: "อีเมลผู้ส่ง Enterprise ไม่ถูกต้อง (เช่น StoreOS <no-reply@yourdomain.com>)" };
  }
  const emailRes = await updateEnterpriseFromEmail(enterpriseFromEmail || null, user.id);
  if (!emailRes.ok) return { ok: false, error: emailRes.error?.userMessage ?? "บันทึกอีเมลผู้ส่งไม่สำเร็จ" };

  revalidatePath("/system/settings");
  return { ok: true, error: null };
}

export async function sendTestEnterpriseEmailAction(
  _prev: TestEmailState,
  formData: FormData,
): Promise<TestEmailState> {
  try {
    await requireSystemAccess();
  } catch (e) {
    if (e instanceof AuthorizationError) return { error: "ต้องเป็นผู้ดูแลแพลตฟอร์ม", notice: null };
    throw e;
  }

  const to = ((formData.get("testEmail") as string | null) ?? "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
    return { error: "อีเมลปลายทางไม่ถูกต้อง", notice: null };
  }

  const result = await sendEnterpriseTestEmail({ to });
  if (result.skipped) {
    return { error: "ยังส่งไม่ได้: ยังไม่ได้ตั้งค่าผู้ส่ง (RESEND_API_KEY และอีเมลผู้ส่ง)", notice: null };
  }
  if (!result.ok) {
    return { error: `ส่งไม่สำเร็จ: ${result.message}`, notice: null };
  }
  return { error: null, notice: `ส่งอีเมลทดสอบไปที่ ${to} แล้ว — ตรวจกล่องจดหมาย (รวม Spam)` };
}
