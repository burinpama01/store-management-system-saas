import { redirect } from "next/navigation";
import { getResolvedCurrentPermissions } from "@/modules/auth/guards";
import { getStore } from "@/modules/stores/repository";
import { listStoreMemberships } from "@/modules/settings/repository";
import { listVoiceAliases } from "@/modules/voice-pos/alias-repository";
import { VoiceAliasManager } from "./VoiceAliasManager";

export const dynamic = "force-dynamic";

export default async function VoiceSettingsPage() {
  const { ctx, resolved } = await getResolvedCurrentPermissions();
  if (!resolved.can("settings.view")) redirect("/dashboard");
  if (!resolved.can("settings.manage_store")) redirect("/settings/store");

  const [aliasesRes, storeRes, membersRes] = await Promise.all([
    listVoiceAliases(ctx.storeId),
    getStore(ctx.storeId),
    listStoreMemberships(ctx.organizationId, ctx.storeId),
  ]);

  const memberEmails: Record<string, string> = {};
  for (const member of membersRes.data ?? []) {
    memberEmails[member.userId] = member.email;
  }

  return (
    <VoiceAliasManager
      aliases={aliasesRes.data ?? []}
      voiceEnabled={storeRes.data?.voiceCommandEnabled ?? false}
      loadError={aliasesRes.error?.userMessage ?? null}
      memberEmails={memberEmails}
    />
  );
}
