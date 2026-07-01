"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { getSupabaseBrowserClient } from "@/server/integrations/supabase/client";
import { managedRealtimeSubscription } from "@/shared/realtime/realtime-client";
import {
  PREP_STATUS_LABEL,
  SERVICE_REQUEST_LABEL,
  type QrOrderView,
  type PrepStatus,
  type ServiceRequest,
} from "@/modules/qr-ordering/types";
import { updatePrepStatusAction, resolveServiceRequestAction, voidQrOrderItemAction } from "./actions";
import { Button } from "@/shared/components/ui";

interface Props {
  storeId: string;
  currency: string;
  initialActiveOrders: QrOrderView[];
  initialHistory: QrOrderView[];
  initialRequests: ServiceRequest[];
  assignedKitchenStationIds: string[];
  canSeeAllKitchenStations: boolean;
}

function fmt(amount: number, currency: string): string {
  return new Intl.NumberFormat("th-TH", {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  }).format(amount);
}

function timeAgo(iso: string): string {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "เมื่อสักครู่";
  if (mins < 60) return `${mins} นาทีที่แล้ว`;
  const hrs = Math.floor(mins / 60);
  return `${hrs} ชม. ${mins % 60} นาทีที่แล้ว`;
}

const PREP_FLOW: Record<PrepStatus, { next: PrepStatus; label: string } | null> = {
  new: { next: "preparing", label: "เริ่มเตรียม" },
  preparing: { next: "served", label: "เสิร์ฟแล้ว" },
  served: { next: "done", label: "เสร็จสิ้น" },
  done: null,
};

const PREP_BADGE: Record<PrepStatus, string> = {
  new: "bg-orange-100 text-orange-700",
  preparing: "bg-blue-100 text-blue-700",
  served: "bg-green-100 text-green-700",
  done: "bg-gray-100 text-gray-500",
};

const UNASSIGNED_STATION = "__unassigned";

type QrOrderItem = QrOrderView["items"][number];

function itemMatchesStation(item: QrOrderItem, stationId: string) {
  if (stationId === "all") return true;
  return stationId === UNASSIGNED_STATION
    ? !item.kitchenStationId
    : item.kitchenStationId === stationId;
}

function orderMatchesStation(order: QrOrderView, stationId: string) {
  if (stationId === "all") return true;
  return order.items.some((item) =>
    itemMatchesStation(item, stationId),
  );
}

function itemsByStation(items: QrOrderItem[]) {
  const groups = new Map<string, { id: string; name: string; items: QrOrderItem[] }>();
  for (const item of items) {
    const id = item.kitchenStationId ?? UNASSIGNED_STATION;
    const group = groups.get(id) ?? {
      id,
      name: item.kitchenStationName ?? "Unassigned",
      items: [],
    };
    group.items.push(item);
    groups.set(id, group);
  }
  return [...groups.values()];
}

