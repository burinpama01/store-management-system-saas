import { redirect } from "next/navigation";
import { getResolvedCurrentPermissions } from "@/modules/auth/guards";
import {
  filterQrOrdersForStations,
  listActiveQrOrders,
  listQrOrderHistory,
  listPendingServiceRequests,
} from "@/modules/qr-ordering/repository";
import { listAssignedKitchenStationIdsForUser } from "@/modules/qr-ordering/kitchen-stations";
import { getStore } from "@/modules/stores/repository";
import { QrOrdersBoard } from "./QrOrdersBoard";

export const dynamic = "force-dynamic";

export default async function QrOrdersPage() {
  const { user, ctx, resolved } = await getResolvedCurrentPermissions();
  if (!resolved.can("orders.manage_qr")) redirect("/dashboard");

  const [activeRes, historyRes, requestsRes, storeRes, assignedStationsRes] = await Promise.all([
    listActiveQrOrders(ctx.storeId),
    listQrOrderHistory(ctx.storeId, { limit: 50 }),
    listPendingServiceRequests(ctx.storeId),
    getStore(ctx.storeId),
    ctx.role === "staff"
      ? listAssignedKitchenStationIdsForUser(ctx.storeId, user.id)
      : Promise.resolve({ data: [] as string[], error: null }),
  ]);
  const assignedKitchenStationIds = assignedStationsRes.data ?? [];
  const activeOrders =
    ctx.role === "staff"
      ? filterQrOrdersForStations(activeRes.data ?? [], assignedKitchenStationIds)
      : activeRes.data ?? [];
  const history =
    ctx.role === "staff"
      ? filterQrOrdersForStations(historyRes.data ?? [], assignedKitchenStationIds)
      : historyRes.data ?? [];

  return (
    <QrOrdersBoard
      storeId={ctx.storeId}
      currency={storeRes.data?.currencyCode ?? "THB"}
      initialActiveOrders={activeOrders}
      initialHistory={history}
      initialRequests={requestsRes.data ?? []}
      assignedKitchenStationIds={assignedKitchenStationIds}
      canSeeAllKitchenStations={ctx.role !== "staff"}
    />
  );
}
