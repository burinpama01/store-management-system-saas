import { redirect } from "next/navigation";
import { getUserStores } from "@/modules/auth/session";
import { getResolvedCurrentPermissions } from "@/modules/auth/guards";
import { listBuffetSessions, listStoreTables } from "@/modules/buffet/repository";
import { getStoreLocalDate } from "@/modules/attendance/date";
import { BuffetManager } from "./BuffetManager";

export const dynamic = "force-dynamic";

export default async function BuffetPage() {
  const { ctx, resolved } = await getResolvedCurrentPermissions();
  const { stores } = await getUserStores();

  const storeRow = stores.find((s) => s.id === ctx.storeId);
  if (!storeRow?.buffet_enabled) redirect("/dashboard");

  if (!resolved.can("orders.manage_qr")) redirect("/dashboard");

  const today = getStoreLocalDate(ctx.storeTimezone);

  const [openRes, closedRes, tablesRes] = await Promise.all([
    listBuffetSessions(ctx.storeId, { status: "open" }),
    // Filter closed sessions to today at the DB layer to avoid transferring full history.
    listBuffetSessions(ctx.storeId, { status: "closed", startedAfter: today }),
    listStoreTables(ctx.storeId),
  ]);

  return (
    <BuffetManager
      openSessions={openRes.data ?? []}
      closedToday={closedRes.data ?? []}
      tables={tablesRes.data ?? []}
      canManage={resolved.can("orders.manage_qr")}
      storeTimezone={ctx.storeTimezone}
    />
  );
}