export function QrOrdersBoard({
  storeId,
  currency,
  initialActiveOrders,
  initialHistory,
  initialRequests,
  assignedKitchenStationIds,
  canSeeAllKitchenStations,
}: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [live, setLive] = useState(true);
  const [selectedStation, setSelectedStation] = useState("all");
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stationOptions = useMemo(() => {
    const options = new Map<string, string>();
    for (const order of [...initialActiveOrders, ...initialHistory]) {
      for (const item of order.items) {
        if (item.kitchenStationId) {
          options.set(item.kitchenStationId, item.kitchenStationName ?? "Kitchen station");
        } else {
          options.set(UNASSIGNED_STATION, "Unassigned");
        }
      }
    }
    return [...options.entries()].map(([id, name]) => ({ id, name }));
  }, [initialActiveOrders, initialHistory]);

  const filteredActiveOrders = useMemo(
    () => initialActiveOrders.filter((order) => orderMatchesStation(order, selectedStation)),
    [initialActiveOrders, selectedStation],
  );
  const filteredHistory = useMemo(
    () => initialHistory.filter((order) => orderMatchesStation(order, selectedStation)),
    [initialHistory, selectedStation],
  );
  const ordersByTable = useMemo(() => {
    const groups = new Map<string, { key: string; tableNumber: string; orders: QrOrderView[] }>();
    for (const order of filteredActiveOrders) {
      const key = order.tableId ?? order.tableNumber ?? order.id;
      const group = groups.get(key) ?? {
        key,
        tableNumber: order.tableNumber ?? "-",
        orders: [],
      };
      group.orders.push(order);
      groups.set(key, group);
    }
    return [...groups.values()];
  }, [filteredActiveOrders]);
  const hasAssignedStationScope =
    canSeeAllKitchenStations || assignedKitchenStationIds.length > 0;

  // Realtime: refresh data (debounced) and chime when new work arrives.
  useEffect(() => {
    const client = getSupabaseBrowserClient();
    const scheduleRefresh = () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      refreshTimer.current = setTimeout(() => router.refresh(), 400);
    };

    const unsubOrders = managedRealtimeSubscription<{ qr_order_source: boolean }>({
      client,
      table: "orders",
      filter: `store_id=eq.${storeId}`,
      onEvent: () => {
        scheduleRefresh();
      },
      onError: () => setLive(false),
    });
    const unsubRequests = managedRealtimeSubscription({
      client,
      table: "service_requests",
      filter: `store_id=eq.${storeId}`,
      onEvent: () => {
        scheduleRefresh();
      },
      onError: () => setLive(false),
    });

    return () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      unsubOrders();
      unsubRequests();
    };
  }, [storeId, router]);

  // Fallback poll every 20s in case realtime is unavailable.
  useEffect(() => {
    const id = setInterval(() => router.refresh(), 20000);
    return () => clearInterval(id);
  }, [router]);

  function advance(order: QrOrderView) {
    const flow = PREP_FLOW[order.prepStatus];
    if (!flow) return;
    setError(null);
    startTransition(async () => {
      const res = await updatePrepStatusAction(order.id, flow.next);
      if (res.error) setError(res.error);
      else router.refresh();
    });
  }

  function resolveRequest(id: string) {
    setError(null);
    startTransition(async () => {
      const res = await resolveServiceRequestAction(id);
      if (res.error) setError(res.error);
      else router.refresh();
    });
  }

  function voidItem(order: QrOrderView, itemId: string, name: string) {
    if (!window.confirm(`ปฏิเสธ "${name}" (ของหมด)? ระบบจะคืนสต็อกและหักออกจากยอด`)) return;
    setError(null);
    startTransition(async () => {
      const res = await voidQrOrderItemAction(order.id, itemId, "ของหมด");
      if (res.error) setError(res.error);
      else router.refresh();
    });
  }

  function renderOrderCard(order: QrOrderView) {
    const flow = PREP_FLOW[order.prepStatus];
    const visibleItems = order.items.filter((item) =>
      itemMatchesStation(item, selectedStation),
    );
    const stationGroups = itemsByStation(visibleItems);
    const canAdvanceOrder = selectedStation === "all" && canSeeAllKitchenStations;
    const canVoidItems =
      canSeeAllKitchenStations &&
      order.status === "open" &&
      (order.prepStatus === "new" || order.prepStatus === "preparing");

    const renderItemLine = (it: QrOrderView["items"][number], showStation: boolean) => (
      <li key={it.id} className="flex justify-between gap-2">
        <span className={it.voided ? "text-gray-300 line-through" : "text-gray-700"}>
          <span className="font-semibold">{it.quantity}×</span> {it.productName}
          {it.variantName ? ` (${it.variantName})` : ""}
          {showStation && (
            <span className="block text-xs text-sky-700 no-underline">
              {it.kitchenStationName ?? "Unassigned"}
            </span>
          )}
          {it.modifiers.length > 0 && (
            <span className="block text-xs text-gray-400">
              {it.modifiers.map((m) => m.option.name).join(", ")}
            </span>
          )}
          {it.note && <span className="block text-xs italic text-gray-400">“{it.note}”</span>}
          {it.voided && (
            <span className="ml-1 text-xs text-red-500 no-underline">({it.voidedReason ?? "ยกเลิก"})</span>
          )}
        </span>
        <span className="flex shrink-0 items-center gap-2">
          <span className="text-gray-500">{fmt(it.totalPrice, currency)}</span>
          {!it.voided && canVoidItems && (
            <button
              onClick={() => voidItem(order, it.id, it.productName)}
              className="rounded border border-red-200 px-1.5 py-0.5 text-xs text-red-600 hover:bg-red-50"
            >
              ของหมด
            </button>
          )}
        </span>
      </li>
    );

    return (
      <article key={order.id} className="flex flex-col rounded-lg border border-gray-200 bg-white p-4">
        <div className="flex items-start justify-between gap-2">
          <div>
            <p className="font-bold text-gray-900">โต๊ะ {order.tableNumber ?? "-"}</p>
            <p className="text-xs text-gray-400">
              #{order.orderNumber} · {timeAgo(order.createdAt)}
            </p>
          </div>
          <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${PREP_BADGE[order.prepStatus]}`}>
            {PREP_STATUS_LABEL[order.prepStatus]}
          </span>
        </div>

        <div className="mt-3 space-y-3 text-sm">
          {canSeeAllKitchenStations && selectedStation === "all"
            ? stationGroups.map((station) => (
                <div key={station.id} className="space-y-1.5 rounded-lg bg-gray-50 p-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-sky-700">
                    {station.name}
                  </p>
                  <ul className="space-y-1.5">
                    {station.items.map((it) => renderItemLine(it, false))}
                  </ul>
                </div>
              ))
            : (
                <ul className="space-y-1.5">
                  {visibleItems.map((it) => renderItemLine(it, true))}
                </ul>
              )}
        </div>

        <div className="mt-3 flex items-center justify-between border-t border-gray-100 pt-3">
          <span className="text-sm font-bold text-gray-900">{fmt(order.total, currency)}</span>
          <div className="flex flex-wrap items-center justify-end gap-2">
            {flow && canAdvanceOrder ? (
              <Button
                variant="primary"
                onClick={() => advance(order)}
                loading={isPending}
                className="min-h-11 px-3 text-xs"
              >
                {flow.label}
              </Button>
            ) : flow && canSeeAllKitchenStations ? (
              <span className="max-w-44 text-right text-xs text-gray-500">
                เลือก All stations เพื่อเปลี่ยนสถานะทั้งออร์เดอร์
              </span>
            ) : null}
            <Link href="/pos" className="btn-secondary min-h-11 px-3 text-xs">
              ชำระเงิน
            </Link>
          </div>
        </div>
      </article>
    );
  }

  return (
    <div className="page-shell">
      <div className="page-header">
        <div>
          <h1 className="text-xl font-bold text-[var(--ink)]">QR Order</h1>
          <p className="text-sm text-[var(--muted)]">จัดการออร์เดอร์จากลูกค้าและคำขอบริการแบบเรียลไทม์</p>
        </div>
        <span
          className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium ${
            live ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-500"
          }`}
        >
          <span className={`h-2 w-2 rounded-full ${live ? "bg-green-500 animate-pulse" : "bg-gray-400"}`} />
          {live ? "เรียลไทม์" : "ออฟไลน์"}
        </span>
      </div>

      {error && <p className="rounded-lg bg-red-50 px-4 py-2 text-sm text-red-600">{error}</p>}

      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-gray-200 bg-white p-3">
        <label className="min-w-64 space-y-1">
          <span className="text-xs font-semibold uppercase tracking-wide text-gray-500">
            Kitchen station
          </span>
          <select
            className="form-input"
            value={selectedStation}
            onChange={(event) => setSelectedStation(event.target.value)}
          >
            <option value="all">
              {canSeeAllKitchenStations ? "All stations" : "ครัวที่ผูกกับฉัน"}
            </option>
            {stationOptions.map((station) => (
              <option key={station.id} value={station.id}>
                {station.name}
              </option>
            ))}
          </select>
        </label>
        <p className="pb-2 text-xs text-gray-500">
          Showing {filteredActiveOrders.length} active orders
        </p>
      </div>

      {/* Service requests */}
      {initialRequests.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-bold text-[var(--ink)]">คำขอบริการ ({initialRequests.length})</h2>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {initialRequests.map((req) => (
              <div
                key={req.id}
                className={`flex items-center justify-between gap-3 rounded-lg border p-3 ${
                  req.type === "request_bill"
                    ? "border-purple-200 bg-purple-50"
                    : "border-amber-200 bg-amber-50"
                }`}
              >
                <div className="min-w-0">
                  <p className="font-bold text-gray-900">
                    โต๊ะ {req.tableNumber} · {req.note ? req.note : SERVICE_REQUEST_LABEL[req.type]}
                  </p>
                  <p className="text-xs text-gray-500">
                    {SERVICE_REQUEST_LABEL[req.type]} · {timeAgo(req.createdAt)}
                  </p>
                </div>
                <Button
                  variant="secondary"
                  onClick={() => resolveRequest(req.id)}
                  loading={isPending}
                  className="min-h-11 shrink-0 px-3 text-xs"
                >
                  รับเรื่อง
                </Button>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Active orders */}
      <section className="space-y-2">
        <h2 className="text-sm font-bold text-[var(--ink)]">ออร์เดอร์ที่กำลังดำเนินการ ({filteredActiveOrders.length})</h2>
        {filteredActiveOrders.length === 0 ? (
          <p className="rounded-lg border border-dashed border-gray-300 bg-white p-8 text-center text-sm text-gray-400">
            {hasAssignedStationScope ? "ครัวนี้ยังไม่มีงาน" : "บัญชีนี้ยังไม่ได้ผูกกับครัว"}
          </p>
        ) : (
          canSeeAllKitchenStations ? (
            <div className="space-y-4">
              {ordersByTable.map((group) => (
                <section key={group.key} className="rounded-lg border border-gray-200 bg-white/60 p-3">
                  <div className="mb-3 flex items-center justify-between gap-2">
                    <h3 className="font-bold text-gray-900">โต๊ะ {group.tableNumber}</h3>
                    <span className="text-xs text-gray-500">{group.orders.length} order(s)</span>
                  </div>
                  <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                    {group.orders.map((order) => renderOrderCard(order))}
                  </div>
                </section>
              ))}
            </div>
          ) : (
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {filteredActiveOrders.map((order) => renderOrderCard(order))}
            </div>
          )
        )}
      </section>

      {/* History */}
      <section className="space-y-2">
        <button
          onClick={() => setShowHistory((v) => !v)}
          className="text-sm font-bold text-[var(--ink)] hover:underline"
        >
          {showHistory ? "▼" : "▶"} ประวัติออร์เดอร์ QR ({filteredHistory.length})
        </button>
        {showHistory && (
          <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
            {filteredHistory.length === 0 ? (
              <p className="p-6 text-center text-sm text-gray-400">ยังไม่มีประวัติ</p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100 text-left text-xs text-gray-500">
                    <th className="px-4 py-2 font-medium">ออร์เดอร์</th>
                    <th className="px-4 py-2 font-medium">โต๊ะ</th>
                    <th className="px-4 py-2 font-medium">สถานะ</th>
                    <th className="px-4 py-2 font-medium text-right">ยอด</th>
                    <th className="px-4 py-2 font-medium">เวลา</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredHistory.map((o) => (
                    <tr key={o.id} className="border-b border-gray-50 last:border-0">
                      <td className="px-4 py-2 text-gray-700">#{o.orderNumber}</td>
                      <td className="px-4 py-2 text-gray-700">{o.tableNumber ?? "-"}</td>
                      <td className="px-4 py-2">
                        <span
                          className={`rounded-full px-2 py-0.5 text-xs ${
                            o.status === "paid" ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-500"
                          }`}
                        >
                          {o.status === "paid" ? "ชำระแล้ว" : o.status === "voided" ? "ยกเลิก" : o.status}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-right text-gray-700">{fmt(o.total, currency)}</td>
                      <td className="px-4 py-2 text-gray-500">
                        {new Date(o.paidAt ?? o.createdAt).toLocaleString("th-TH", {
                          day: "2-digit",
                          month: "2-digit",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
