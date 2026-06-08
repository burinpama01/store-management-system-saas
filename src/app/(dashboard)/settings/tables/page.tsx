import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { getResolvedCurrentPermissions } from "@/modules/auth/guards";
import { listManagedTables, getStore } from "@/modules/stores/repository";
import { TablesManager } from "./TablesManager";

export const dynamic = "force-dynamic";

export default async function TablesSettingsPage() {
  const { ctx, resolved } = await getResolvedCurrentPermissions();
  if (!resolved.can("settings.view")) redirect("/dashboard");

  const [tablesRes, storeRes, h] = await Promise.all([
    listManagedTables(ctx.storeId),
    getStore(ctx.storeId),
    headers(),
  ]);

  const host = h.get("host") ?? "";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const baseUrl = host ? `${proto}://${host}` : "";

  return (
    <TablesManager
      tables={tablesRes.data ?? []}
      storeSlug={storeRes.data?.slug ?? ""}
      qrOrderingEnabled={storeRes.data?.qrOrderingEnabled ?? false}
      baseUrl={baseUrl}
    />
  );
}
