import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getResolvedCurrentPermissions } from "@/modules/auth/guards";
import { summarizeHubStatus } from "@/modules/printing/print-hub";
import { getHubStatus, getStoreHubAuth } from "@/modules/printing/print-hub-repository";
import { listPrinters } from "@/modules/stores/repository";
import {
  saveHubBluetoothPrinterAction,
  saveHubUsbPrinterAction,
  saveNetworkPrinterAction,
} from "../receipt/actions";
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
  const printers = printersRes.data ?? [];
  // Any printer the Hub can print to: LAN (IP/escpos), Bluetooth-via-Hub, or a
  // USB printer cabled to the cashier PC (printed through the Windows spooler).
  const printablePrinters = printers.filter(
    (printer) =>
      ((printer.type === "ip" || printer.type === "escpos") && printer.ipAddress) ||
      (printer.type === "bluetooth" && printer.hubBluetoothPort) ||
      (printer.type === "usb" && printer.hubUsbEnabled),
  );
  const defaultPrinter = printablePrinters.find((p) => p.isDefault) ?? printablePrinters[0] ?? null;
  const paperWidth = (defaultPrinter?.paperWidth ?? "80mm") as "58mm" | "80mm";
  const testPrinter = defaultPrinter ? { id: defaultPrinter.id, paperWidth } : null;

  return (
    <PrintHubManager
      serverUrl={serverUrl}
      storeId={ctx.storeId}
      storeName={ctx.storeName}
      hasToken={Boolean(authRes.data?.tokenHash)}
      testPrinter={testPrinter}
      printers={printers}
      paperWidth={paperWidth}
      initialStatus={{
        online: summary.online,
        secondsAgo: summary.secondsAgo,
        pendingJobs: statusRes.data?.pendingJobs ?? 0,
        claimedJobs: statusRes.data?.claimedJobs ?? 0,
        unknownJobs: statusRes.data?.unknownJobs ?? 0,
        failedJobs: statusRes.data?.failedJobs ?? 0,
        unknownJobList: statusRes.data?.unknownJobList ?? [],
        devices: statusRes.data?.devices ?? [],
      }}
      loadError={statusRes.error?.userMessage ?? null}
      saveNetworkPrinterAction={saveNetworkPrinterAction}
      saveHubBluetoothPrinterAction={saveHubBluetoothPrinterAction}
      saveHubUsbPrinterAction={saveHubUsbPrinterAction}
    />
  );
}
