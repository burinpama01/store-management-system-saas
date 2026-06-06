import { createSupabaseServiceClient } from "@/server/integrations/supabase/server";
import { mapError } from "@/shared/utils/error";

export interface PlatformPromptPaySettings {
  billingProvider: "promptpay" | "stripe";
  promptpayId: string | null;
  promptpayName: string | null;
  promptpayQrImagePath: string | null;
}

const DEFAULTS: PlatformPromptPaySettings = {
  billingProvider: "promptpay",
  promptpayId: null,
  promptpayName: null,
  promptpayQrImagePath: null,
};

/** Reads the singleton platform settings row. Service-client only. */
export async function getPlatformSettings(): Promise<PlatformPromptPaySettings> {
  const supabase = await createSupabaseServiceClient();
  const { data } = await supabase
    .from("platform_settings")
    .select("billing_provider, promptpay_id, promptpay_name, promptpay_qr_image_path")
    .eq("id", "singleton")
    .maybeSingle();
  if (!data) return DEFAULTS;
  return {
    billingProvider: data.billing_provider,
    promptpayId: data.promptpay_id,
    promptpayName: data.promptpay_name,
    promptpayQrImagePath: data.promptpay_qr_image_path,
  };
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
      promptpay_qr_image_path: input.promptpayQrImagePath ?? null,
      updated_by: actorUserId,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "id" },
  );
  if (error) return { ok: false, error: mapError(error) };
  return { ok: true, error: null };
}
