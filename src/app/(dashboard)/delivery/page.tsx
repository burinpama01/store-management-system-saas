import { redirect } from "next/navigation";
import { getResolvedCurrentPermissions } from "@/modules/auth/guards";
import { listConnectOrders } from "@/modules/connect/repository";
import { listKitchenStations } from "@/modules/qr-ordering/kitchen-stations";
import { getReceiptSettings } from "@/modules/settings/repository";
import { listPrinters } from "@/modules/stores/repository";
import type { InboundOrderItem, InboundOrderPayload } from "@/modules/connect/types";
import { DeliveryBoard, type DeliveryOrderVM } from "./DeliveryBoard";

export const dynamic = "force-dynamic";

function parsePayload(raw: unknown): InboundOrderPayload | null {
  if (!raw || typeof raw !== "object") return null;
  return raw as InboundOrderPayload;
}

function itemView(it: InboundOrderItem) {
  return {
    name: it.name,
    qty: it.qty,
    price: it.price,
    note: it.note ?? null,
    options: (it.options ?? []).map((o) => ({ name: o.name, price: o.price ?? 0 })),
  };
}

export default async function DeliveryPage() {
  const { ctx, resolved } = await getResolvedCurrentPermissions();
  if (!resolved.can("orders.manage_qr")) redirect("/dashboard");
  const canManage = resolved.can("orders.manage_qr");

  const [orders, stations, receipt, printersRes] = await Promise.all([
    listConnectOrders(ctx.organizationId, 80),
    listKitchenStations(ctx.storeId),
    getReceiptSettings(ctx.storeId, ctx.organizationId),
    listPrinters(ctx.storeId, ctx.organizationId),
  ]);
  const printers = printersRes.data ?? [];

  const stationPrinters = (stations.data ?? [])
    .filter((s) => s.printerId)
    .map((s) => ({ id: s.id, name: s.name, printerId: s.printerId as string }));
  const paperWidth = receipt.data?.paperWidth === "58mm" ? "58mm" : "80mm";

  const vms: DeliveryOrderVM[] = orders.map((o) => {
    const p = parsePayload(o.rawPayload);
    const items = (p?.items ?? []).map(itemView);
    const itemsSubtotal = items.reduce((s, i) => s + i.qty * i.price, 0);
    const shopAmount =
      o.total ?? (typeof p?.merchant_total === "number" ? p.merchant_total : itemsSubtotal);
    const customerName =
      p?.customer && typeof p.customer === "object"
        ? ((p.customer as Record<string, unknown>).name as string | undefined) ?? null
        : null;
    return {
      id: o.id,
      internalOrderId: o.internalOrderId,
      billNumber: o.orderNumber ?? `JDC-${o.externalOrderId.slice(0, 8).toUpperCase()}`,
      fulfillmentStatus: o.fulfillmentStatus,
      lastStatusOrigin: o.lastStatusOrigin,
      shopAmount,
      customerName,
      receivedAt: o.receivedAt,
      items,
    };
  });

  return (
    <div className="page-shell">
      <DeliveryBoard
        orders={vms}
        canManage={canManage}
        storeId={ctx.storeId}
        storeName={ctx.storeName}
        stationPrinters={stationPrinters}
        paperWidth={paperWidth}
        printers={printers}
        autoPrintOnArrival={Boolean(receipt.data?.autoPrintStationTickets)}
      />
    </div>
  );
}
