"use server";

import { revalidatePath } from "next/cache";
import { getResolvedCurrentPermissions, requirePermission } from "@/modules/auth/guards";
import { parseSetupProfile } from "@/modules/onboarding/setup-profile";
import { updateStoreSetupProfile } from "@/modules/stores/repository";
import { createSupabaseServerClient } from "@/server/integrations/supabase/server";

export async function saveSetupProfileAction(input: unknown): Promise<{ ok: boolean; error: string | null }> {
  const { user, ctx } = await getResolvedCurrentPermissions();
  if (!ctx || !user) return { ok: false, error: "unauthenticated" };
  await requirePermission("settings.manage_store");

  let profile;
  try {
    profile = parseSetupProfile(input);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "invalid_profile" };
  }

  const supabase = await createSupabaseServerClient();
  const before = await supabase
    .from("stores")
    .select("setup_profile")
    .eq("id", ctx.storeId)
    .eq("organization_id", ctx.organizationId)
    .maybeSingle();
  if (before.error) return { ok: false, error: before.error.message };

  const result = await updateStoreSetupProfile(ctx.storeId, ctx.organizationId, profile);
  if (!result.ok) return { ok: false, error: result.error };

  await supabase.from("audit_logs").insert({
    organization_id: ctx.organizationId,
    store_id: ctx.storeId,
    actor_user_id: user.id,
    target_user_id: null,
    action: "store.setup_profile.update",
    reason: `setup_profile ${JSON.stringify(before.data?.setup_profile ?? null)} → ${JSON.stringify(profile)}`,
  });

  revalidatePath("/onboarding");
  return { ok: true, error: null };
}