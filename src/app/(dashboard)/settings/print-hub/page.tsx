import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getResolvedCurrentPermissions } from "@/modules/auth/guards";
import { summarizeHubStatus } from "@/modules/printing/print-hub";
import { getHubStatus, getStoreHubAuth } from "@/modules/printing/print-hub-repository";
import { listPrinters } from "@/modules/stores/repository";
import { PrintHubManager } from "./PrintHubManager";

export const dynamic = "force-dynamic";

export default async function PrintHubSettingsPage() {
  const { ctx, resolved } = await getResolvedCurrentPermissions();
  if (!resolved.can("settings.view")) redirect("/dashboard");
  if (!resolved.can("settings.manage_printer") && !resolved.can("settings.manage_store")) {
    redirect("/settings/receipt");
  }

  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "store-os-manage.vercel.app";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https");
  const serverUrl = `${proto}://${host}`;

  const [statusRes, authRes, printersRes] = await Promise.all([
    getHubStatus(ctx.storeId),
    getStoreHubAuth(ctx.storeId),
    listPrinters(ctx.storeId, ctx.organizationId),
  ]);

  const summary = summarizeHubStatus(statusRes.data?.lastSeen ?? null);
  const hasNetworkPrinter = (printersRes.data ?? []).some(
    (printer) => (printer.type === "ip" || printer.type === "escpos") && printer.ipAddress,
  );

  return (
    <PrintHubManager
      serverUrl={serverUrl}
      storeId={ctx.storeId}
      hasToken={Boolean(authRes.data?.tokenHash)}
      hasNetworkPrinter={hasNetworkPrinter}
      initialStatus={{
        online: summary.online,
        secondsAgo: summary.secondsAgo,
        pendingJobs: statusRes.data?.pendingJobs ?? 0,
      }}
      loadError={statusRes.error?.userMessage ?? null}
    />
  );
}
