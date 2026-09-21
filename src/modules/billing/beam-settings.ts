import { createSupabaseServiceClient } from "@/server/integrations/supabase/server";
import { decodeBeamCredentials, encodeBeamCredentials, maskSecret } from "@/modules/payments/credentials";
import { pingBeamCredentials } from "@/modules/payments/beam-client";
import { isPlausibleBeamHmacKey } from "@/modules/payments/beam-signature";
import { isSlip2goConfigured } from "./slip2go";

export async function getPlatformBeamSettings() {
  const db = await createSupabaseServiceClient();
  const { data, error } = await db.from("platform_settings")
    .select("billing_provider, beam_environment, beam_credentials_encrypted, beam_fallback_enabled, beam_fallback_account, promptpay_id, promptpay_static_payload")
    .eq("id", "singleton").single();
  if (error || !data) throw new Error("อ่านการตั้งค่า Beam ไม่สำเร็จ ตรวจว่า migration พร้อมแล้ว");
  return { ...data, creds: decodeBeamCredentials(data.beam_credentials_encrypted) };
}

export async function getPlatformBeamPublicSettings() {
  const s = await getPlatformBeamSettings();
  return { enabled: s.billing_provider === "beam", environment: s.beam_environment,
    merchantMasked: maskSecret(s.creds?.merchantId), configured: Boolean(s.creds),
    hasHmacKey: Boolean(s.creds?.webhookHmacKey), fallbackEnabled: s.beam_fallback_enabled,
    fallbackAccount: s.beam_fallback_account ?? "" };
}

export type PlatformBeamPublicSettings = Awaited<ReturnType<typeof getPlatformBeamPublicSettings>>;

export async function savePlatformBeamSettings(form: FormData, actorId: string, testOnly = false) {
  const current = await getPlatformBeamSettings();
  const value = (key: string) => typeof form.get(key) === "string" ? String(form.get(key)).trim() : "";
  const environment = value("environment");
  if (environment !== "test" && environment !== "live") throw new Error("สภาพแวดล้อมไม่ถูกต้อง");
  const enabled = form.get("enabled") === "on";
  const fallbackEnabled = form.get("fallbackEnabled") === "on";
  const merchantId = value("merchantId") || current.creds?.merchantId || "";
  const apiKey = value("apiKey") || current.creds?.apiKey || "";
  const webhookHmacKey = value("webhookHmacKey") || current.creds?.webhookHmacKey || null;
  if ((environment !== current.beam_environment || (value("merchantId") && merchantId !== current.creds?.merchantId)) && (!value("merchantId") || !value("apiKey") || !value("webhookHmacKey"))) {
    throw new Error("เมื่อเปลี่ยนบัญชีหรือสภาพแวดล้อม ต้องกรอก Merchant ID, API key และ HMAC key ชุดใหม่ครบ");
  }
  if ((enabled || testOnly) && (!/^[A-Za-z0-9_-]{4,64}$/.test(merchantId) || !apiKey || !webhookHmacKey || !isPlausibleBeamHmacKey(webhookHmacKey))) {
    throw new Error("กรุณาตั้ง Merchant ID, API key และ Webhook HMAC key ให้ครบ");
  }
  const fallbackAccount = value("fallbackAccount").replace(/[\s-]/g, "");
  if (fallbackEnabled && (!/^\d{6,20}$/.test(fallbackAccount) || !isSlip2goConfigured() || !(current.promptpay_id || current.promptpay_static_payload))) {
    throw new Error("Fallback ต้องมี QR รับเงินเดิม เลขบัญชีธนาคารผู้รับเต็ม และ Slip2Go พร้อมใช้งาน");
  }
  if (testOnly) {
    const result = await pingBeamCredentials({ environment, creds: { merchantId, apiKey, webhookHmacKey } });
    if (!result.ok) throw new Error("ทดสอบ Beam ไม่สำเร็จ ตรวจบัญชีและสภาพแวดล้อม");
    return;
  }
  const encoded = merchantId && apiKey ? encodeBeamCredentials({ merchantId, apiKey, webhookHmacKey }) : current.beam_credentials_encrypted;
  const db = await createSupabaseServiceClient();
  const { error } = await db.from("platform_settings").update({
    billing_provider: enabled ? "beam" : "promptpay", beam_environment: environment,
    beam_credentials_encrypted: encoded, beam_fallback_enabled: fallbackEnabled,
    beam_fallback_account: fallbackAccount || null, updated_by: actorId, updated_at: new Date().toISOString(),
  }).eq("id", "singleton");
  if (error) throw new Error("บันทึก Beam ไม่สำเร็จ");
}
