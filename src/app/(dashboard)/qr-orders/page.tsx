import { redirect } from "next/navigation";
import { getResolvedCurrentPermissions } from "@/modules/auth/guards";
import {
  listActiveQrOrders,
  listQrOrderHistory,
  listPendingServiceRequests,
} from "@/modules/qr-ordering/repository";
import { getStore } from "@/modules/stores/repository";
import { QrOrdersBoard } from "./QrOrdersBoard";

export const dynamic = "force-dynamic";

export default async function QrOrdersPage() {
  const { ctx, resolved } = await getResolvedCurrentPermissions();
  if (!resolved.can("orders.manage_qr")) redirect("/dashboard");

  const [activeRes, historyRes, requestsRes, storeRes] = await Promise.all([
    listActiveQrOrders(ctx.storeId),
    listQrOrderHistory(ctx.storeId, { limit: 50 }),
    listPendingServiceRequests(ctx.storeId),
    getStore(ctx.storeId),
  ]);

  return (
    <QrOrdersBoard
      storeId={ctx.storeId}
      currency={storeRes.data?.currencyCode ?? "THB"}
      initialActiveOrders={activeRes.data ?? []}
      initialHistory={historyRes.data ?? []}
      initialRequests={requestsRes.data ?? []}
    />
  );
}
