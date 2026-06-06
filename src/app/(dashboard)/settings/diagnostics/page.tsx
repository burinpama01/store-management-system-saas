import { redirect } from "next/navigation";
import { getResolvedCurrentPermissions } from "@/modules/auth/guards";
import { DiagnosticsPanel } from "./DiagnosticsPanel";

export const dynamic = "force-dynamic";

export default async function DiagnosticsPage() {
  const { ctx, resolved } = await getResolvedCurrentPermissions();
  if (!resolved.can("settings.view")) redirect("/");

  const canRunDiagnostics =
    resolved.can("settings.manage_store") ||
    resolved.can("notifications.manage") ||
    resolved.can("billing.manage");

  return (
    <DiagnosticsPanel
      storeName={ctx.storeName}
      role={ctx.role}
      canRunDiagnostics={canRunDiagnostics}
      canRunNotificationDiagnostic={resolved.can("notifications.manage")}
    />
  );
}
