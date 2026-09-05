import { redirect } from "next/navigation";
import { getResolvedCurrentPermissions } from "@/modules/auth/guards";
import { getStore } from "@/modules/stores/repository";
import { listStoreMemberships } from "@/modules/settings/repository";
import { listVoiceAliases } from "@/modules/voice-pos/alias-repository";
import { listProducts } from "@/modules/catalog/repository";
import { suggestVoiceAliases } from "@/modules/voice-pos/alias-suggest";
import { VoiceAliasManager } from "./VoiceAliasManager";

export const dynamic = "force-dynamic";

export default async function VoiceSettingsPage() {
  const { ctx, resolved } = await getResolvedCurrentPermissions();
  if (!resolved.can("settings.view")) redirect("/dashboard");
  if (!resolved.can("settings.manage_store")) redirect("/settings/store");

  const [aliasesRes, storeRes, membersRes, productsRes] = await Promise.all([
    listVoiceAliases(ctx.storeId),
    getStore(ctx.storeId),
    listStoreMemberships(ctx.organizationId, ctx.storeId),
    listProducts(ctx.storeId, { includeInactive: false }),
  ]);

  const aliases = aliasesRes.data ?? [];
  const products = productsRes.data ?? [];
  // วิเคราะห์ชื่อเมนูให้อัตโนมัติ แล้วให้ผู้ใช้ติ๊กเลือกก่อนบันทึกเสมอ
  const suggestions = suggestVoiceAliases(
    products.map((product) => ({ id: product.id, name: product.name, isActive: product.isActive })),
    aliases.map((alias) => alias.aliasText),
  );
  const productNameById: Record<string, string> = {};
  for (const product of products) productNameById[product.id] = product.name;

  const memberEmails: Record<string, string> = {};
  for (const member of membersRes.data ?? []) {
    memberEmails[member.userId] = member.email;
  }

  return (
    <VoiceAliasManager
      aliases={aliases}
      suggestions={suggestions}
      productNameById={productNameById}
      voiceEnabled={storeRes.data?.voiceCommandEnabled ?? false}
      aiFallbackEnabled={storeRes.data?.voiceAiFallbackEnabled ?? false}
      loadError={aliasesRes.error?.userMessage ?? null}
      memberEmails={memberEmails}
    />
  );
}
