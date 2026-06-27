import { createSupabaseServiceClient } from "@/server/integrations/supabase/server";
import { mapError } from "@/shared/utils/error";

export interface PlatformPromptPaySettings {
  billingProvider: "promptpay" | "stripe";
  promptpayId: string | null;
  promptpayName: string | null;
  /** EMVCo payload decoded from an uploaded QR image (for accounts w/o a PromptPay id). */
  promptpayStaticPayload: string | null;
  /** Sender for Enterprise request emails; null falls back to ENTERPRISE_FROM_EMAIL env. */
  enterpriseFromEmail: string | null;
}

const DEFAULTS: PlatformPromptPaySettings = {
  billingProvider: "promptpay",
  promptpayId: null,
  promptpayName: null,
  promptpayStaticPayload: null,
  enterpriseFromEmail: null,
};

/** Reads the singleton platform settings row. Service-client only. */
export async function getPlatformSettings(): Promise<PlatformPromptPaySettings> {
  const supabase = await createSupabaseServiceClient();
  const { data } = await supabase
    .from("platform_settings")
    .select("billing_provider, promptpay_id, promptpay_name, promptpay_static_payload, enterprise_from_email")
    .eq("id", "singleton")
    .maybeSingle();
  if (!data) return DEFAULTS;
  return {
    billingProvider: data.billing_provider,
    promptpayId: data.promptpay_id,
    promptpayName: data.promptpay_name,
    promptpayStaticPayload: data.promptpay_static_payload,
    enterpriseFromEmail: data.enterprise_from_email,
  };
}

/**
 * Resolves the active Enterprise sender: the super-admin DB setting first, then
 * the ENTERPRISE_FROM_EMAIL / EMAIL_FROM env fallback. Returns null when neither set.
 */
export async function getEnterpriseFromEmail(): Promise<string | null> {
  const settings = await getPlatformSettings();
  const fromEnv = process.env.ENTERPRISE_FROM_EMAIL || process.env.EMAIL_FROM || null;
  return settings.enterpriseFromEmail?.trim() || fromEnv;
}

/** Updates only the Enterprise sender on the singleton row (leaves PromptPay fields intact). */
export async function updateEnterpriseFromEmail(fromEmail: string | null, actorUserId: string) {
  const supabase = await createSupabaseServiceClient();
  const { error } = await supabase.from("platform_settings").upsert(
    {
      id: "singleton",
      enterprise_from_email: fromEmail?.trim() || null,
      updated_by: actorUserId,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "id" },
  );
  if (error) return { ok: false, error: mapError(error) };
  return { ok: true, error: null };
}

/** True when PromptPay is the active SaaS payment provider (Stripe disabled). */
export async function isPromptPayActive(): Promise<boolean> {
  const settings = await getPlatformSettings();
  return settings.billingProvider === "promptpay";
}

export async function updatePlatformPromptPay(
  input: Partial<Omit<PlatformPromptPaySettings, never>>,
  actorUserId: string,
) {
  const supabase = await createSupabaseServiceClient();
  const { error } = await supabase.from("platform_settings").upsert(
    {
      id: "singleton",
      billing_provider: input.billingProvider ?? "promptpay",
      promptpay_id: input.promptpayId ?? null,
      promptpay_name: input.promptpayName ?? null,
      promptpay_static_payload: input.promptpayStaticPayload ?? null,
      updated_by: actorUserId,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "id" },
  );
  if (error) return { ok: false, error: mapError(error) };
  return { ok: true, error: null };
}
