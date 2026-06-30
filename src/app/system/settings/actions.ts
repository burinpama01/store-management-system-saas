"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { AuthorizationError, requireSystemAccess } from "@/modules/auth/guards";
import { createSupabaseServiceClient } from "@/server/integrations/supabase/server";
import {
  getPlatformSettings,
  updatePlatformPromptPay,
  updateEnterpriseFromEmail,
  updatePlatformLogo,
  updateJdcFunctionsBaseUrl,
} from "@/modules/billing/platform-settings";
import { sendEnterpriseTestEmail } from "@/modules/enterprise/email";

const MAX_LOGO_BYTES = 2 * 1024 * 1024;

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

  const jdcUrl = ((formData.get("jdcFunctionsBaseUrl") as string | null) ?? "").trim();
  if (jdcUrl) {
    try {
      const u = new URL(jdcUrl);
      if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error();
    } catch {
      return { ok: false, error: "URL ของ JDC Edge Functions ไม่ถูกต้อง (เช่น https://xxx.supabase.co/functions/v1)" };
    }
  }
  const jdcRes = await updateJdcFunctionsBaseUrl(jdcUrl || null, user.id);
  if (!jdcRes.ok) return { ok: false, error: jdcRes.error?.userMessage ?? "บันทึก URL ของ JDC ไม่สำเร็จ" };

  revalidatePath("/system/settings");
  return { ok: true, error: null };
}

/** Super-admin uploads the system logo (StoreOS brand mark). */
export async function uploadPlatformLogoAction(
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

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return { ok: false, error: "ไม่พบไฟล์รูป" };
  if (file.size > MAX_LOGO_BYTES) return { ok: false, error: "ไฟล์โลโก้ใหญ่เกินไป (เกิน 2MB)" };
  const contentType = file.type && file.type.startsWith("image/") ? file.type : "image/png";

  const buffer = Buffer.from(await file.arrayBuffer());
  const path = `platform/logo/${randomUUID()}/logo.png`;
  const supabase = await createSupabaseServiceClient();
  const { error } = await supabase.storage
    .from("product-images")
    .upload(path, buffer, { contentType, upsert: false });
  if (error) return { ok: false, error: error.message };

  const { data } = supabase.storage.from("product-images").getPublicUrl(path);
  const res = await updatePlatformLogo(data.publicUrl, user.id);
  if (!res.ok) return { ok: false, error: res.error?.userMessage ?? "บันทึกโลโก้ไม่สำเร็จ" };

  revalidatePath("/", "layout");
  return { ok: true, error: null };
}

export async function resetPlatformLogoAction(
  _prev: PlatformSettingsState,
): Promise<PlatformSettingsState> {
  let user;
  try {
    user = await requireSystemAccess();
  } catch (e) {
    if (e instanceof AuthorizationError) return { ok: false, error: "ต้องเป็นผู้ดูแลแพลตฟอร์ม" };
    throw e;
  }
  const res = await updatePlatformLogo(null, user.id);
  if (!res.ok) return { ok: false, error: res.error?.userMessage ?? "รีเซ็ตโลโก้ไม่สำเร็จ" };
  revalidatePath("/", "layout");
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
