import { redirect } from "next/navigation";
import { getResolvedCurrentPermissions } from "@/modules/auth/guards";
import { listPrinters } from "@/modules/stores/repository";
import { DeviceCenter } from "./DeviceCenter";

export const dynamic = "force-dynamic";

export default async function DevicesPage() {
  const { ctx, resolved } = await getResolvedCurrentPermissions();
  if (!ctx) redirect("/login");
  if (!resolved.can("settings.manage_printer") && !resolved.can("settings.manage_store")) {
    redirect("/dashboard");
  }
  const printersRes = await listPrinters(ctx.storeId, ctx.organizationId);
  const hasNetworkPrinter = (printersRes.data ?? []).some(
    (printer) => (printer.type === "ip" || printer.type === "escpos") && printer.ipAddress,
  );
  return <DeviceCenter hasNetworkPrinter={hasNetworkPrinter} />;
}