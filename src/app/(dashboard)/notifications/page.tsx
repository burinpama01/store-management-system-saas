import { redirect } from "next/navigation";
import { getResolvedCurrentPermissions } from "@/modules/auth/guards";
import { listNotifications } from "@/modules/notifications/repository";
import { NotificationCenter } from "./NotificationCenter";

export const dynamic = "force-dynamic";

export default async function NotificationsPage() {
  const { ctx, resolved } = await getResolvedCurrentPermissions();
  if (!ctx) redirect("/login");
  if (!resolved.can("reports.view")) redirect("/dashboard");

  const { data } = await listNotifications(ctx.storeId, { limit: 200 });

  return (
    <NotificationCenter
      storeId={ctx.storeId}
      storeName={ctx.storeName}
      initialNotifications={data ?? []}
    />
  );
}
