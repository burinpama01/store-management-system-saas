import { redirect } from "next/navigation";
import { getResolvedCurrentPermissions } from "@/modules/auth/guards";
import {
  filterQrOrdersForStations,
  listActiveQrOrders,
  listQrOrderHistory,
  listPendingServiceRequests,
} from "@/modules/qr-ordering/repository";
import { resolveKitchenStationScope } from "@/modules/qr-ordering/kitchen-stations";
import { getStore } from "@/modules/stores/repository";
import { QrOrdersBoard } from "./QrOrdersBoard";

export const dynamic = "force-dynamic";

export default async function QrOrdersPage() {
  const { user, ctx, resolved } = await getResolvedCurrentPermissions();
  if (!resolved.can("orders.manage_qr")) redirect("/dashboard");

  const [activeRes, historyRes, requestsRes, storeRes, scope] = await Promise.all([
    listActiveQrOrders(ctx.storeId),
    listQrOrderHistory(ctx.storeId, { limit: 50 }),
    listPendingServiceRequests(ctx.storeId),
    getStore(ctx.storeId),
    resolveKitchenStationScope(ctx.storeId, user.id, ctx.role),
  ]);
  const assignedKitchenStationIds = scope.stationIds;
  const activeOrders = scope.canSeeAll
    ? activeRes.data ?? []
    : filterQrOrdersForStations(activeRes.data ?? [], assignedKitchenStationIds);
  const history = scope.canSeeAll
    ? historyRes.data ?? []
    : filterQrOrdersForStations(historyRes.data ?? [], assignedKitchenStationIds);

  return (
    <QrOrdersBoard
      storeId={ctx.storeId}
      currency={storeRes.data?.currencyCode ?? "THB"}
      initialActiveOrders={activeOrders}
      initialHistory={history}
      initialRequests={requestsRes.data ?? []}
      assignedKitchenStationIds={assignedKitchenStationIds}
      canSeeAllKitchenStations={scope.canSeeAll}
    />
  );
}
