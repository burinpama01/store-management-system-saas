import { redirect } from "next/navigation";
import { getResolvedCurrentPermissions } from "@/modules/auth/guards";
import { getReceiptSettings } from "@/modules/settings/repository";
import { ReceiptSettingsForm } from "./ReceiptSettingsForm";

export const dynamic = "force-dynamic";

export default async function ReceiptSettingsPage() {
  const { ctx, resolved } = await getResolvedCurrentPermissions();
  if (!resolved.can("settings.view")) redirect("/");

  const settingsRes = await getReceiptSettings(ctx.storeId, ctx.organizationId);
  const canEdit = resolved.can("settings.manage_store");

  return (
    <ReceiptSettingsForm
      settings={settingsRes.data}
      storeName={ctx.storeName}
      canEdit={canEdit}
    />
  );
}
