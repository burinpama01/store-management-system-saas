import { redirect } from "next/navigation";
import { getResolvedCurrentPermissions } from "@/modules/auth/guards";
import { getReceiptSettings } from "@/modules/settings/repository";
import { ReceiptSettingsForm } from "./ReceiptSettingsForm";
import { ReceiptTests } from "./ReceiptTests";
import { PrinterConnect } from "./PrinterConnect";

export const dynamic = "force-dynamic";

export default async function ReceiptSettingsPage() {
  const { ctx, resolved } = await getResolvedCurrentPermissions();
  if (!resolved.can("settings.view")) redirect("/dashboard");

  const settingsRes = await getReceiptSettings(ctx.storeId, ctx.organizationId);
  const canEdit = resolved.can("settings.manage_store");

  return (
    <div className="page-shell">
      <ReceiptSettingsForm
        settings={settingsRes.data}
        storeName={ctx.storeName}
        canEdit={canEdit}
      />
      <PrinterConnect />
      <ReceiptTests
        promptpayConfigured={Boolean(settingsRes.data?.promptpayId)}
        storeName={settingsRes.data?.storeName ?? ctx.storeName}
        paperWidth={settingsRes.data?.paperWidth === "58mm" ? "58mm" : "80mm"}
      />
    </div>
  );
}
