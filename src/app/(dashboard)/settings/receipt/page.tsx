import { redirect } from "next/navigation";
import { getResolvedCurrentPermissions } from "@/modules/auth/guards";
import { getReceiptSettings } from "@/modules/settings/repository";
import { listPrinters } from "@/modules/stores/repository";
import { ReceiptSettingsForm } from "./ReceiptSettingsForm";
import { ReceiptTests } from "./ReceiptTests";
import { PrinterConnect } from "./PrinterConnect";
import { saveNetworkPrinterAction } from "./actions";

export const dynamic = "force-dynamic";

export default async function ReceiptSettingsPage() {
  const { ctx, resolved } = await getResolvedCurrentPermissions();
  if (!resolved.can("settings.view")) redirect("/dashboard");
  if (!resolved.can("settings.manage_store") && !resolved.can("settings.manage_printer")) redirect("/settings/store");

  const settingsRes = await getReceiptSettings(ctx.storeId, ctx.organizationId);
  const printersRes = await listPrinters(ctx.storeId, ctx.organizationId);
  const canEdit = resolved.can("settings.manage_store");

  return (
    <div className="page-shell">
      {canEdit && (
        <ReceiptSettingsForm
          settings={settingsRes.data}
          storeName={ctx.storeName}
          canEdit={canEdit}
        />
      )}
      <PrinterConnect
        printers={printersRes.data}
        printerLoadError={printersRes.error?.userMessage ?? null}
        storeName={settingsRes.data?.storeName ?? ctx.storeName}
        paperWidth={settingsRes.data?.paperWidth === "58mm" ? "58mm" : "80mm"}
        saveNetworkPrinterAction={saveNetworkPrinterAction}
      />
      {canEdit && (
        <ReceiptTests
          promptpayConfigured={Boolean(settingsRes.data?.promptpayId)}
          storeName={settingsRes.data?.storeName ?? ctx.storeName}
          paperWidth={settingsRes.data?.paperWidth === "58mm" ? "58mm" : "80mm"}
          printers={printersRes.data}
        />
      )}
    </div>
  );
}
